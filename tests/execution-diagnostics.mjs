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

import { publicationReviewKind } from '../server/services/publication-evidence.ts'
import { recordConsumerState, consumerState } from '../server/services/execution-diagnostics.ts'
assert.equal(publicationReviewKind({status:'awaiting_confirmation',fillReport:{published:false,publishAttempted:false,filledCount:15,totalCount:15}}),'manual_review')
assert.equal(publicationReviewKind({status:'awaiting_confirmation',fillReport:{published:false,publishAttempted:false,filledCount:14,totalCount:15}}),'fill_incomplete')
assert.equal(publicationReviewKind({status:'awaiting_confirmation',publishAttemptAt:'2026-11-25',fillReport:{published:false,publishAttempted:false}}),'publication_uncertain')
assert.equal(publicationReviewKind({status:'awaiting_confirmation',fillReport:'{}'}),'review_unknown')
const stateDb = {}
recordConsumerState(stateDb,1,2,false,1000)
assert.equal(consumerState(stateDb,1,2,1001).state,'paused')
assert.equal(consumerState(stateDb,2,2,1001).state,'unknown')
assert.equal(consumerState(stateDb,1,2,301001).state,'unknown')
recordConsumerState(stateDb,1,2,true,2000)
assert.equal(consumerState(stateDb,1,2,2001).state,'enabled')
recordConsumerState(stateDb,1,2,undefined,2002)
assert.equal(consumerState(stateDb,1,2,2003).state,'unknown')

assert.deepEqual(sanitizeExecutionDiagnostics([{ code: 'transmission_checked', expectedKind: 2, observedKind: 3, controlFound: 1, matched: 0, rawText: 'private' }]), [{ code: 'transmission_checked', expectedKind: 2, observedKind: 3, controlFound: 1, matched: 0 }])
assert.deepEqual(sanitizeExecutionDiagnostics([{ code: 'transmission_checked', expectedKind: 3, observedKind: 4, controlFound: 2, matched: -1 }]), [{ code: 'transmission_checked' }])
