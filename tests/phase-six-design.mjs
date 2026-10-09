import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { overviewActionCounts } from '../src/overview-priorities.ts'

assert.deepEqual(overviewActionCounts([], null), {
  noPhotos: 0,
  attention: 0,
  ready: 0,
  openIncidents: 0,
  critical: 0,
})
assert.deepEqual(
  overviewActionCounts(
    [
      { status: 'Pronto', imageCount: 0 },
      { status: 'Pronto', imageCount: undefined },
      { status: 'Atenção', imageCount: 0 },
      { status: 'Publicado', imageCount: 4 },
      { status: 'Vendido', imageCount: 0 },
      { status: 'Rascunho', imageCount: 0 },
    ],
    { open: 2, acknowledged: 1, critical: 2 },
  ),
  { noPhotos: 3, attention: 1, ready: 2, openIncidents: 3, critical: 2 },
  'Unknown images are not missing; sold vehicles are excluded from photo alerts',
)
assert.deepEqual(
  overviewActionCounts([], { open: 0, acknowledged: 1, critical: 4 }),
  { noPhotos: 0, attention: 0, ready: 0, openIncidents: 1, critical: 1 },
  'Critical counter cannot exceed active incidents',
)

const css = readFileSync(new URL('../src/design-system.css', import.meta.url), 'utf8')
const entry = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
const overview = readFileSync(new URL('../src/Views.tsx', import.meta.url), 'utf8')
for (const token of [
  '--af-bg:',
  '--af-surface:',
  '--af-border:',
  '--af-text:',
  '--af-muted:',
  '--af-primary:',
  '--af-focus:',
])
  assert(css.includes(token), `Missing semantic token ${token}`)
assert(entry.indexOf("import './design-system.css'") > entry.indexOf("import './styles.css'"))
for (const panel of ['<OperationalHealth', '<InterventionCenter', '<SchedulingInsights']) {
  assert(overview.includes(panel), `Existing panel removed: ${panel}`)
}
assert(overview.includes('<OverviewPriorities'))
assert(overview.includes('overview-monitoring'))
assert(overview.includes('overview-inventory-summary'))
assert(css.includes(':focus-visible'), 'Keyboard focus indication is required')
assert(css.includes('prefers-reduced-motion'), 'Respect reduced-motion preference')
console.log('✓ Fase 6: prioridades reais, design tokens, navegação e componentes preservados')
