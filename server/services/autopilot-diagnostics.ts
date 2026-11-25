import type { DatabaseSync } from 'node:sqlite'
import { consumerRoutingEligible, findBestAccountForVehicle } from '../modules/accounts.ts'
import { publicationDuplicateRisk, publicationReadinessIssues } from './publication-policy.ts'
import { profileCapacity } from './profile-capacity.ts'
import { publicationReviewKind } from './publication-evidence.ts'
import { consumerState } from './execution-diagnostics.ts'

type Reason = { code: string; message: string }
type Job = { id: number; vehicleId: number; status: string; accountLabel: string; visible: number; paused: number; publishAttemptAt?: string; fillReport?: string }
type Vehicle = Parameters<typeof publicationReadinessIssues>[0] & {
  id: number; status: string; soldAt: string | null; imageCount: number
}

// Diagnostic only; does not change scheduling or authorization.
export function autopilotDiagnostics(db: DatabaseSync, org: number, automatic = false) {
  const settings = db.prepare('SELECT autopilot_enabled enabled FROM organization_settings WHERE organization_id=?').get(org) as { enabled: number } | undefined
  const state = db.prepare('SELECT next_run_at nextRunAt,last_status lastStatus,last_jobs_created lastJobsCreated FROM autopilot_state WHERE organization_id=?').get(org) as { nextRunAt: string | null; lastStatus: string; lastJobsCreated: number } | undefined
  const accounts = db.prepare(
    `SELECT id,label,status,COALESCE(automation_paused,0) paused,
    CASE WHEN last_seen_at IS NOT NULL AND datetime(last_seen_at)>=datetime('now','-5 minutes') THEN 1 ELSE 0 END recent
    FROM social_accounts WHERE organization_id=? ORDER BY id`,
  ).all(org) as Array<{ id: number; label: string; status: string; paused: number; recent: number }>
  const routingMode = automatic ? 'autopilot_recurring' : 'autopilot_manual'
  const profiles = accounts.map((a) => {
    const c = profileCapacity(db, org, a.id)
    const reasons: Reason[] = []
    if (a.status !== 'connected') reasons.push({ code: 'profile_disconnected', message: 'Perfil desconectado.' })
    if (a.paused) reasons.push({ code: 'profile_paused', message: 'Automação pausada no servidor.' })
    if (!a.recent) reasons.push({ code: 'profile_stale', message: 'Sem comunicação nos últimos cinco minutos.' })
    const consumer = consumerState(db, org, a.id)
    if (!consumerRoutingEligible(consumer.state, routingMode)) reasons.push({
      code: consumer.state === 'paused' ? 'consumer_paused' : 'consumer_unknown',
      message: consumer.state === 'paused' ? 'Consumo pausado na extensão.' : 'Aguardando confirmação recente de consumo ativo.',
    })
    if (c.queuedToday >= c.dailyLimit) reasons.push({ code: 'queue_daily_limit', message: 'Limite diário de agendamentos atingido.' })
    return { id: a.id, label: a.label, status: a.status, queuedToday: c.queuedToday, dailyLimit: c.dailyLimit,
      used: c.used, nextAllowedAt: c.nextAllowedAt, consumer, canSchedule: reasons.length === 0, reasons }
  })
  const stock = db.prepare(
    `SELECT v.id,v.year,v.make,v.model,v.price,v.km,v.status,v.description,v.sold_at soldAt,
    v.exterior_color exteriorColor,v.interior_color interiorColor,v.transmission,v.fuel_type fuelType,
    v.vehicle_condition condition,v.vehicle_type vehicleType,v.body_type bodyType,v.location,
    (SELECT COUNT(*) FROM vehicle_images i WHERE i.organization_id=v.organization_id AND i.vehicle_id=v.id) imageCount
    FROM vehicles v WHERE v.organization_id=? ORDER BY v.id`,
  ).all(org) as Vehicle[]
  const jobs = db.prepare(
    `SELECT j.id,j.vehicle_id vehicleId,j.status,j.extension_visible visible,j.paused,j.publish_attempt_at publishAttemptAt,j.fill_report fillReport,
    COALESCE(a.label,'Perfil não definido') accountLabel
    FROM publication_jobs j LEFT JOIN social_accounts a ON a.id=j.social_account_id AND a.organization_id=j.organization_id
    WHERE j.organization_id=? AND j.status IN ('pending','filling','error','awaiting_confirmation','completed') ORDER BY j.id`,
  ).all(org) as Job[]
  const byVehicle = new Map<number, Job[]>()
  for (const job of jobs) {
    const list = byVehicle.get(job.vehicleId) ?? []
    list.push(job)
    byVehicle.set(job.vehicleId, list)
  }
  const vehicles = stock.map((v) => {
    const blockingJobs = (byVehicle.get(v.id) ?? []).map(j => ({ id: j.id, vehicleId: j.vehicleId, status: j.status, accountLabel: j.accountLabel, visible: j.visible, paused: j.paused, reviewKind: publicationReviewKind(j) }))
    const previewReasons: Reason[] = []
    const executionReasons: Reason[] = []
    if (v.soldAt) previewReasons.push({ code: 'sold', message: 'Veículo vendido.' })
    if (v.status !== 'Pronto') previewReasons.push({ code: 'not_ready', message: 'Status diferente de Pronto: ' + v.status })
    if (!v.imageCount) previewReasons.push({ code: 'missing_photos', message: 'Sem fotos.' })
    if (blockingJobs.length) previewReasons.push({ code: 'existing_job', message: 'Já existe trabalho que impede novo agendamento, inclusive se oculto da extensão.' })
    if (!previewReasons.length) {
      const missing = publicationReadinessIssues(v, v.imageCount, !automatic)
      if (missing.length) executionReasons.push({ code: 'incomplete_vehicle', message: 'Cadastro: ' + missing.join(', ') })
      const duplicate = publicationDuplicateRisk(db, org, v.id)
      if (duplicate) executionReasons.push({ code: duplicate.type, message: duplicate.message })
      if (!findBestAccountForVehicle(db, org, v.id, routingMode)) executionReasons.push({ code: 'no_eligible_profile', message: 'Nenhum perfil atende às regras atuais de agendamento.' })
    }
    return { id: v.id, title: v.year + ' ' + v.make + ' ' + v.model, status: v.status, photoCount: v.imageCount,
      previewCandidate: !previewReasons.length, previewReasons, executionReasons, blockingJobs }
  })
  return { totalVehicles: vehicles.length, previewCandidateCount: vehicles.filter(v => v.previewCandidate).length,
    passingInitialChecks: vehicles.filter(v => v.previewCandidate && !v.executionReasons.length).length,
    vehicles, profiles, recurringEnabled: Boolean(settings?.enabled),
    nextRunAt: state?.nextRunAt ?? null, lastStatus: state?.lastStatus ?? null, lastJobsCreated: state?.lastJobsCreated ?? null }
}

export function summarizeAutopilotDiagnostics(d: ReturnType<typeof autopilotDiagnostics>) {
  const reasonCounts: Record<string, number> = {}
  for (const v of d.vehicles) for (const r of [...v.previewReasons, ...v.executionReasons])
    reasonCounts[r.code] = (reasonCounts[r.code] ?? 0) + 1
  return { totalVehicles: d.totalVehicles, previewCandidateCount: d.previewCandidateCount,
    passingInitialChecks: d.passingInitialChecks, reasonCounts,
    profiles: d.profiles.map(p => ({ id: p.id, canSchedule: p.canSchedule, queuedToday: p.queuedToday, dailyLimit: p.dailyLimit, consumer: p.consumer.state, reasons: p.reasons.map(r => r.code) })),
    vehicles: d.vehicles.slice(0, 100).map(v => ({ id: v.id, reasons: [...v.previewReasons, ...v.executionReasons].map(r => r.code), blockingJobIds: v.blockingJobs.map(j => j.id), reviewKinds: v.blockingJobs.map(j => ({ id: j.id, kind: j.reviewKind })) })),
    omittedVehicles: Math.max(0, d.totalVehicles - 100) }
}
