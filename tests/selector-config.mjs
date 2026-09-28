import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../extension-mv2/selector-config.js', import.meta.url), 'utf8')
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
