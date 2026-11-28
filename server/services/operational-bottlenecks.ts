import type { DatabaseSync } from 'node:sqlite'
import { autopilotDiagnostics } from './autopilot-diagnostics.ts'
import { openResultConflict } from './result-conflicts.ts'

type Unit = 'jobs' | 'vehicles' | 'profiles' | 'configuration'
type Severity = 'review' | 'attention' | 'waiting'
type Finding = { code: string; severity: Severity; unit: Unit; count: number; exampleIds: number[] }

// Deterministic, read-only snapshot. Counts use distinct identifiers within each
// finding; different findings may overlap. Do not infer external publication.
export function operationalBottlenecks(db: DatabaseSync, org: number, limit = 10) {
  const diagnostic = autopilotDiagnostics(db, org, true)
  const findings: Finding[] = []
  const add = (code: string, severity: Severity, unit: Unit, ids: number[]) => {
    const distinct = [...new Set(ids)].sort((a,b)=>a-b)
    if (distinct.length) findings.push({ code, severity, unit, count: distinct.length, exampleIds: distinct.slice(0,limit) })
  }
  const jobs = diagnostic.vehicles.flatMap(v=>v.blockingJobs)
  const conflictJobs = new Set(jobs.filter(j=>openResultConflict(db,org,j.id)).map(j=>j.id))
  add('open_result_conflict','review','jobs',[...conflictJobs])
  add('publication_uncertain','review','jobs',jobs.filter(j=>!conflictJobs.has(j.id) && (j.reviewKind==='publication_uncertain'||j.reviewKind==='review_unknown')).map(j=>j.id))
  add('manual_review','review','jobs',jobs.filter(j=>!conflictJobs.has(j.id) && (j.reviewKind==='manual_review'||j.reviewKind==='fill_incomplete')).map(j=>j.id))
  add('execution_error','attention','jobs',jobs.filter(j=>j.status==='error'&&!conflictJobs.has(j.id)).map(j=>j.id))
  const ready=diagnostic.vehicles.filter(v=>v.status==='Pronto'&&!v.previewReasons.some(r=>r.code==='sold'))
  const reasons=(v:typeof ready[number])=>[...v.previewReasons,...v.executionReasons].map(r=>r.code)
  for (const code of ['missing_photos','incomplete_vehicle','shared_photo','no_eligible_profile']) {
    add(code,'attention','vehicles',ready.filter(v=>reasons(v).includes(code)).map(v=>v.id))
  }
  for (const code of ['profile_disconnected','profile_stale','consumer_unknown','consumer_operational_block']) {
    add(code,'attention','profiles',diagnostic.profiles.filter(p=>p.reasons.some(r=>r.code===code)).map(p=>p.id))
  }
  for (const code of ['profile_paused','consumer_paused','queue_daily_limit']) {
    add(code,'waiting','profiles',diagnostic.profiles.filter(p=>p.reasons.some(r=>r.code===code)).map(p=>p.id))
  }
  add('existing_pending_or_active','waiting','vehicles',ready.filter(v=>v.blockingJobs.some(j=>j.status==='pending'||j.status==='filling')).map(v=>v.id))
  add('existing_confirmed_work','waiting','vehicles',ready.filter(v=>v.blockingJobs.some(j=>j.status==='completed')).map(v=>v.id))
  add('existing_listing_guard','waiting','vehicles',ready.filter(v=>reasons(v).some(code=>code==='active_external_listing'||code==='same_vehicle')).map(v=>v.id))
  if (!diagnostic.recurringEnabled) findings.push({code:'recurrence_disabled',severity:'waiting',unit:'configuration',count:1,exampleIds:[]})
  const priority: Record<Severity,number> = {review:0,attention:1,waiting:2}
  findings.sort((a,b)=>priority[a.severity]-priority[b.severity]||a.unit.localeCompare(b.unit)||b.count-a.count||a.code.localeCompare(b.code))
  return {
    recurringEnabled:diagnostic.recurringEnabled,
    eligibleProfiles:diagnostic.profiles.filter(p=>p.canSchedule).length,
    readyVehicles:ready.length,
    passingInitialChecks:diagnostic.passingInitialChecks,
    findings,
    note:'Contagens locais por tipo de entidade; motivos podem coexistir. Espera, pausa e limites não são falhas. Diagnóstico inicial, não confirmação externa nem autorização para executar ações.',
  }
}
