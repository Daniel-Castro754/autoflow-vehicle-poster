import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../extension/selector-config.js', import.meta.url), 'utf8')
const context = {}
vm.runInNewContext(source, context)
const config = context.AUTOFLOW_SELECTOR_CONFIG
assert.ok(config, 'Selector config must be published on globalThis')
assert.match(config.version, /^\d{4}\.\d{2}\.\d+$/)
assert.deepEqual([...config.supportedLocales], ['pt-BR', 'en-US', 'es-ES'])

const normalize = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

for (const locale of config.supportedLocales) {
  const html = await readFile(
    new URL(`./fixtures/marketplace-vehicle-${locale}.html`, import.meta.url),
    'utf8',
  )
  const snapshotText = normalize(html.replace(/<[^>]+>/g, ' '))
  for (const [fieldName, spec] of Object.entries(config.fields)) {
    if (!spec.critical) continue
    const labels = spec.labels[locale] || []
    assert.ok(labels.length, `${fieldName} must define ${locale} labels`)
    assert.ok(
      labels.some((label) => snapshotText.includes(normalize(label))),
      `${fieldName} did not match the ${locale} Marketplace fixture`,
    )
  }
}

const typingFields = Object.entries(config.fields)
  .filter(([, spec]) => spec.humanTyping)
  .map(([name]) => name)
assert.ok(typingFields.includes('price'))
assert.ok(typingFields.includes('mileage'))
console.log('✓ Seletores: mapa versionado PT/EN/ES cobre fixtures e campos críticos.')

// Exercise the production validation helpers against realistic localized values.
const content = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8')
const transmissionStart = content.indexOf('  const transmissionSelector =')
const transmissionEnd = content.indexOf('  async function confirmTransmission(', transmissionStart)
assert(transmissionStart >= 0 && transmissionEnd > transmissionStart)
class Select {}
class Input {}
const validation = { normalize, HTMLSelectElement: Select, HTMLInputElement: Input }
vm.runInNewContext(content.slice(transmissionStart, transmissionEnd) + '\nthis.confirm = transmissionConfirmed', validation)
const control = (text, aria = '') => ({ innerText: text, textContent: text, getAttribute: (name) => name === 'aria-valuetext' ? aria : '' })
assert(validation.confirm(control('Câmbio automático'), 'Automático'))
assert(validation.confirm(control('Automatic'), 'Automático'))
assert(!validation.confirm(control('Manual'), 'Automático'))
assert(!validation.confirm(control('Manual Automático'), 'Automático'))
assert(!validation.confirm(control('Automático', 'Manual'), 'Automático'))
assert(!validation.confirm(control('Selecione o câmbio'), 'Automático'))
assert(validation.confirm(control('Tipo de câmbio: Câmbio automático'), 'Automatic'))
assert(validation.confirm(control('Transmisión automática'), 'Automático'))
assert(validation.confirm(control('Transmission type: Manual'), 'Manual'))
assert(!validation.confirm(control('Automatizado'), 'Automático'))
assert(!validation.confirm(control('Manual ou automático'), 'Automático'))
assert(!validation.confirm(control('Automático', 'Manual'), 'Automático'))
const open = { ...control('Automático'), getAttribute: key => key === 'aria-expanded' ? 'true' : '' }
assert(!validation.confirm(open, 'Automático'))
assert(!validation.confirm({ ...control('Automático'), querySelector: () => ({}) }, 'Automático'))
assert(!validation.confirm({ ...control(''), textContent: 'Automático' }, 'Automático'))
const native = new Select()
native.selectedOptions = [{ textContent: 'Automático', value: 'automatic' }]
assert(validation.confirm(native, 'Automático'))
native.selectedOptions = [{ textContent: 'Manual', value: 'automatic' }]
assert(!validation.confirm(native, 'Automático'))
native.selectedOptions = []
assert(!validation.confirm(native, 'Automático'))
const typed = new Input()
typed.value = 'Automático'
typed.getAttribute = () => ''
assert(!validation.confirm(typed, 'Automático'))
typed.readOnly = true
assert(validation.confirm(typed, 'Automático'))
// A nearby preview label cannot authorize an unrelated control.
const unrelated = { ...control('Automático'), getAttribute: key => key === 'aria-label' ? 'Combustível' : '', contains: () => false, querySelectorAll: () => [] }
const actual = { ...unrelated, getAttribute: key => key === 'aria-label' ? 'Tipo de câmbio' : '' }
const root = { querySelectorAll: () => [unrelated] }
const finder = { normalize, HTMLSelectElement: Select, HTMLInputElement: Input, rootScope: () => root, visible: () => true, document: { getElementById: () => null } }
vm.runInNewContext(content.slice(transmissionStart, transmissionEnd) + '\nthis.findTransmission = findTransmissionControl', finder)
assert.equal(finder.findTransmission(), null)
root.querySelectorAll = () => [unrelated, actual]
assert.equal(finder.findTransmission(), actual)
root.querySelectorAll = () => [actual, { ...actual }]
assert.equal(finder.findTransmission(), null)
const label = { textContent: 'Câmbio' }
const selectedValue = { textContent: 'Automático' }
validation.document = { getElementById: id => id === 'field-label' ? label : selectedValue }
const accessible = { ...control('Câmbio'), getAttribute: key => key === 'aria-labelledby' ? 'field-label selected-value' : '' }
assert(validation.confirm(accessible, 'Automático'))
assert(!validation.confirm(accessible, 'Manual'))
const conflicting = { ...accessible, innerText: 'Câmbio Manual' }
assert(!validation.confirm(conflicting, 'Automático'))
const actionStart = content.indexOf('  function actionButton(')
const actionEnd = content.indexOf('  function firePointerClick(', actionStart)
assert(actionStart >= 0 && actionEnd > actionStart)
const fake = (text) => ({ innerText: text, textContent: text, tagName: 'BUTTON', getAttribute: () => '', getBoundingClientRect: () => ({ left: 0, top: 600 }) })
const post = fake('Postar'), other = fake('Não postar agora')
const actions = { normalize, controlText: (button) => normalize(button.innerText + ' ' + button.textContent), controlEnabled: () => true, exactOrPrefix: (a,b) => a === b || a.startsWith(b + ' ') || a.endsWith(' ' + b), document: { querySelectorAll: () => [other, post] }, window: { innerWidth: 1000, innerHeight: 800 } }
vm.runInNewContext(content.slice(actionStart, actionEnd) + '\nthis.action = actionButton', actions)
assert.equal(actions.action(['Publicar', 'Postar', 'Publish'], true), post)
actions.document.querySelectorAll = () => [other]
assert.equal(actions.action(['Publicar', 'Postar', 'Publish'], true), null)
console.log('✓ Confirmação de câmbio e botão Postar: evidência positiva e negativa.')
