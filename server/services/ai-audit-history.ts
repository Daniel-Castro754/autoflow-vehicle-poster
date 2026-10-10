import type { DatabaseSync } from 'node:sqlite'

export type AiAuditAction =
  | 'description_generated'
  | 'description_preview'
  | 'description_approved'
  | 'manual_pilot_preview'
  | 'manual_pilot_executed'
  | 'assistant_command'
  | 'api_key_test'
  | 'ai_configuration_saved'

export type AiAuditOutcome = 'preview' | 'applied' | 'rejected' | 'tested' | 'configured'

/** Never store prompts, vehicle descriptions, API credentials or full request bodies here. */
export function recordAiAudit(
  db: DatabaseSync,
  org: number,
  user: number | null,
  action: AiAuditAction,
  outcome: AiAuditOutcome,
  provider: string | null = null,
  items = 0,
) {
  const cleanProvider =
    provider && ['gemini', 'openai', 'procedural', 'auto'].includes(provider) ? provider : null
  db.prepare(
    'INSERT INTO ai_operation_history(organization_id,user_id,action,outcome,provider,items) VALUES(?,?,?,?,?,?)',
  ).run(org, user, action, outcome, cleanProvider, Math.max(0, Math.min(2000, items)))
}

export function getAiAuditHistory(db: DatabaseSync, org: number, limit = 30) {
  return db.prepare(
    'SELECT id,action,outcome,provider,items,created_at createdAt FROM ai_operation_history WHERE organization_id=? ORDER BY id DESC LIMIT ?',
  ).all(org, Math.max(1, Math.min(100, Number(limit) || 30)))
}
