import type { DatabaseSync } from 'node:sqlite'

type IncidentKind =
  | 'publication_uncertain'
  | 'execution_error'
  | 'selector_drift'
  | 'duplicate_risk'
  | 'slow_execution'

const incidentTypes: Record<
  string,
  { kind: IncidentKind; severity: 'warning' | 'critical'; summary: string }
> = {
  publish_result_unknown: {
    kind: 'publication_uncertain',
    severity: 'critical',
    summary: 'Resultado da publicação incerto. Confira Seus classificados antes de repetir.',
  },
  stalled_publish_ambiguous: {
    kind: 'publication_uncertain',
    severity: 'critical',
    summary: 'Execução interrompida após possível publicação. Confirmação humana obrigatória.',
  },
  stalled_exhausted: {
    kind: 'execution_error',
    severity: 'critical',
    summary: 'Limite de recuperação de travamento esgotado. Revisão necessária.',
  },
  selector_circuit_breaker_opened: {
    kind: 'selector_drift',
    severity: 'critical',
    summary: 'Alteração no formulário do Facebook bloqueou a automação deste perfil.',
  },
  duplicate_blocked: {
    kind: 'duplicate_risk',
    severity: 'warning',
    summary: 'Bloqueio preventivo de uma possível publicação duplicada.',
  },
  job_nearly_stuck: {
    kind: 'slow_execution',
    severity: 'warning',
    summary: 'Execução próxima do limite de tempo configurado.',
  },
}

const completionEvents = new Set([
  'auto_published',
  'late_publish_confirmed',
  'confirmed_published',
  'marked_removed',
  'canceled',
])

// Called after the matching publication event was recorded, in the caller's
// existing transaction when present. This does not modify a publication's status.
export function recordOperationalSignal(
  db: DatabaseSync,
  organizationId: number,
  jobId: number,
  eventType: string,
  details: Record<string, unknown> = {},
  actorId: number | null = null,
): void {
  const job = db
    .prepare('SELECT status FROM publication_jobs WHERE organization_id=? AND id=?')
    .get(organizationId, jobId) as { status: string } | undefined
  if (!job) return

  if (completionEvents.has(eventType)) {
    resolveJobIncidents(db, organizationId, jobId, eventType)
    return
  }
  if (
    eventType === 'auto_retry_scheduled' ||
    eventType === 'retry_requested' ||
    eventType === 'stalled_recovered'
  ) {
    const kinds: IncidentKind[] = ['execution_error', 'slow_execution']
    // Manual reset to pending is only allowed after the operator confirms that
    // Facebook did NOT publish; in that case the uncertain-result alert is resolved.
    if (eventType === 'retry_requested' && job.status === 'pending')
      kinds.push('publication_uncertain')
    resolveJobIncidents(db, organizationId, jobId, eventType, kinds)
    return
  }
  if (eventType === 'filled_waiting_confirmation' || eventType === 'filling_started') {
    resolveJobIncidents(db, organizationId, jobId, eventType, ['slow_execution'])
  }

  let signal = incidentTypes[eventType]
  if (eventType === 'fill_error') {
    // Do not create an incident for an error which was already auto-retried.
    // A possible publish attempt always requires manual confirmation.
    if (job.status === 'awaiting_confirmation') signal = incidentTypes.publish_result_unknown
    else if (job.status === 'error')
      signal = {
        kind: 'execution_error',
        severity: 'warning',
        summary: 'Preenchimento falhou. Revise o trabalho antes de tentar novamente.',
      }
  }
  if (!signal) return
  // Never trust external error text as a notification title or HTML.
  const message = typeof details.error === 'string' ? details.error.slice(0, 200) : ''
  const summary = message ? `${signal.summary} Detalhe: ${message}` : signal.summary
  const existing = db
    .prepare(
      'SELECT id,status FROM operational_incidents WHERE organization_id=? AND publication_job_id=? AND kind=?',
    )
    .get(organizationId, jobId, signal.kind) as { id: number; status: string } | undefined
  if (existing) {
    db.prepare(
      `UPDATE operational_incidents
       SET status=CASE WHEN status='resolved' THEN 'open' ELSE status END,
         severity=?,summary=?,occurrence_count=occurrence_count+1,
         last_seen_at=CURRENT_TIMESTAMP,
         acknowledged_at=CASE WHEN status='resolved' THEN NULL ELSE acknowledged_at END,
         acknowledged_by=CASE WHEN status='resolved' THEN NULL ELSE acknowledged_by END,
         resolved_at=NULL,resolved_by=NULL
       WHERE id=? AND organization_id=?`,
    ).run(signal.severity, summary, existing.id, organizationId)
    db.prepare(
      `INSERT INTO operational_incident_actions(organization_id,incident_id,action,actor_user_id,note)
       VALUES (?,?,?,?,?)`,
    ).run(
      organizationId,
      existing.id,
      existing.status === 'resolved' ? 'reopened' : 'occurred',
      actorId,
      eventType,
    )
    return
  }
  const id = Number(
    db
      .prepare(
        `INSERT INTO operational_incidents
          (organization_id,publication_job_id,kind,severity,summary)
          VALUES (?,?,?,?,?)`,
      )
      .run(organizationId, jobId, signal.kind, signal.severity, summary).lastInsertRowid,
  )
  db.prepare(
    `INSERT INTO operational_incident_actions(organization_id,incident_id,action,actor_user_id,note)
     VALUES (?,?,'opened',?,?)`,
  ).run(organizationId, id, actorId, eventType)
}

export function resolveJobIncidents(
  db: DatabaseSync,
  organizationId: number,
  jobId: number,
  reason: string,
  kinds?: IncidentKind[],
) {
  const rows = db
    .prepare(
      `SELECT id FROM operational_incidents WHERE organization_id=? AND publication_job_id=?
      AND status!='resolved' ${kinds?.length ? `AND kind IN (${kinds.map(() => '?').join(',')})` : ''}`,
    )
    .all(organizationId, jobId, ...(kinds || [])) as Array<{ id: number }>
  for (const row of rows) {
    db.prepare(
      `UPDATE operational_incidents SET status='resolved',resolved_at=CURRENT_TIMESTAMP,
        resolved_by=NULL WHERE organization_id=? AND id=? AND status!='resolved'`,
    ).run(organizationId, row.id)
    db.prepare(
      `INSERT INTO operational_incident_actions (organization_id,incident_id,action,note)
       VALUES (?,?,'auto_resolved',?)`,
    ).run(organizationId, row.id, reason)
  }
}
