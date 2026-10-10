import assert from 'node:assert/strict'
import { generateVehicleDescription } from '../server/services/description-generator.ts'

const originalFetch = globalThis.fetch
const vehicle = { year: 2019, make: 'Volkswagen', model: 'Saveiro', km: 80000, price: 65000 }
const calls = []
const SECRET = 'test-fake-key-do-not-log'
try {
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: options?.headers })
    if (String(url).includes('generativelanguage')) return new Response('{}', { status: 429 })
    return Response.json({ choices: [{ message: { content: 'Saveiro 2019 com 80 mil km. Entre em contato.' } }] })
  }
  const recovered = await generateVehicleDescription(vehicle, {
    provider: 'auto', apiKeys: { gemini: SECRET, openai: SECRET },
  })
  assert.equal(recovered.provider, 'openai')
  assert.deepEqual(recovered.attemptedProviders, ['gemini', 'openai'])
  assert(recovered.fallbackReason.includes('429'))
  assert.equal(calls.length, 2)
  assert(!calls[0].url.includes(SECRET), 'API key must never be in Gemini URL')
  assert.equal(calls[0].headers['x-goog-api-key'], SECRET)
  calls.length = 0

  globalThis.fetch = async () => {
    calls.push('failed')
    return new Response('{}', { status: 503 })
  }
  const offline = await generateVehicleDescription(vehicle, {
    provider: 'auto', apiKeys: { gemini: SECRET, openai: SECRET },
  })
  assert.equal(offline.provider, 'procedural')
  assert.deepEqual(offline.attemptedProviders, ['gemini', 'openai'])
  assert(offline.fallbackReason.includes('Gemini') && offline.fallbackReason.includes('OpenAI'))
  assert(!offline.fallbackReason.includes(SECRET))
  assert.equal(calls.length, 2)
  calls.length = 0

  const onlyGemini = await generateVehicleDescription(vehicle, {
    provider: 'gemini', apiKeys: { gemini: SECRET, openai: SECRET },
  })
  assert.equal(onlyGemini.provider, 'procedural')
  assert.deepEqual(onlyGemini.attemptedProviders, ['gemini'])
  assert.equal(calls.length, 1, 'An explicitly selected provider must not switch to another paid provider')

  calls.length = 0
  const chosenOffline = await generateVehicleDescription(vehicle, { provider: 'procedural' })
  assert.equal(chosenOffline.provider, 'procedural')
  assert.equal(chosenOffline.fallbackReason, undefined)
  assert.equal(calls.length, 0)
  console.log('✓ AI fallback: provider order, explicit-provider boundary, real provider, no URL secrets, offline reason')
} finally {
  globalThis.fetch = originalFetch
}
