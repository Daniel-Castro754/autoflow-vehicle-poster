import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function read(name) {
  return readFileSync(new URL('../' + name, import.meta.url), 'utf8')
}

const ai = read('src/AiCenterView.tsx')
const vehicles = read('src/Vehicles.tsx')
const publications = read('src/Views.tsx')
const css = read('src/operational-workspaces.css')
const entry = read('src/main.tsx')

for (const part of [
  'ai-workflow-intro',
  'ai-workflow-steps',
  'ai-preflight',
  'ai-pipeline-steps',
  'ai-audit-warning',
]) {
  assert(ai.includes(part), `Central IA: missing ${part}`)
  assert(css.includes('.' + part), `CSS: missing ${part}`)
}
assert(ai.includes("audit ? `${audit.healthScore}%` : '—'"))
assert(ai.includes("audit?.activeAccounts ?? '—'"), 'Unknown profile count must not default to one')
assert(!ai.includes('Tráfego máximo no Facebook Marketplace'))
assert(!ai.includes('Pipeline 100% autônomo'))
assert(!ai.includes('Tudo perfeito!'))
assert.equal(
  (ai.match(/className="primary ai-big-btn"/g) || []).length,
  1,
  'Only one primary launch button in the AI workflow',
)

for (const label of [
  'vehicle-filter-section',
  'vehicle-status-filters',
  'vehicle-inventory-panel',
  'vehicle-scope-note',
  'aria-pressed={status === option.value}',
  'changeStatusFilter(option.value)',
])
  assert(vehicles.includes(label), `Inventory: missing ${label}`)
assert(!vehicles.includes('Todas as lojas'), 'Do not show a no-op store filter')
assert(vehicles.includes('setSelected(new Set())'), 'Changing status must clear old selections')
assert(vehicles.includes('setPage(1)'), 'Changing status must reset server pagination')
assert(vehicles.includes('api<VehiclePage>(`/vehicles/paged?'), 'Filtering stays server-paginated')

for (const part of [
  'publication-workflow',
  'publication-workflow-status',
  'publication-setup-note',
  'publication-quick-filters',
  'className="content publications-page"',
  "setQueueStatus('pending')",
  "setQueueStatus('error')",
  'aria-pressed={view ===',
])
  assert(publications.includes(part), `Publication view: missing ${part}`)
assert(publications.includes('setQueuePage(1)'), 'Queue shortcuts must reset pagination')
assert(publications.includes('setSelected(new Set())'), 'Queue shortcuts must clear selections')

for (const selector of [
  '.app-shell .ai-kpi-grid',
  '.app-shell .ai-chat-history',
  '.vehicle-status-filters',
  '.vehicles-page .table-wrap',
  '.publication-quick-filters',
  '.publications-page .queue-filters',
])
  assert(css.includes(selector), `Unstyled operational component: ${selector}`)

assert(css.includes('@media (max-width: 1200px)'))
assert(css.includes('@media (max-width: 720px)'))
assert(
  entry.indexOf("import './operational-workspaces.css'") >
    entry.indexOf("import './design-system.css'"),
)
console.log('✓ Phase 6.2: AI, stock and publication workspace UX regressions passed')
