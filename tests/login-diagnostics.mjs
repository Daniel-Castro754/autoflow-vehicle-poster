import assert from 'node:assert/strict'
import { authFetch, readAuthResponse, AuthResponseError } from '../src/auth-api.ts'
import { startTestServer } from './helpers/server.mjs'

const err = (pattern, status) => (error) =>
  error instanceof AuthResponseError && error.status === status && pattern.test(error.message)

await assert.rejects(
  readAuthResponse(new Response('', { status: 502 })),
  err(/resposta vazia.*3333/, 502),
  'Unavailable Vite proxy must show a real connectivity diagnosis',
)
await assert.rejects(
  readAuthResponse(new Response('<html>vite proxy failed</html>', { status: 200 })),
  err(/resposta inválida/, 200),
)
await assert.rejects(
  readAuthResponse(new Response('[]', { status: 200 })),
  err(/formato inesperado/, 200),
)
await assert.rejects(
  readAuthResponse(
    new Response(JSON.stringify({ error: 'E-mail ou senha inválidos.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }),
  ),
  err(/E-mail ou senha inválidos/, 401),
)
await assert.rejects(
  readAuthResponse(new Response('{}', { status: 503 })),
  err(/recusou a operação/, 503),
)
assert.deepEqual(await readAuthResponse(new Response(JSON.stringify({ token: 'test' }))), {
  token: 'test',
})
const oldFetch = globalThis.fetch
try {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed')
  }
  await assert.rejects(
    authFetch('http://127.0.0.1:3333/api/auth/login'),
    err(/Não foi possível conectar à API/, 0),
  )
  globalThis.fetch = async () => {
    const error = new Error('timeout')
    error.name = 'TimeoutError'
    throw error
  }
  await assert.rejects(
    authFetch('http://127.0.0.1:3333/api/auth/google/config'),
    err(/demorou para responder/, 0),
  )
} finally {
  globalThis.fetch = oldFetch
}

const server = await startTestServer()
try {
  const good = await authFetch(`${server.base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: server.email, password: server.password }),
  })
  assert.equal(typeof good.token, 'string')
  assert(good.token.length > 30)
  await assert.rejects(
    authFetch(`${server.base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: server.email, password: 'incorrect' }),
    }),
    err(/E-mail ou senha inválidos/, 401),
  )
  const config = await authFetch(`${server.base}/auth/google/config`)
  assert.deepEqual(config, { enabled: false, clientId: '' })
  console.log(
    '✓ Login: success, invalid credentials, Google configuration and API connectivity errors',
  )
} finally {
  await server.close()
}
