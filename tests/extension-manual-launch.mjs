import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const background = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8')
const popup = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8')
const content = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8')

async function fixture({ ready = true, fillAccepted = true, apiError = '' } = {}) {
  const requests = []
  const deliveries = []
  const tabs = []
  const data = {
    token: 'local-token',
    instanceId: 'extension_instance_123',
    activeAccountId: 7,
    autoRun: false,
  }
  const listeners = {}
  const chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener: (listener) => (listeners.message = listener) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      getManifest: () => ({ version: 'test' }),
    },
    alarms: {
      get: (_name, callback) => callback(undefined),
      create: () => {},
      onAlarm: { addListener: () => {} },
    },
    tabs: {
      create: async ({ url }) => {
        const tab = { id: tabs.length + 1, status: 'complete', url }
        tabs.push(tab)
        return tab
      },
      get: (id, callback) => {
        const tab = tabs.find((item) => item.id === id) || null
        callback?.(tab)
        return Promise.resolve(tab)
      },
      sendMessage: (_id, message, callbackOrOptions, callback) => {
        const reply = typeof callbackOrOptions === 'function' ? callbackOrOptions : callback
        deliveries.push(message)
        reply?.(
          message.type === 'AUTOFLOW_MARKETPLACE_SESSION_STATUS'
            ? { ready, blocked: !ready, reason: ready ? '' : 'Login necessário.' }
            : message.type === 'FILL_VEHICLE'
              ? fillAccepted
                ? { ok: true, accepted: true }
                : { ok: false, error: 'O script da página rejeitou o preenchimento.' }
              : { active: false },
        )
      },
      remove: async () => {},
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {}, removeListener: () => {} },
    },
    storage: {
      local: {
        get: (keys, callback) => {
          const value = { ...data }
          callback?.(value)
          return Promise.resolve(value)
        },
        set: (update, callback) => {
          Object.assign(data, update)
          callback?.()
          return Promise.resolve()
        },
        remove: (keys, callback) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]
          callback?.()
          return Promise.resolve()
        },
      },
    },
  }
  const fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options })
    if (String(url).endsWith('/prepare')) {
      return {
        ok: !apiError,
        status: apiError ? 409 : 200,
        json: async () =>
          apiError
            ? { error: apiError }
            : {
                jobId: 42,
                accountId: 7,
                tabId: 1,
                document: '/marketplace/create/vehicle',
                leaseToken: 'lease-for-42',
                vehicle: { year: 2024, make: 'Fiat', model: 'Fastback' },
              },
      }
    }
    throw new Error('Unexpected request: ' + url)
  }
  vm.runInNewContext(background, {
    chrome,
    fetch,
    console,
    URL,
    Response,
    AbortController,
    setTimeout,
    clearTimeout,
  })
  const start = () =>
    new Promise((resolve) =>
      listeners.message(
        {
          type: 'AUTOFLOW_START_MANUAL_JOB',
          jobId: 42,
          accountId: 7,
          instanceId: 'extension_instance_123',
        },
        {},
        resolve,
      ),
    )
  return { start, tabs, requests, deliveries, data, listeners }
}

{
  const f = await fixture()
  const result = await f.start()
  assert.equal(result.ok, true)
  assert.equal(f.tabs.length, 1)
  assert.equal(f.requests.filter((r) => r.url.endsWith('/prepare')).length, 1)
  assert.equal(f.deliveries.filter((m) => m.type === 'FILL_VEHICLE').length, 1)
  assert.equal(f.data.pendingJob?.leaseToken, 'lease-for-42')
  assert.equal(f.data.lastManualLaunchError, undefined)
  const originalTab = {
    tab: { id: 1 },
    frameId: 0,
    url: 'https://www.facebook.com/marketplace/create/vehicle',
  }
  const allowed = await new Promise((resolve) =>
    f.listeners.message({ type: 'AUTOFLOW_GET_RELOAD_JOB' }, originalTab, resolve),
  )
  assert.equal(allowed.task?.jobId, 42)
  const denied = await new Promise((resolve) =>
    f.listeners.message(
      { type: 'AUTOFLOW_GET_RELOAD_JOB' },
      { ...originalTab, tab: { id: 99 } },
      resolve,
    ),
  )
  assert.equal(denied.task, null, 'Other Facebook tabs must not resume this publication')
  const again = await f.start()
  assert.equal(again.ok, false, 'Do not start another tab while the lease is reserved')
  assert.equal(f.tabs.length, 1)
}
{
  const f = await fixture({ ready: false })
  const result = await f.start()
  assert.equal(result.ok, false)
  assert.match(result.error, /Login necessário/)
  assert.equal(f.requests.length, 0)
  assert.equal(f.tabs.length, 1, 'Keep the Facebook login tab open')
  assert.equal(f.data.pendingJob, undefined)
  assert.match(f.data.lastManualLaunchError.message, /Login necessário/)
}
{
  const f = await fixture({ apiError: 'Aguarde o intervalo operacional deste perfil.' })
  const result = await f.start()
  assert.equal(result.ok, false)
  assert.match(result.error, /intervalo operacional/)
  assert.equal(f.data.pendingJob, undefined)
  assert.equal(f.deliveries.filter((m) => m.type === 'FILL_VEHICLE').length, 0)
}
{
  const f = await fixture({ fillAccepted: false })
  const result = await f.start()
  assert.equal(result.ok, false)
  assert.match(result.error, /rejeitou o preenchimento/)
  assert.equal(f.data.pendingJob?.jobId, 42, 'Preserve an acquired lease on delivery failure')
  assert.match(f.data.lastManualLaunchError.message, /rejeitou o preenchimento/)
}
assert(popup.includes("type: 'AUTOFLOW_START_MANUAL_JOB'"))
assert(!popup.includes('chrome.tabs.create('), 'The popup cannot own the tab-creation flow')
assert(popup.includes('showManualLaunchError()'))
assert(content.includes('sendResponse({ ok: true, accepted: true })'))
assert(content.includes('if (task?.jobId) runningJobs.delete(task.jobId)'))
console.log('✓ Extensão: abertura manual durável, rejeição/diagnóstico e reserva preservada.')
