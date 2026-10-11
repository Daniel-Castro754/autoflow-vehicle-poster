import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ui = readFileSync('src/Views.tsx', 'utf8')
const css = readFileSync('src/styles.css', 'utf8')
const start = ui.indexOf('className="group-list-field group-manager"')
const end = ui.indexOf('className="managed-groups"', start)
assert(start !== -1 && end > start, 'Group manager toolbar must exist')
const toolbar = ui.slice(start, end)

for (const [label, action] of [
  ['Reordenar grupos', 'onClick={runAutoCurate}'],
  ['Desfazer ordem', 'onClick={() => void undoGroupCuration()}'],
  ['Adicionar grupo', 'setGroups((current) => ['],
  ['Importar CSV', 'void importGroupCsv(event.target.files?.[0])'],
]) {
  assert(toolbar.includes(label), 'Missing action label: ' + label)
  assert(toolbar.includes(action), 'Action handler changed for: ' + label)
}
assert(toolbar.includes('disabled={curating || !groups.length}'))
assert(toolbar.includes('disabled={groups.length >= 2000}'))
assert(toolbar.includes('role="group"'))
assert(toolbar.includes('aria-label="Importar arquivo CSV de grupos"'))
assert(toolbar.includes('group-manager-csv-input'))
for (const rule of [
  '.group-manager-actions',
  '.group-manager .group-manager-action--primary',
  '.group-manager .group-manager-action--outline',
  '.group-manager .group-manager-action--ghost',
  '.theme-dark .group-manager .group-manager-action--primary',
  '.group-manager .group-manager-action:focus-within',
  '@media (max-width: 460px)',
])
  assert(css.includes(rule), 'Missing style: ' + rule)
assert(ui.includes('setGroupEditsPending(true)'), 'Unsaved group edits must remain tracked')
assert(ui.includes('previewDigest'), 'Reordering must still require a preview')
console.log(
  '✓ Group toolbar: all actions, preview, limits, CSV accessibility and responsive styling retained',
)
