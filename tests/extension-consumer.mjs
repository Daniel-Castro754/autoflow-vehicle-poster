import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8')

async function runConsumer(queue, network = {}) {
  const listeners = { alarms: [] }
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
      onInstalled: {
        addListener: (fn) => {
          listeners.installed = fn
        },
      },
      onStartup: {
        addListener: (fn) => {
          listeners.startup = fn
        },
      },
      onMessage: {
        addListener: (fn) => {
          listeners.message = fn
        },
      },
      getManifest: () => ({ version: 'test' }),
    },
    alarms: {
      get: (_name, callback) => callback(undefined),
      create: () => {},
      onAlarm: {
        addListener: (fn) => {
          listeners.alarms.push(fn)
          listeners.alarm = (alarm) => listeners.alarms.forEach((listener) => listener(alarm))
        },
      },
    },
    tabs: {
      onRemoved: {
        addListener: (fn) => {
          listeners.removed = fn
        },
      },
      create: async (options) => {
        const tab = { id: createdTabs.length + 1, ...options }
        createdTabs.push(tab)
        return tab
      },
      get: (id, callback) =>
        callback({
          id,
          status: 'complete',
          url: `https://www.facebook.com${stored.pendingJob?.document || ''}`,
        }),
      sendMessage: (_id, _message, options, callback) => {
        if (typeof options === 'function') options()
        else callback?.({ active: network.contentActive !== false })
      },
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
          for (const item of Array.isArray(key) ? key : [key]) delete stored[item]
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
    if (String(url).includes('/fill-result')) {
      const outcome = network.fillResults?.shift()
      if (outcome instanceof Error) throw outcome
      return { ok: true, status: 200, json: async () => ({ ok: true, status: 'completed' }) }
    }
    if (String(url).includes('/publish-check')) {
      const status = network.publishStatus || 200
      return {
        ok: status === 200,
        status,
        json: async () => ({ error: 'Publicação não autorizada' }),
      }
    }
    throw new Error(`Unexpected request ${url}`)
  }
  vm.runInNewContext(source, {
    chrome,
    fetch,
    console,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
  })
  await new Promise((resolve) => listeners.message({ type: 'AUTOFLOW_RUN_QUEUE' }, {}, resolve))
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
  const prepare = result.requests.find((request) => request.url.includes('/prepare'))
  assert(prepare)
  assert.equal(result.requests.at(-1).url.endsWith('/22/prepare'), true)
  const sender = {
    tab: { id: 1 },
    frameId: 0,
    url: 'https://www.facebook.com/marketplace/create/vehicle',
    documentId: 'document-22',
  }
  const activity = {
    type: 'AUTOFLOW_EXECUTION_ACTIVITY',
    jobId: 22,
    document: '/marketplace/create/vehicle',
    documentId: 'document-22',
  }
  await new Promise((resolve) =>
    result.listeners.message(activity, { ...sender, documentId: 'other-document' }, resolve),
  )
  assert.equal(
    result.requests.some((request) => request.url.includes('/heartbeat')),
    false,
    'A different document must not renew the lease',
  )
  await new Promise((resolve) => result.listeners.message(activity, sender, resolve))
  const heartbeat = result.requests.find((request) => request.url.includes('/heartbeat'))
  assert(heartbeat, 'An active content-script document should renew its lease')
  assert.deepEqual(JSON.parse(heartbeat.options.body), {
    leaseToken: 'lease-22',
    tabId: 1,
    document: '/marketplace/create/vehicle',
    documentId: 'document-22',
  })
  result.listeners.alarm({ name: 'autoflow-heartbeat' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    result.requests.filter((request) => request.url.includes('/heartbeat')).length,
    1,
    'The periodic worker alarm must not renew a lease without content-script activity',
  )
}

{
  const result = await runConsumer({
    jobs: [{ jobId: 22, jobStatus: 'pending', locked: false, publishUncertain: true }],
  })
  assert.equal(
    result.createdTabs.length,
    0,
    'A publication with unknown outcome must not be retried automatically',
  )
  assert.equal(
    result.requests.some((request) => request.url.includes('/prepare')),
    false,
  )
}

console.log('✓ Queue consumer ignores non-retryable errors and uncertain publications.')

{
  const result = await runConsumer(
    { jobs: [{ jobId: 22, jobStatus: 'pending' }] },
    {
      fillResults: [new Error('offline'), new Error('offline')],
      publishStatus: 409,
    },
  )
  result.stored.autoRun = false
  const execution = (id) => ({
    jobId: id,
    leaseToken: `lease-${id}`,
    tabId: id,
    document: '/marketplace/create/vehicle',
    documentId: `document-${id}`,
  })
  const sender = (id) => ({
    tab: { id },
    frameId: 0,
    url: 'https://www.facebook.com/marketplace/create/vehicle',
    documentId: `document-${id}`,
  })
  const send = (message, id) =>
    new Promise((resolve) => result.listeners.message(message, sender(id), resolve))
  for (const id of [22, 33]) {
    result.stored.pendingJob = execution(id)
    const response = await send(
      {
        type: 'AUTOFLOW_FILL_RESULT',
        jobId: id,
        document: '/marketplace/create/vehicle',
        report: { published: true, publishAttempted: true },
      },
      id,
    )
    assert.equal(response.ok, false)
    assert.equal(
      result.stored.pendingResults[`${id}:lease-${id}`].payload.documentId,
      `document-${id}`,
    )
  }
  assert.equal(
    Object.keys(result.stored.pendingResults).length,
    2,
    'Different executions must not overwrite unsent results',
  )
  result.stored.pendingJob = execution(44)
  result.stored.pendingPublishes = { 44: { ...execution(44), report: {} } }
  for (const entry of Object.values(result.stored.pendingResults))
    entry.lastAttemptAt = entry.queuedAt = 0
  result.listeners.alarm({ name: 'autoflow-heartbeat' })
  for (let attempt = 0; attempt < 40 && Object.keys(result.stored.pendingResults).length; attempt++)
    await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    Object.keys(result.stored.pendingResults).length,
    0,
    'The alarm must deliver the outbox without the original tabs',
  )
  assert.equal(
    result.stored.pendingJob.jobId,
    44,
    'Acknowledging old results must preserve the current execution',
  )
  assert.ok(result.stored.pendingPublishes[44])
  const deliveries = result.requests.filter((request) => request.url.includes('/fill-result'))
  assert.equal(deliveries.length, 4)
  assert.deepEqual(
    deliveries.map((request) => JSON.parse(request.options.body).leaseToken),
    ['lease-22', 'lease-33', 'lease-22', 'lease-33'],
  )
  const denied = await send({ type: 'AUTOFLOW_PUBLISH_CHECK', jobId: 44 }, 44)
  assert.equal(denied.ok, false)
  assert.equal(
    result.requests.filter((request) => request.url.includes('/publish-check')).length,
    1,
    'HTTP rejection must not be retried as a transport error',
  )
}
console.log(
  '✓ Durable results retain execution identity; stale acknowledgements preserve the next job.',
)

{
  const result = await runConsumer({ jobs: [{ jobId: 22, jobStatus: 'pending' }] })
  result.stored.autoRun = false
  result.stored.pendingPublishes = {
    22: { jobId: 22, leaseToken: 'lease-22', tabId: 1, report: { publishAttempted: true } },
  }
  result.stored.pendingResults = { '22:lease-22': { payload: { published: true } } }
  result.listeners.removed(999)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    result.stored.pendingJob.jobId,
    22,
    'Closing another tab must not release the active job',
  )
  result.listeners.removed(1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(result.stored.pendingJob, undefined)
  assert(result.stored.pendingPublishes[22], 'Closing a tab must retain publication evidence')
  assert(result.stored.pendingResults['22:lease-22'], 'Closing a tab must retain unsent results')
  assert.equal(result.listeners.alarms.length, 1)
}
console.log('✓ Fechamento de aba preserva evidências e resultados; alarme único.')

{
  const result = await runConsumer(
    { jobs: [{ jobId: 22, jobStatus: 'pending' }] },
    { contentActive: false },
  )
  result.stored.autoRun = false
  result.stored.pendingPublishes = { 22: { jobId: 22, report: { publishAttempted: true } } }
  result.listeners.alarm({ name: 'autoflow-heartbeat' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    result.stored.pendingJob,
    undefined,
    'An invalidated content context must not block the autonomous queue forever',
  )
  assert(result.stored.pendingPublishes[22])
  assert(
    !result.requests.some((request) => request.url.includes('/heartbeat')),
    'A liveness probe is not a lease heartbeat',
  )
}
