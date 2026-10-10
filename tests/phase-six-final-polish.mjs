import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function read(path) {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8')
}
const app = read('src/App.tsx')
const vehicles = read('src/Vehicles.tsx')
const views = read('src/Views.tsx')
const guard = read('src/DrawerFocusGuard.tsx')
const css = read('src/final-polish.css')
const main = read('src/main.tsx')
const packageJson = JSON.parse(read('package.json'))

// Each dynamically opened drawer gets a labeled dialog with Escape/Tab
// navigation, initial focus and restored focus; existing close actions stay.
assert.equal((app.match(/<DrawerFocusGuard/g) || []).length, 1)
assert.equal((vehicles.match(/<DrawerFocusGuard/g) || []).length, 3) // Includes ZIP preview
assert.equal((views.match(/<DrawerFocusGuard/g) || []).length, 5)
for (const part of [
  "drawer.setAttribute('role', 'dialog')",
  "drawer.setAttribute('aria-modal', 'true')",
  "drawer.setAttribute('aria-label', label)",
  "event.key === 'Escape'",
  "event.key !== 'Tab'",
  'last.focus()',
  'first.focus()',
  'previouslyFocused.focus()',
])
  assert(guard.includes(part), `Drawer focus management missing: ${part}`)

// Mobile menu does not leave an invisible keyboard navigation trap behind.
for (const part of [
  'aria-expanded={mobileMenuOpen}',
  'aria-controls="mobile-navigation"',
  "role={mobileMenuOpen ? 'dialog' : undefined}",
  "aria-current={active === label ? 'page' : undefined}",
  "window.matchMedia('(min-width: 901px)')",
  "event.key === 'Escape'",
  'opener?.focus()',
  'aria-label="Fechar menu"',
  'aria-label="Sair da conta"',
  'role="status" aria-live="polite"',
])
  assert(app.includes(part), `Mobile navigation or feedback missing: ${part}`)

// Wide tables are scrollable and focusable without changing selection/actions.
for (const [component, expected] of [
  [views, 3],
  [vehicles, 1],
]) {
  const tableRegions = [...component.matchAll(/<div\s+className="table-wrap"[\s\S]*?>/g)]
  assert.equal(tableRegions.length, expected)
  for (const [markup] of tableRegions) {
    assert(markup.includes('role="region"'))
    assert(markup.includes('aria-label='))
    assert(markup.includes('tabIndex={0}'))
  }
}
assert(views.includes('confirmNoPublication'), 'Duplicate publication protection must remain')
assert(vehicles.includes('onChange={toggleAll}'), 'Bulk selection must remain')
assert(css.includes(".table-wrap[tabindex='0']:focus-visible"))

// Breakpoints, visible labels and controls on small screens, accessible drawers
// and a clean reporting print layout.
for (const part of [
  '@media (max-width: 1200px)',
  '@media (max-width: 900px)',
  '@media (max-width: 600px)',
  '@media print',
  '@media (prefers-reduced-motion: reduce)',
  '.app-shell .sidebar.mobile-open',
  '.app-shell .sidebar .sidebar-close',
  '.app-shell .drawer',
  'overflow-y: auto;',
  'height: 100dvh;',
  'width: 100vw;',
  '.app-shell .title-row .primary',
])
  assert(css.includes(part), `Final polish missing: ${part}`)
assert(
  /\.app-shell \.title-row \.primary,\s*\.app-shell \.title-row \.secondary\s*\{\s*font-size: 13px;/.test(
    css,
  ),
)
assert(
  main.indexOf("import './final-polish.css'") >
    main.indexOf("import './management-workspaces.css'"),
)
assert(
  packageJson.scripts['test:design-final'],
  'Final visual regression must be in package scripts',
)

// The final palette must pass standard text contrast on neutral surfaces.
function rgb(hex) {
  return [1, 3, 5].map((index) => {
    const v = Number.parseInt(hex.slice(index, index + 2), 16) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
}
function luminance(hex) {
  const [r, g, b] = rgb(hex)
  return r * 0.2126 + g * 0.7152 + b * 0.0722
}
function contrast(a, b) {
  const x = luminance(a),
    y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
for (const [fg, bg, name] of [
  ['#edf4f5', '#172228', 'Dark text'],
  ['#b5c3c6', '#172228', 'Dark muted text'],
  ['#192c31', '#ffffff', 'Light text'],
  ['#5a6d72', '#ffffff', 'Light muted text'],
  ['#ffffff', '#117f65', 'Light primary button'],
  ['#081c18', '#25b98b', 'Dark primary button'],
])
  assert(contrast(fg, bg) >= 4.5, `${name} contrast too low: ${contrast(fg, bg)}`)

console.log('✓ Fase 6.4: modal focus, menu teclado, rolagem, responsividade e contraste')
