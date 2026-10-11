import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ui = readFileSync('src/ReadinessDashboard.tsx', 'utf8')
const css = readFileSync('src/styles.css', 'utf8')

// Visual refinements must not alter security confirmation or backend endpoints.
for (const path of [
  '/health/readiness',
  '/health/backups',
  '/health/backups/verify',
  '/health/backups/restore-drill',
]) assert(ui.includes(path), 'Required endpoint unchanged: ' + path)

assert(ui.includes("confirmation: 'TESTAR_RESTAURACAO_ISOLADA'"))
assert(ui.includes('window.confirm('))
for (const action of [
  'onClick={() => void listBackups()}',
  'onClick={() => void verifyBackup(backup.id)}',
  'onClick={() => void restoreTest(backup.id)}',
  'onClick={() => navigate(guide.destination)}',
  'onClick={() => void load()}',
]) assert(ui.includes(action), 'Interactive control not wired: ' + action)

for (const classname of [
  'readiness-guide-trigger',
  'readiness-guide-chevron',
  'readiness-guide-actions',
  'readiness-button--primary',
  'readiness-button--outline',
  'readiness-button--quiet',
  'readiness-backup-actions',
]) {
  assert(ui.includes(classname), 'UI must use class: ' + classname)
  assert(css.includes('.' + classname), 'Design style must define class: ' + classname)
}

assert(css.includes('.theme-dark .readiness-dashboard'), 'Provide dark-theme support')
assert(css.includes(':focus-visible'), 'Include keyboard focus')
assert(css.includes(':disabled'), 'Include disabled states')
assert(css.includes('@media (max-width: 700px)'), 'Include small-screen layouts')
console.log('✓ Readiness buttons: actions preserved, backup confirmation retained, focus and dark theme styled')
