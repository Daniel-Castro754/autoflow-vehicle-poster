import assert from 'node:assert/strict'
import {
  lookupFipePrice,
  compareWithFipe,
  clearFipeCache,
} from '../server/services/fipe-service.ts'

const originalFetch = globalThis.fetch,
  originalNow = Date.now
let now = Date.parse('2026-06-15T12:00:00Z'),
  calls = 0,
  wrongBrand = false,
  wrongYear = false
Date.now = () => now
const catalog = [
  { codigo: '48', nome: 'Renault' },
  { codigo: '44', nome: 'Peugeot' },
  { codigo: '23', nome: 'GM - Chevrolet' },
  { codigo: '13', nome: 'Citroën' },
]
globalThis.fetch = async (input) => {
  calls++
  const path = new URL(input).pathname
  const code = path.match(/marcas\/(\d+)/)?.[1]
  const brand = catalog.find((item) => item.codigo === code)
  const model = code === '48' ? 'Kwid' : code === '44' ? '208' : code === '13' ? 'C3' : 'Onix'
  let body
  if (path.endsWith('/marcas')) body = catalog
  else if (path.endsWith('/modelos')) body = { modelos: [{ codigo: 1, nome: `${model} 1.0` }] }
  else if (path.endsWith('/anos')) body = [{ codigo: '2022-1', nome: '2022 Gasolina' }]
  else
    body = {
      Valor: 'R$ 71.280,00',
      Marca: wrongBrand ? 'Hyundai' : brand.nome,
      Modelo: `${model} 1.0`,
      AnoModelo: wrongYear ? 2021 : 2022,
      CodigoFipe: '004321-0',
      MesReferencia: 'junho/2026',
    }
  return Response.json(body)
}
try {
  const params = { make: 'Chevrolet', model: 'Onix', year: 2022 }
  const result = await lookupFipePrice(params)
  assert.equal(result.price, 71280)
  const before = calls
  result.price = 1
  assert.equal(
    (await lookupFipePrice({ ...params, make: 'GM' })).price,
    71280,
    'Cache must not expose mutable stored objects',
  )
  assert.equal(calls, before)
  now = Date.parse('2026-07-01T00:01:00Z')
  await lookupFipePrice(params)
  assert(calls > before, 'A reference-month change must invalidate cached prices')
  now += 31 * 86400000
  wrongBrand = true
  assert.equal(
    await lookupFipePrice(params),
    null,
    'Mismatched brand must not be accepted or cached',
  )
  wrongBrand = false
  wrongYear = true
  assert.equal(await lookupFipePrice(params), null)
  wrongYear = false
  assert.equal(
    (await lookupFipePrice({ make: 'Renault', model: 'Kwid', year: 2022 })).brandName,
    'Renault',
  )
  assert.equal(
    (await lookupFipePrice({ make: 'Peugeot', model: '208', year: 2022 })).brandName,
    'Peugeot',
  )
  assert.equal(
    (await lookupFipePrice({ make: 'Citroen', model: 'C3', year: 2022 })).brandName,
    'Citroën',
  )
  assert.equal(await lookupFipePrice({ make: 'Renault', model: 'Kwid Unknown', year: 2022 }), null)
  assert.equal(await lookupFipePrice({ make: 'Unknown', model: 'Onix', year: 2022 }), null)
  globalThis.fetch = async () => {
    throw new Error('offline')
  }
  clearFipeCache()
  assert.equal(await lookupFipePrice(params), null, 'FIPE downtime must not stop automation')
  assert.equal(compareWithFipe(50000, 60000).status, 'below')
  assert.equal(compareWithFipe(61000, 60000).status, 'above')
  console.log('✓ FIPE: catálogo, aliases, expiração, validação de marca/ano e fallback.')
} finally {
  globalThis.fetch = originalFetch
  Date.now = originalNow
  clearFipeCache()
}
