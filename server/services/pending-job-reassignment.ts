import type { DatabaseSync } from 'node:sqlite'
import { consumerState } from './execution-diagnostics.ts'
import { profileCapacity, parseSqliteTimestamp } from './profile-capacity.ts'
import { publicationDuplicateRisk, publicationReadinessIssues } from './publication-policy.ts'
import { calculateListingHash, findDuplicateListingHash, listingSnapshotForVehicle } from './duplicate-checker.ts'

type Candidate = {
  id: number; vehicleId: number; accountId: number; userId: number
  scheduledAt: string; variantSeed: number | null
}
type Target = { id: number; backlog: number }
export type PendingTransfer = {
  jobId: number; fromAccountId: number; toAccountId: number; scheduledAt: string
}

// Only untouched, explicitly recurring jobs that are at least 15 minutes overdue.
// A server pause, a last reported consumer pause, any execution or manual
// intervention, or any external listing evidence disqualifies the job.
// Same owner and tenant only. A job may move automatically at most once.
export function redistributeOfflinePendingJobs(
  db: DatabaseSync,
  org: number,
  ownsLease: () => boolean,
): PendingTransfer[] {
  const transfers: PendingTransfer[] = []
  db.exec('BEGIN IMMEDIATE')
  try {
    if (!ownsLease() || !db.prepare('SELECT 1 FROM organization_settings WHERE organization_id=? AND autopilot_enabled=1').get(org)) {
      db.exec('COMMIT')
      return transfers
    }
    const candidates = db.prepare(
      `SELECT j.id,j.vehicle_id vehicleId,j.social_account_id accountId,a.user_id userId,
        j.scheduled_at scheduledAt,j.variant_seed variantSeed
      FROM publication_jobs j
      JOIN social_accounts a ON a.id=j.social_account_id AND a.organization_id=j.organization_id
      JOIN users u ON u.id=a.user_id AND u.organization_id=a.organization_id AND u.active=1
      JOIN vehicles v ON v.id=j.vehicle_id AND v.organization_id=j.organization_id
      WHERE j.organization_id=? AND j.status='pending' AND j.paused=0 AND j.extension_visible=1
        AND j.attempt_count=0 AND j.retry_count=0 AND j.started_at IS NULL AND j.filled_at IS NULL
        AND j.removed_at IS NULL AND j.publish_attempt_at IS NULL
        AND j.lease_token IS NULL AND j.last_lease_token IS NULL AND j.lease_owner IS NULL AND j.lease_expires_at IS NULL
        AND j.execution_tab_id IS NULL AND COALESCE(j.execution_document,'')='' AND COALESCE(j.execution_document_id,'')=''
        AND COALESCE(j.fill_report,'')='' AND COALESCE(j.result_url,'')='' AND COALESCE(j.error_code,'')=''
        AND datetime(j.scheduled_at)<=datetime('now','-15 minutes')
        AND a.automation_paused=0 AND a.last_consumer_auto_run=1
        AND (a.next_publication_allowed_at IS NULL OR datetime(a.next_publication_allowed_at)<=CURRENT_TIMESTAMP)
        AND datetime(a.last_seen_at)<=datetime('now','-15 minutes')
        AND v.status='Pronto' AND v.sold_at IS NULL
        AND (SELECT COUNT(*) FROM publication_job_events e
          WHERE e.organization_id=j.organization_id AND e.publication_job_id=j.id)=1
        AND EXISTS (SELECT 1 FROM publication_job_events e
          WHERE e.organization_id=j.organization_id AND e.publication_job_id=j.id
            AND e.event_type='autopilot_scheduled' AND json_valid(e.details)
            AND json_extract(e.details,'$.trigger')='recurring')
        AND NOT EXISTS (SELECT 1 FROM publication_listing_ledger l
          WHERE l.organization_id=j.organization_id AND l.publication_job_id=j.id)
      ORDER BY datetime(j.scheduled_at),j.id LIMIT 10`,
    ).all(org) as Candidate[]
    for (const job of candidates) {
      if (consumerState(db, org, job.accountId).state !== 'unknown') continue
      // Offline reassignment is not a way around a limit or safety cooldown.
      const sourceCapacity = profileCapacity(db, org, job.accountId)
      if (sourceCapacity.blockedByDailyLimit || sourceCapacity.retryAfterSeconds > 0) continue
      const vehicle = db.prepare(
        `SELECT v.year,v.make,v.model,v.price,v.km,v.location,v.description,v.vehicle_type vehicleType,
        v.transmission,v.fuel_type fuelType,v.body_type bodyType,v.exterior_color exteriorColor,
        v.interior_color interiorColor,v.vehicle_condition condition,
        (SELECT COUNT(*) FROM vehicle_images i WHERE i.organization_id=v.organization_id AND i.vehicle_id=v.id) imageCount
        FROM vehicles v WHERE v.organization_id=? AND v.id=?`,
      ).get(org,job.vehicleId) as (Parameters<typeof publicationReadinessIssues>[0] & { imageCount: number }) | undefined
      if (!vehicle || publicationReadinessIssues(vehicle,vehicle.imageCount).length ||
          publicationDuplicateRisk(db,org,job.vehicleId,job.id)) continue
      const reservation = db.prepare(
        "SELECT listing_hash hash FROM published_ads WHERE organization_id=? AND publication_job_id=? AND vehicle_id=? AND status='queued'",
      ).get(org,job.id,job.vehicleId) as { hash: string } | undefined
      const snapshot = listingSnapshotForVehicle(db,org,job.vehicleId,job.variantSeed ?? undefined)
      if (!reservation || !snapshot || calculateListingHash(snapshot)!==reservation.hash ||
          findDuplicateListingHash(db,org,reservation.hash,job.id)) continue
      const targets = db.prepare(
        `SELECT a.id,(SELECT COUNT(*) FROM publication_jobs j WHERE j.organization_id=a.organization_id
        AND j.social_account_id=a.id AND j.status IN ('pending','filling','error','awaiting_confirmation')) backlog
        FROM social_accounts a WHERE a.organization_id=? AND a.user_id=? AND a.id!=?
        AND a.status='connected' AND a.automation_paused=0
        AND datetime(a.last_seen_at)>=datetime('now','-5 minutes')
        AND NOT EXISTS (SELECT 1 FROM publication_jobs j WHERE j.organization_id=a.organization_id
        AND j.social_account_id=a.id AND j.status IN ('filling','error','awaiting_confirmation')) ORDER BY backlog,a.id`,
      ).all(org,job.userId,job.accountId) as Target[]
      for (const target of targets) {
        if (consumerState(db,org,target.id).state!=='enabled') continue
        const cap = profileCapacity(db,org,target.id)
        // Count all outstanding jobs in addition to current-day reservations,
        // including work created on earlier dates. Never transfer to a full profile.
        if (cap.blockedByDailyLimit || Math.max(cap.queuedToday,cap.used)+1>cap.dailyLimit ||
            cap.used+target.backlog+1>cap.dailyLimit) continue
        const existing = db.prepare(
          "SELECT scheduled_at scheduledAt FROM publication_jobs WHERE organization_id=? AND social_account_id=? AND status='pending'",
        ).all(org,target.id) as Array<{ scheduledAt: string | null }>
        // Do not jump ahead of existing unscheduled/overdue work or change its order.
        const now = Date.now()
        const times = existing.map(row=>parseSqliteTimestamp(row.scheduledAt))
        if (times.some(time=>time===null || time<=now)) continue
        const spacing = Math.max(1,cap.intervalMinutes)*60000
        const scheduledAt = new Date(Math.max(now+60000,parseSqliteTimestamp(cap.nextAllowedAt) || 0,
          ...times.map(time=>time!+spacing))).toISOString()
        // Avoid carrying transfers to future business dates; leave a deferred job
        // on its original account if no suitable capacity exists today.
        const day = db.prepare('SELECT autoflow_day(?) targetDay,autoflow_day(CURRENT_TIMESTAMP) today').get(scheduledAt) as { targetDay: string; today: string }
        if (day.targetDay!==day.today) continue
        const priority = db.prepare(
          "SELECT COALESCE(MAX(queue_priority),0)+1 value FROM publication_jobs WHERE organization_id=? AND social_account_id=? AND status IN ('pending','filling','error','awaiting_confirmation')",
        ).get(org,target.id) as { value: number }
        if (!ownsLease()) break
        const result = db.prepare(
          `UPDATE publication_jobs SET social_account_id=?,scheduled_at=?,queue_priority=?,updated_at=CURRENT_TIMESTAMP
          WHERE organization_id=? AND id=? AND social_account_id=? AND status='pending'
          AND paused=0 AND extension_visible=1 AND attempt_count=0 AND retry_count=0
          AND lease_token IS NULL AND last_lease_token IS NULL AND publish_attempt_at IS NULL`,
        ).run(target.id,scheduledAt,priority.value,org,job.id,job.accountId)
        if (result.changes!==1) break
        db.prepare(
          `INSERT INTO publication_job_events (organization_id,publication_job_id,event_type,from_account_id,to_account_id,details)
          VALUES (?,?,'reassigned',?,?,?)`,
        ).run(org,job.id,job.accountId,target.id,JSON.stringify({
          automatic: true,reason:'source_offline_overdue',previousScheduledAt:job.scheduledAt,scheduledAt,queuePriority:priority.value,
        }))
        transfers.push({jobId:job.id,fromAccountId:job.accountId,toAccountId:target.id,scheduledAt})
        break
      }
    }
    db.exec('COMMIT')
    return transfers
  } catch(error) {
    db.exec('ROLLBACK')
    throw error
  }
}
