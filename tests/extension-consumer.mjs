import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../extension-mv2/background.js', import.meta.url), 'utf8')

async function runConsumer(queue) {
  const listeners = {}
  const stored = {
    autoRun: true,
    activeAccountId: 4,
    token: 'extension-token',
    instanceId: 'worker-1',
  }
  const requests = []
  const createdTabs = []
  const chrome = {
    runtime: {
      lastError: undefined,
      onInstalled: { addListener: fn => { listeners.installed = fn } },
      onStartup: { addListener: fn => { listeners.startup = fn } },
      onMessage: { addListener: fn => { listeners.message = fn } },
      getManifest: () => ({ version: 'test' }),
    },
    alarms: {
      get: (_name, callback) => callback(undefined),
      create: () => {},
      onAlarm: { addListener: fn => { listeners.alarm = fn } },
    },
    tabs: {
      create: async options => {
        const tab = { id: createdTabs.length + 1, ...options }
        createdTabs.push(tab)
        return tab
      },
      get: (id, callback) => callback({ id, status: 'complete', url: `https://www.facebook.com${stored.pendingJob?.document || ''}` }),
      sendMessage: (_id, _message, callback) => callback?.(),
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      remove: async () => {},
    },
    storage: {
      local: {
        get: (_keys, callback) => {
          const result = { ...stored }
          callback?.(result)
          return Promise.resolve(result)
        },
        set: (value, callback) => {
          Object.assign(stored, value)
          callback?.()
          return Promise.resolve()
        },
        remove: (key, callback) => {
          delete stored[key]
          callback?.()
          return Promise.resolve()
        },
      },
    },
  }
  const fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options })
    if (String(url).includes('/extension/queue')) {
      return { ok: true, status: 200, json: async () => queue }
    }
    if (String(url).includes('/prepare')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jobId: 22,
          leaseToken: 'lease-22',
          tabId: 1,
          document: '/marketplace/create/vehicle',
          documentId: 'document-22',
        }),
      }
    }
    if (String(url).includes('/heartbeat')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    throw new Error(`Unexpected request ${url}`)
  }
  vm.runInNewContext(source, { chrome, fetch, console, URL })
  await new Promise(resolve => listeners.message({ type: 'AUTOFLOW_RUN_QUEUE' }, {}, resolve))
  return { requests, createdTabs, listeners, stored }
}

{
  const result = await runConsumer({
    jobs: [
      { jobId: 11, jobStatus: 'error', locked: false, publishUncertain: false },
      { jobId: 22, jobStatus: 'pending', locked: false, publishUncertain: false },
    ],
  })
  assert.equal(result.createdTabs.length, 1)
  const prepare = result.requests.find(request => request.url.includes('/prepare'))
  assert(prepare)
  assert.equal(result.requests.at(-1).url.endsWith('/22/prepare'), true)
  const sender = { tab: { id: 1 }, frameId: 0, url: 'https://www.facebook.com/marketplace/create/vehicle', documentId: 'document-22' }
  const activity = { type: 'AUTOFLOW_EXECUTION_ACTIVITY', jobId: 22, document: '/marketplace/create/vehicle', documentId: 'document-22' }
  await new Promise(resolve => result.listeners.message(activity, { ...sender, documentId: 'other-document' }, resolve))
  assert.equal(result.requests.some(request => request.url.includes('/heartbeat')), false, 'A different document must not renew the lease')
  await new Promise(resolve => result.listeners.message(activity, sender, resolve))
  const heartbeat = result.requests.find(request => request.url.includes('/heartbeat'))
  assert(heartbeat, 'An active content-script document should renew its lease')
  assert.deepEqual(JSON.parse(heartbeat.options.body), {
    leaseToken: 'lease-22',
    tabId: 1,
    document: '/marketplace/create/vehicle',
    documentId: 'document-22',
  })
  result.listeners.alarm({ name: 'autoflow-heartbeat' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(result.requests.filter(request => request.url.includes('/heartbeat')).length, 1, 'The periodic worker alarm must not renew a lease without content-script activity')
}

{
  const result = await runConsumer({
    jobs: [{ jobId: 22, jobStatus: 'pending', locked: false, publishUncertain: true }],
  })
  assert.equal(result.createdTabs.length, 0, 'A publication with unknown outcome must not be retried automatically')
  assert.equal(result.requests.some(request => request.url.includes('/prepare')), false)
}

console.log('✓ Queue consumer ignores non-retryable errors and uncertain publications.')
