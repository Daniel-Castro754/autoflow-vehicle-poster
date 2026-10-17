import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { calculateTeamSummary, formatRate } from '../src/management-metrics.ts'

assert.equal(formatRate(0, 0), 'Sem dados', 'Missing sample does not mean 0% success')
assert.equal(formatRate(0, 12), '0%', 'Real failures must be distinguished from missing data')
assert.equal(formatRate(3, 8), '38%')
assert.equal(formatRate(8, 8), '100%')
assert.equal(formatRate(5, Number.NaN), 'Sem dados')
assert.equal(formatRate(-1, 5), 'Sem dados')

assert.deepEqual(calculateTeamSummary([], []), {
  activeMembers: 0,
  pausedProfiles: 0,
  unassignedProfiles: 0,
})
assert.deepEqual(
  calculateTeamSummary(
    [
      { id: 1, active: 1 },
      { id: 2, active: 0 },
      { id: 3, active: 1 },
    ],
    [
      { userId: 1, automationPaused: 0 },
      { userId: 2, automationPaused: 1 },
      { userId: 33, automationPaused: 0 },
      { userId: 3, automationPaused: 1 },
    ],
  ),
  { activeMembers: 2, pausedProfiles: 2, unassignedProfiles: 2 },
  'Paused account is not an online-state indicator and inactive owners need review',
)

const read = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8')
const view = read('src/Views.tsx')
const app = read('src/App.tsx')
const css = read('src/management-workspaces.css')
const capacityEditor = read('src/ProfileCapacityEditor.tsx')
const capacityCss = read('src/profile-capacity.css')
const main = read('src/main.tsx')

for (const token of [
  'report-context',
  'report-fetch-error',
  'aria-pressed={view ===',
  'formatRate(completed, reportJobTotal)',
])
  assert(view.includes(token), `Reports: missing ${token}`)
assert(view.includes('Sem trabalhos no período'))
assert(view.includes('return'), 'Report load states should return meaningful UI')
assert(view.includes("setReportError("), 'Successful refresh must clear stale warning')
assert(view.includes('Promise.allSettled(['), 'Reports must retain partial results on API errors')
assert(app.includes('Promise.allSettled(['), 'Initial dashboard must retain independent loaded resources')
assert(app.includes('AbortSignal.timeout(20_000)'), 'API requests must not hang indefinitely')

const sections = [
  'company',
  'marketplace',
  'intelligence',
  'notifications',
  'appearance',
  'security',
]
for (const key of sections) {
  assert(view.includes(`id="settings-${key}"`), `Missing settings destination: ${key}`)
  assert(view.includes(`id: '${key}'`), `Missing settings navigation entry: ${key}`)
}
assert(view.includes('scrollIntoView'), 'Category navigator should have working destinations')
assert(
  view.includes('<form onSubmit={save}>'),
  'Existing unified save operation must remain intact',
)
assert(view.includes('settings-save-copy'))
assert(
  view.includes(
    'type="password"\n                  autoComplete="off"\n                  value={alertTelegramToken}',
  ),
)
assert(view.includes('aria-pressed={theme ==='))
assert(
  !view.includes('hidden={settingsSection'),
  'Required inputs must not be hidden for form validation',
)

for (const label of ['team-summary', 'team-summary-card', 'team-people', 'team-profiles']) {
  assert(app.includes(label), `Team summary missing: ${label}`)
}
assert(app.includes('calculateTeamSummary('))
assert(app.includes('canManage &&'), 'Admin-only controls must remain gated')
assert(app.includes('onSetAccountAutomation'), 'Existing automation pause controls must remain')
assert(app.includes('onToggleUser'), 'Existing user activation controls must remain')

// Keep account identity and its capacity editor in separate, responsive areas.
// The dedicated stylesheet must be loaded by the component, not left orphaned.
assert(app.includes('className="account-card-header"'))
assert(app.includes('className="account-card-identity"'))
assert(capacityEditor.includes("import './profile-capacity.css'"))
assert(capacityEditor.includes('aria-label="Limites operacionais do perfil"'))
assert(capacityEditor.includes('type="submit" className="secondary" disabled={loading}'))
assert(capacityEditor.includes("'/social-accounts/' + accountId + '/capacity'"))
assert(capacityCss.includes('.team-page .account-card > .account-card-header'))
assert(capacityCss.includes('.team-page .account-card > .profile-capacity'))
assert(capacityCss.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'))
assert(capacityCss.includes('@media (max-width: 720px)'))

for (const selector of [
  '.reports-page .report-context',
  '.settings-section-nav',
  '.settings-page .toggle-label',
  '.team-page .team-summary',
  '.settings-page .settings-card',
])
  assert(css.includes(selector), `Missing design rule: ${selector}`)
assert(css.includes('@media (max-width: 1180px)'))
assert(css.includes('@media (max-width: 740px)'))
assert(css.includes('prefers-reduced-motion'))

// Marketplace group toolbar keeps the same actions and handlers with clear
// visual hierarchy and responsive, keyboard-accessible controls.
for (const marker of [
  'className="group-manager-actions"',
  'className="group-action group-action-primary"',
  'className="group-action group-action-secondary group-import-action"',
  'className="group-action group-action-quiet"',
  'disabled={curating || !groups.length}',
  'onClick={runAutoCurate}',
  'onClick={() => void undoGroupCuration()}',
  'void importGroupCsv(event.target.files?.[0])',
  'setGroupEditsPending(true)',
])
  assert(view.includes(marker), `Missing Marketplace group control: ${marker}`)
for (const selector of [
  '.group-manager-head > .group-manager-actions',
  '.group-manager-actions .group-action-primary',
  '.group-manager-actions .group-action-secondary',
  '.group-manager-actions .group-action-quiet',
  '.group-manager-actions .group-import-action:focus-visible',
  '@media (max-width: 680px)',
])
  assert(css.includes(selector), `Missing group toolbar rule: ${selector}`)
assert(
  main.indexOf("import './management-workspaces.css'") >
    main.indexOf("import './operational-workspaces.css'"),
  'Management styling should follow the shared design tokens and operational layout',
)
console.log('✓ Phase 6.3: report sample semantics, team metrics, safe settings navigation')
