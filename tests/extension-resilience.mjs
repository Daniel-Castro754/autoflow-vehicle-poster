import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = (
  await readFile(new URL('../extension-mv2/content.js', import.meta.url), 'utf8')
).replace(/\}\)\(\)\s*$/, 'globalThis.content={runtimeMessage,run,uploadImages};\n})()')
function contentFixture() {
  let count = 0,
    clock = 0,
    removed = 0,
    failSecond = true,
    hold = false
  const uploaded = [],
    requested = []
  class Input {
    multiple = true
    set files(value) {
      this.selected = value
    }
    getAttribute(name) {
      return name === 'accept' ? 'image/jpeg' : null
    }
    dispatchEvent(event) {
      if (event.type === 'change') {
        uploaded.push(...this.selected.map((file) => file.name))
        if (!hold) count += this.selected.length
      }
    }
  }
  class Transfer {
    files = []
    items = { add: (file) => this.files.push(file) }
  }
  class Clock extends Date {
    static now() {
      return clock
    }
  }
  const input = new Input()
  const body = {
    get innerText() {
      return `Fotos ${count}/20`
    },
  }
  const chrome = {
    runtime: {
      id: 'extension-test',
      onMessage: { addListener: () => {} },
      sendMessage(message, callback) {
        requested.push(message.url)
        if (message.url === 'photo-2' && failSecond) {
          failSecond = false
          callback({ ok: false, error: 'offline' })
          return
        }
        callback({
          ok: true,
          dataBase64: Buffer.from('image').toString('base64'),
          mimeType: 'image/jpeg',
        })
      },
    },
    storage: {
      local: {
        get: () => {},
        remove: () => {
          removed++
        },
      },
    },
  }
  const context = {
    chrome,
    window: {},
    location: { pathname: '/marketplace/create/vehicle' },
    document: {
      body,
      querySelectorAll: (selector) => (selector === 'input[type="file"]' ? [input] : []),
    },
    console,
    HTMLInputElement: Input,
    DataTransfer: Transfer,
    File,
    Event,
    Uint8Array,
    atob,
    setTimeout: (fn) => {
      clock += 500
      queueMicrotask(fn)
    },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    Date: Clock,
  }
  vm.runInNewContext(source, context)
  return {
    api: context.content,
    chrome,
    uploaded,
    requested,
    get removed() {
      return removed
    },
    set count(value) {
      count = value
    },
    set hold(value) {
      hold = value
    },
  }
}
{
  const fixture = contentFixture()
  const images = [1, 2, 3].map((id) => ({ url: `photo-${id}`, name: `photo-${id}.jpg` }))
  assert.equal(await fixture.api.uploadImages(images), 1)
  assert.equal(await fixture.api.uploadImages(images), 3)
  assert.deepEqual(
    fixture.uploaded,
    ['photo-1.jpg', 'photo-2.jpg', 'photo-3.jpg'],
    'Resume must preserve order and never upload accepted photos again',
  )
  assert.equal(await fixture.api.uploadImages(images), 3)
  assert.equal(fixture.uploaded.length, 3)
}
{
  const fixture = contentFixture()
  fixture.hold = true
  const images = [{ url: 'photo-1', name: 'photo-1.jpg' }]
  assert.equal(await fixture.api.uploadImages(images), 0)
  assert.equal(await fixture.api.uploadImages(images), 0)
  assert.equal(
    fixture.uploaded.length,
    1,
    'A pending upload with no acknowledgement must not be repeated',
  )
  fixture.count = 1
  assert.equal(await fixture.api.uploadImages(images), 1)
}
{
  const fixture = contentFixture()
  fixture.chrome.runtime.id = undefined
  await assert.rejects(
    () => fixture.api.runtimeMessage({}),
    (error) => error.code === 'CONTEXT_INVALIDATED',
  )
  assert.equal(await fixture.api.run({ jobId: 5 }), false)
  assert.equal(
    fixture.removed,
    0,
    'An invalid content context must not erase background-owned pending work',
  )
  fixture.chrome.runtime.id = 'extension-test'
  fixture.chrome.runtime.sendMessage = () => {
    throw new Error('Extension context invalidated.')
  }
  await assert.rejects(
    () => fixture.api.runtimeMessage({}),
    (error) => error.code === 'CONTEXT_INVALIDATED',
  )
}
console.log(
  '✓ Extensão: retomada ordenada de fotos, upload ambíguo sem duplicação e contexto recarregado.',
)
