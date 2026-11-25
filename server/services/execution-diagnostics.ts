// Closed vocabulary and bounded numeric metadata only. Never persist URLs, tokens,
// image bytes, arbitrary external text or page content in these diagnostics.
const executionCodes = new Set([
  'form_started', 'fields_checked', 'photos_started', 'photos_empty',
  'photo_identity_unverified', 'photo_previous_pending', 'photo_input_missing',
  'photo_address_rejected', 'photo_download_failed', 'photo_downloaded',
  'photo_count_unverified', 'photo_accepted', 'photo_accept_timeout', 'photos_retry',
  'advanced', 'advance_failed', 'groups_checked', 'publication_confirmed',
  'publication_uncertain', 'publication_not_clicked', 'form_finished',
])
const consumerCodes = new Set([
  'consumer_paused', 'execution_pending', 'session_missing', 'api_unauthorized',
  'queue_http_error', 'daily_limit', 'operational_interval', 'scheduled_wait',
  'no_eligible_job', 'queue_empty', 'job_selected', 'facebook_not_ready',
  'prepare_rejected', 'dispatch_confirmed', 'dispatch_failed', 'consumer_check_failed',
])
function sanitizeEntry(value: unknown, codes: Set<string>, limits: Record<string, number>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (typeof input.code !== 'string' || !codes.has(input.code)) return null
  const result: Record<string, string | number> = { code: input.code }
  for (const [key, limit] of Object.entries(limits)) {
    const n = input[key]
    if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= limit)
      result[key] = n
  }
  return result
}
export function sanitizeExecutionDiagnostics(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 100)
    .map((entry) => sanitizeEntry(entry, executionCodes, {
      elapsedMs: 86400000, index: 20, count: 100, expected: 100, httpStatus: 599,
    }))
    .filter((entry) => entry !== null)
}
export function sanitizeConsumerDiagnostic(value: unknown) {
  return sanitizeEntry(value, consumerCodes, {
    at: 9999999999999, jobId: Number.MAX_SAFE_INTEGER, queueSize: 100000,
    retryAfterSeconds: 86400000, httpStatus: 599,
  })
}
