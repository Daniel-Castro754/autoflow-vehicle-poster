import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'

export function resultFingerprint(lease: string, report: Record<string, unknown>) {
  return createHash('sha256').update(JSON.stringify([lease,Number(report.tabId)||0,String(report.document||''),String(report.documentId||'')])).digest('hex')
}

const scope = `e.organization_id=? AND e.event_type='fill_result_conflict'
  AND json_valid(e.details) AND json_extract(e.details,'$.fingerprint') IS NOT NULL`
const unresolved = `NOT EXISTS (SELECT 1 FROM publication_job_events r
  WHERE r.organization_id=e.organization_id AND r.publication_job_id=e.publication_job_id
  AND r.event_type='fill_result_conflict_resolved' AND json_valid(r.details)
  AND json_extract(r.details,'$.conflictId')=e.id)`
export function openResultConflict(db: DatabaseSync, org: number, jobId: number) {
  return Boolean(db.prepare(`SELECT 1 FROM publication_job_events e WHERE ${scope}
    AND e.publication_job_id=? AND ${unresolved} LIMIT 1`).get(org,jobId))
}
export function recordResultConflict(db: DatabaseSync, org:number, jobId:number, accountId:number, status:string, code:string, lease:string, report:Record<string,unknown>) {
  const fingerprint=resultFingerprint(lease,report)
  const published=report.published===true, attempted=report.publishAttempted===true
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing=db.prepare(`SELECT e.id FROM publication_job_events e WHERE ${scope}
      AND e.publication_job_id=? AND json_extract(e.details,'$.accountId')=?
      AND json_extract(e.details,'$.fingerprint')=? AND json_extract(e.details,'$.conflictCode')=?
      AND json_extract(e.details,'$.reportedPublished')=? AND json_extract(e.details,'$.reportedPublishAttempted')=?
      AND ${unresolved} LIMIT 1`).get(org,jobId,accountId,fingerprint,code,Number(published),Number(attempted)) as {id:number}|undefined
    const id=existing?.id ?? Number(db.prepare(
      "INSERT INTO publication_job_events(organization_id,publication_job_id,event_type,details) VALUES (?,?,'fill_result_conflict',?)"
    ).run(org,jobId,JSON.stringify({fingerprint,conflictCode:code,accountId,jobStatus:status,reportedPublished:published,reportedPublishAttempted:attempted})).lastInsertRowid)
    db.exec('COMMIT')
    return id
  } catch(error){db.exec('ROLLBACK');throw error}
}

export function resultConflict(db:DatabaseSync,org:number,id:number) {
  return db.prepare(`SELECT e.id,e.publication_job_id jobId,j.status jobStatus,j.social_account_id currentAccountId,
    json_extract(e.details,'$.accountId') accountId,json_extract(e.details,'$.fingerprint') fingerprint,
    json_extract(e.details,'$.reportedPublished') reportedPublished,
    json_extract(e.details,'$.reportedPublishAttempted') reportedPublishAttempted,
    (SELECT json_extract(r.details,'$.outcome') FROM publication_job_events r
      WHERE r.organization_id=e.organization_id AND r.publication_job_id=e.publication_job_id
      AND r.event_type='fill_result_conflict_resolved' AND json_valid(r.details)
      AND json_extract(r.details,'$.conflictId')=e.id ORDER BY r.id DESC LIMIT 1) outcome
    FROM publication_job_events e JOIN publication_jobs j ON j.id=e.publication_job_id AND j.organization_id=e.organization_id
    WHERE ${scope} AND e.id=?`).get(org,id) as {id:number;jobId:number;jobStatus:string;currentAccountId:number|null;accountId:number;fingerprint:string;reportedPublished:number;reportedPublishAttempted:number;outcome:string|null}|undefined
}
export function listOpenResultConflicts(db:DatabaseSync,org:number) {
  const count=(db.prepare(`SELECT COUNT(*) n FROM publication_job_events e WHERE ${scope} AND ${unresolved}`).get(org) as {n:number}).n
  const rows=db.prepare(`SELECT e.id,e.publication_job_id jobId,e.created_at createdAt,j.status jobStatus,
    v.year || ' ' || v.make || ' ' || v.model title,
    json_extract(e.details,'$.accountId') accountId,
    json_extract(e.details,'$.conflictCode') conflictCode,
    json_extract(e.details,'$.reportedPublished') reportedPublished,
    json_extract(e.details,'$.reportedPublishAttempted') reportedPublishAttempted,
    a.label accountLabel
    FROM publication_job_events e JOIN publication_jobs j ON j.id=e.publication_job_id AND j.organization_id=e.organization_id
    JOIN vehicles v ON v.id=j.vehicle_id AND v.organization_id=j.organization_id
    LEFT JOIN social_accounts a ON a.id=json_extract(e.details,'$.accountId') AND a.organization_id=e.organization_id
    WHERE ${scope} AND ${unresolved} ORDER BY e.id DESC LIMIT 100`).all(org)
  return {count,rows}
}
export function terminalConflictOutcome(status:string) {
  return status==='completed'?'published':status==='removed'?'removed':status==='canceled'?'not_published':null
}
