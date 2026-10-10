import assert from 'node:assert/strict'
import { guidedRemediation } from '../server/services/guided-remediation.ts'

const checks = [
  { id: 'pilot', status: 'attention' },
  { id: 'backup', status: 'unknown' },
  { id: 'vault', status: 'attention' },
  { id: 'jobs', status: 'attention' },
  { id: 'groups', status: 'attention' },
  { id: 'telegram', status: 'attention' },
  { id: 'profiles', status: 'attention' },
  { id: 'ai', status: 'attention' },
  { id: 'inventory', status: 'inactive' },
  { id: 'webhook', status: 'ok' },
]
const original = JSON.stringify(checks)
const guides = guidedRemediation(checks)
assert.deepEqual(guides.map((g) => g.checkId), [
  'jobs', 'vault', 'groups', 'pilot', 'profiles', 'ai', 'telegram', 'backup',
])
assert.equal(JSON.stringify(checks), original, 'Guidance must not mutate diagnostics')
assert.equal(new Set(guides.map((g) => g.id)).size, guides.length)
assert(guides.every((g) => g.requiresHumanApproval === true && g.performsChanges === false))
assert(guides.every((g) => g.destination && g.steps.length >= 3 && g.safety && g.reason))
assert(guides.every((g) => !g.steps.some((s) => /execute automaticamente|exclua todos os grupos/i.test(s))))

const groups = guides.find((g) => g.checkId === 'groups')
assert(groups.steps.some((step) => /backup/i.test(step)))
assert(/não exclui/i.test(groups.safety))
assert(guides.find((g) => g.checkId === 'jobs').steps.some((step) => /Facebook/i.test(step)))
const backup = guides.find((g) => g.checkId === 'backup')
assert.equal(backup.priority, 'verification')
assert(/não uma falha confirmada/.test(backup.reason))

const supplied = 'SENSITIVE_KEY_FROM_UNTRUSTED_CHECK_DATA'
const malicious = guidedRemediation([
  { id: 'ai', status: 'attention', detail: supplied, page: 'http://evil.test' },
  { id: '__proto__', status: 'attention' },
  { id: 'constructor', status: 'attention' },
  { id: 'unknown-ext', status: 'attention' },
])
assert.equal(malicious.length, 1)
assert.equal(malicious[0].destination, 'Central de IA')
assert(!JSON.stringify(malicious).includes(supplied))
assert.deepEqual(guidedRemediation([{ id: 'vault', status: 'ok' }]), [])
assert.deepEqual(guidedRemediation([{ id: 'backup', status: 'ok' }]), [])
assert.deepEqual(guidedRemediation([{ id: 'backup', status: 'unknown' }]).map((g) => g.checkId), ['backup'])

console.log('✓ Guided remediation: static prioritized instructions, no destructive actions and no untrusted-data leakage')
