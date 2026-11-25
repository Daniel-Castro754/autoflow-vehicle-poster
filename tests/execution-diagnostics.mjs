import assert from 'node:assert/strict'
import { sanitizeExecutionDiagnostics, sanitizeConsumerDiagnostic } from '../server/services/execution-diagnostics.ts'
assert.deepEqual(sanitizeExecutionDiagnostics([
  { code: 'photo_download_failed', index: 2, httpStatus: 403, url: 'secret', token: 'secret' },
  { code: 'invalid', elapsedMs: 20 },
  { code: 'photo_accepted', index: 21, count: 3, elapsedMs: -1 },
]), [
  { code: 'photo_download_failed', index: 2, httpStatus: 403 },
  { code: 'photo_accepted', count: 3 },
])
assert.equal(sanitizeExecutionDiagnostics(Array(101).fill({ code: 'form_started' })).length, 100)
assert.deepEqual(sanitizeConsumerDiagnostic({ code: 'operational_interval', retryAfterSeconds: 60, accountId: 42, password: 'secret' }), { code: 'operational_interval', retryAfterSeconds: 60 })
assert.equal(sanitizeConsumerDiagnostic({ code: 'arbitrary text' }), null)
console.log('Execution diagnostics: bounded codes, numeric metadata and sensitive field exclusion.')
