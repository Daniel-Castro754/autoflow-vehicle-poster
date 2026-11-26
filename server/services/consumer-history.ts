import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { sanitizeConsumerDiagnostic } from './execution-diagnostics.ts'

export const consumerHistoryRetentionDays=30
export const consumerHistoryProfileLimit=10000
const retentionMs=consumerHistoryRetentionDays*86400000
const allowedFutureMs=300000
const heartbeatGapMs=300000

// Never use this history for eligibility, lease renewal or publication decisions.
export function persistConsumerHistory(db:DatabaseSync,org:number,accountId:number,autoRun:unknown,latest:unknown,batch:unknown,now=Date.now()){
  db.exec('BEGIN IMMEDIATE')
  try{
    const prior=db.prepare('SELECT received_at receivedAt,auto_run autoRun FROM consumer_presence_checkpoint WHERE organization_id=? AND account_id=?').get(org,accountId) as {receivedAt:number;autoRun:number|null}|undefined
    const state=typeof autoRun==='boolean'?Number(autoRun):null
    const insert=db.prepare(`INSERT OR IGNORE INTO consumer_history
      (organization_id,account_id,event_key,code,observed_at,received_at,job_id,queue_size,http_status,retry_after_seconds)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
    const add=(code:string,at:number,jobId:number|null=null,queueSize:number|null=null,httpStatus:number|null=null,retryAfterSeconds:number|null=null)=>{
      const key=createHash('sha256').update(JSON.stringify([code,at,jobId,queueSize,httpStatus,retryAfterSeconds])).digest('hex')
      insert.run(org,accountId,key,code,at,now,jobId,queueSize,httpStatus,retryAfterSeconds)
    }
    if(!prior)add('presence_first_observed',now)
    else if(now-prior.receivedAt>heartbeatGapMs)add('presence_restored',now)
    if(!prior||prior.autoRun!==state)add(state===null?'consumer_state_unknown':state===1?'consumer_state_enabled':'consumer_state_paused',now)
    db.prepare(`INSERT INTO consumer_presence_checkpoint(organization_id,account_id,received_at,auto_run)
      VALUES(?,?,?,?) ON CONFLICT(organization_id,account_id) DO UPDATE SET received_at=excluded.received_at,auto_run=excluded.auto_run
      WHERE excluded.received_at>=consumer_presence_checkpoint.received_at`).run(org,accountId,now,state)
    const incoming=[...(Array.isArray(batch)?batch.slice(-200):[]),latest]
    const ownedJob=db.prepare('SELECT 1 FROM publication_jobs WHERE organization_id=? AND id=?')
    const nullableNumber=(v:unknown)=>typeof v==='number'?v:null
    for(const value of incoming){
      const d=sanitizeConsumerDiagnostic(value)
      if(!d)continue
      // Older clients lacking a timestamp get a server receipt sample, at most once per five-minute bucket.
      const at=typeof d.at==='number'?d.at:Math.floor(now/300000)*300000
      if(at<now-retentionMs||at>now+allowedFutureMs)continue
      const requestedJob=nullableNumber(d.jobId)
      const jobId=requestedJob&&ownedJob.get(org,requestedJob)?requestedJob:null
      add(String(d.code),at,jobId,nullableNumber(d.queueSize),nullableNumber(d.httpStatus),nullableNumber(d.retryAfterSeconds))
    }
    db.prepare(`DELETE FROM consumer_history WHERE organization_id=? AND account_id=? AND id <
      COALESCE((SELECT id FROM consumer_history WHERE organization_id=? AND account_id=? ORDER BY id DESC LIMIT 1 OFFSET ?),0)`).run(org,accountId,org,accountId,consumerHistoryProfileLimit-1)
    db.exec('COMMIT')
  }catch(error){db.exec('ROLLBACK');throw error}
}

// Bounded housekeeping, never runs from a read-only dashboard request.
export function pruneConsumerHistory(db:DatabaseSync,now=Date.now()){
  return Number(db.prepare('DELETE FROM consumer_history WHERE id IN (SELECT id FROM consumer_history WHERE observed_at<? ORDER BY observed_at LIMIT 5000)').run(now-retentionMs).changes)
}
export function readConsumerHistory(db:DatabaseSync,org:number,filters:{hours:number;accountId:number;vehicleId:number;consumerBeforeId:number},now=Date.now()){
  const since=Math.max(now-retentionMs,now-filters.hours*3600000)
  const where=`h.organization_id=? AND h.observed_at>=? AND (?=0 OR h.account_id=?)
    AND (?=0 OR j.vehicle_id=?)`
  const joins=`FROM consumer_history h JOIN social_accounts a ON a.id=h.account_id AND a.organization_id=h.organization_id
    LEFT JOIN publication_jobs j ON j.id=h.job_id AND j.organization_id=h.organization_id`
  const args=[org,since,filters.accountId,filters.accountId,filters.vehicleId,filters.vehicleId]
  const rows=db.prepare(`SELECT h.id,h.account_id accountId,a.label accountLabel,h.code,h.observed_at observedAt,
    h.received_at receivedAt,h.job_id jobId,h.queue_size queueSize,h.http_status httpStatus,h.retry_after_seconds retryAfterSeconds
    ${joins} WHERE ${where} AND (?=0 OR h.id<?) ORDER BY h.id DESC LIMIT 101`).all(...args,filters.consumerBeforeId,filters.consumerBeforeId) as Array<{id:number;[key:string]:unknown}>
  const counts=db.prepare(`SELECT h.account_id accountId,a.label accountLabel,h.code,COUNT(*) count
    ${joins} WHERE ${where} GROUP BY h.account_id,a.label,h.code ORDER BY h.account_id,h.code`).all(...args)
  return {retentionDays:consumerHistoryRetentionDays,profileLimit:consumerHistoryProfileLimit,rows:rows.slice(0,100),counts,
    nextBeforeId:rows.length>100?rows[99].id:null}
}
