import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const tempRoot = mkdtempSync(join(tmpdir(), 'autoflow-extension-recovery-'))
const scriptPath = join(tempRoot, 'scripts', 'build-extension.mjs')

function build() {
  const run = spawnSync(process.execPath, [scriptPath], {
    cwd: tempRoot,
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr)
}

try {
  mkdirSync(join(tempRoot, 'scripts'))
  mkdirSync(join(tempRoot, 'extension'))
  cpSync(join(sourceRoot, 'scripts', 'build-extension.mjs'), scriptPath)
  writeFileSync(join(tempRoot, 'package.json'), '{"type":"module"}')
  writeFileSync(join(tempRoot, 'extension', 'manifest.json'), '{"version":"1.0.0"}')
  writeFileSync(join(tempRoot, 'extension', 'content.js'), 'old content')

  build()
  const out = join(tempRoot, 'dist', 'extension')
  const zip = join(tempRoot, 'dist', 'autoflow-extension-v1.0.0.zip')
  assert.equal(readFileSync(join(out, 'content.js'), 'utf8'), 'old content')
  assert.ok(readFileSync(zip).subarray(0, 4).equals(Buffer.from('504b0304', 'hex')))

  // A failed prepare (invalid source manifest) must leave both installed
  // artifacts untouched.
  writeFileSync(join(tempRoot, 'extension', 'manifest.json'), '{invalid json')
  const failed = spawnSync(process.execPath, [scriptPath], {
    cwd: tempRoot,
    encoding: 'utf8',
  })
  assert.notEqual(failed.status, 0)
  assert.equal(readFileSync(join(out, 'content.js'), 'utf8'), 'old content')
  assert.ok(existsSync(zip))
  writeFileSync(join(tempRoot, 'extension', 'manifest.json'), '{"version":"1.0.0"}')

  // Simulate a crash after the old unpacked extension was moved aside.
  const previous = join(tempRoot, 'dist', '.autoflow-extension-previous')
  renameSync(out, previous)
  writeFileSync(join(tempRoot, 'dist', '.autoflow-extension-build-pending'), 'pending')
  writeFileSync(join(tempRoot, 'extension', 'content.js'), 'new content')
  build()
  assert.equal(readFileSync(join(out, 'content.js'), 'utf8'), 'new content')
  assert.ok(existsSync(zip))
  assert.equal(existsSync(previous), false)
  assert.equal(existsSync(join(tempRoot, 'dist', '.autoflow-extension-build-pending')), false)
  console.log('OK: extension build staging, recovery and ZIP verified.')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
