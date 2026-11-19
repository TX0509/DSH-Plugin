import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ALLOW_BUILD_PACKAGES,
  RUNTIME_VERSIONS,
  createRuntimeInstallHandler,
  createRuntimeStateHandler,
  describeRuntime,
  installCommands,
  installRuntime,
  readSupplied,
  runtimePaths,
  runtimeState,
} from '../index.js'

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'dshvw-supply-'))
}

/** Write the version manifests the runtime would have after a pnpm install. */
function fakeInstalled(runtimeDir, versions = {}) {
  const { dir } = { dir: runtimeDir }
  for (const [name, version] of Object.entries({ ...RUNTIME_VERSIONS, ...versions })) {
    const packageDir = path.join(dir, 'node_modules', name)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name, version }), 'utf8')
  }
  const paths = runtimePaths(runtimeDir)
  mkdirSync(path.dirname(paths.cliPath), { recursive: true })
  writeFileSync(paths.cliPath, '', 'utf8')
  const ffmpeg = path.join(runtimeDir, 'ffmpeg.exe')
  const ffprobe = path.join(runtimeDir, 'ffprobe.exe')
  writeFileSync(ffmpeg, '', 'utf8')
  writeFileSync(ffprobe, '', 'utf8')
  return { cli: paths.cliPath, ffmpeg, ffprobe }
}

function okExec(calls) {
  return async (command, args) => {
    calls.push([command, ...args])
    return { status: 0, stdout: 'ok', stderr: '' }
  }
}

test('runtimePaths: every path lives under the runtime dir', () => {
  const paths = runtimePaths('C:/data/runtime')
  for (const value of [paths.packageJson, paths.nodeModules, paths.suppliedFile, paths.lockFile, paths.logFile, paths.cliPath]) {
    assert.equal(path.resolve(value).startsWith(path.resolve('C:/data/runtime')), true, value)
  }
})

test('installCommands: two identical pnpm passes with pinned versions and allow-build list', () => {
  const [first, second] = installCommands('C:/node/node.exe', 'C:/pnpm/bin/pnpm.mjs')
  assert.deepEqual(first, second, 'M0: the second pass is what makes postinstall stick')
  assert.equal(first[0], 'C:/node/node.exe')
  assert.equal(first[1], 'C:/pnpm/bin/pnpm.mjs')
  assert.equal(first[2], 'add')
  for (const [name, version] of Object.entries(RUNTIME_VERSIONS)) {
    assert.ok(first.includes(`${name}@${version}`), `expected ${name}@${version}`)
  }
  for (const name of ALLOW_BUILD_PACKAGES) {
    assert.ok(first.includes(`--allow-build=${name}`), `expected --allow-build=${name}`)
  }
})

test('runtimeState: missing → ready → missing again after the CLI disappears', () => {
  const dir = tempDir()
  try {
    assert.equal(runtimeState(dir), 'missing')
    const binaries = fakeInstalled(dir)
    const paths = runtimePaths(dir)
    writeFileSync(paths.suppliedFile, JSON.stringify({
      schemaVersion: 1,
      installedAt: new Date().toISOString(),
      versions: { hyperframes: '0.6.33', ffmpegStatic: '5.2.0', ffprobeStatic: '3.1.0' },
      binaries,
    }), 'utf8')
    assert.equal(runtimeState(dir), 'ready')
    rmSync(binaries.cli)
    assert.equal(runtimeState(dir), 'missing', 'a stale supplied.json must not claim ready')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('runtimeState: a lock without a result file reports installing', () => {
  const dir = tempDir()
  try {
    const paths = runtimePaths(dir)
    writeFileSync(paths.lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8')
    assert.equal(runtimeState(dir), 'installing')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('readSupplied: malformed or partial results are ignored', () => {
  const dir = tempDir()
  try {
    const paths = runtimePaths(dir)
    for (const body of [
      'not json',
      '{}',
      JSON.stringify({ schemaVersion: 2, installedAt: 'x', versions: {}, binaries: {} }),
      JSON.stringify({ schemaVersion: 1, installedAt: 'x', versions: { hyperframes: '0.6.33' }, binaries: {} }),
    ]) {
      writeFileSync(paths.suppliedFile, body, 'utf8')
      assert.equal(readSupplied(dir), undefined, body)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('installRuntime: runs two pnpm passes, verifies binaries and writes supplied.json', async () => {
  const dir = tempDir()
  try {
    const binaries = fakeInstalled(dir)
    const calls = []
    const result = await installRuntime({
      runtimeDir: dir,
      nodePath: 'C:/node/node.exe',
      pnpmScriptPath: 'C:/pnpm/bin/pnpm.mjs',
      env: { PATH: 'C:/node' },
      exec: okExec(calls),
      resolveBinary: (name) => (name === 'hyperframes' ? binaries.cli : name === 'ffmpeg-static' ? binaries.ffmpeg : binaries.ffprobe),
      now: new Date('2026-11-19T00:00:00.000Z'),
    })
    assert.equal(result.ok, true)
    assert.equal(result.supplied.versions.hyperframes, '0.6.33')
    assert.equal(readSupplied(dir)?.installedAt, '2026-11-19T00:00:00.000Z')
    // 2 pnpm passes + ffmpeg -version + ffprobe -version
    assert.equal(calls.filter((entry) => entry.includes('add')).length, 2)
    assert.equal(calls.filter((entry) => entry.includes('-version')).length, 2)
    assert.equal(existsSync(runtimePaths(dir).lockFile), false, 'the lock must be released')
    assert.match(readFileSync(runtimePaths(dir).logFile, 'utf8'), /运行时就绪/u)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('installRuntime: a failing pnpm pass reports install-failed and releases the lock', async () => {
  const dir = tempDir()
  try {
    const result = await installRuntime({
      runtimeDir: dir,
      nodePath: 'C:/node/node.exe',
      pnpmScriptPath: 'C:/pnpm/bin/pnpm.mjs',
      env: {},
      exec: async () => ({ status: 1, stdout: '', stderr: 'boom' }),
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /install-failed/u)
    assert.match(result.log, /boom/u)
    assert.equal(existsSync(runtimePaths(dir).lockFile), false)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('installRuntime: a live lock makes a second install refuse', async () => {
  const dir = tempDir()
  try {
    const paths = runtimePaths(dir)
    writeFileSync(paths.lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8')
    const result = await installRuntime({
      runtimeDir: dir,
      nodePath: 'C:/node/node.exe',
      pnpmScriptPath: 'C:/pnpm/bin/pnpm.mjs',
      env: {},
      exec: okExec([]),
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'installing')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('installRuntime: a wrong installed version fails instead of recording it', async () => {
  const dir = tempDir()
  try {
    const binaries = fakeInstalled(dir, { hyperframes: '0.6.32' })
    const result = await installRuntime({
      runtimeDir: dir,
      nodePath: 'C:/node/node.exe',
      pnpmScriptPath: 'C:/pnpm/bin/pnpm.mjs',
      env: {},
      exec: okExec([]),
      resolveBinary: (name) => (name === 'hyperframes' ? binaries.cli : name === 'ffmpeg-static' ? binaries.ffmpeg : binaries.ffprobe),
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'version-mismatch')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('describeRuntime: exposes state, versions and browser source, never paths', () => {
  const dir = tempDir()
  try {
    const empty = describeRuntime({ runtimeDir: dir })
    assert.equal(empty.state, 'missing')
    assert.equal(empty.browser, null)

    const binaries = fakeInstalled(dir)
    writeFileSync(runtimePaths(dir).suppliedFile, JSON.stringify({
      schemaVersion: 1,
      installedAt: new Date().toISOString(),
      versions: { hyperframes: '0.6.33', ffmpegStatic: '5.2.0', ffprobeStatic: '3.1.0' },
      binaries,
    }), 'utf8')
    const ready = describeRuntime({ runtimeDir: dir, browserSource: 'program-files' })
    assert.equal(ready.state, 'ready')
    assert.deepEqual(ready.versions, { hyperframes: '0.6.33', ffmpegStatic: '5.2.0', ffprobeStatic: '3.1.0' })
    assert.deepEqual(ready.browser, { source: 'program-files' })
    assert.equal(JSON.stringify(ready).includes(dir), false, 'no filesystem paths in the view')

    const installing = describeRuntime({ runtimeDir: dir, installing: true, lastError: 'install-failed(1)' })
    assert.equal(installing.state, 'ready', 'a ready runtime is not downgraded to installing')
    assert.equal(installing.lastError, 'install-failed(1)')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

// --- runtime routes over real HTTP -----------------------------------------

function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }))
  })
}

function call(origin, target, options = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}${target}`, { method: options.method ?? 'GET', agent: false }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }))
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })
}

test('runtime routes: status needs the token and answers the view', async () => {
  const token = 'runtime-token'
  const handler = createRuntimeStateHandler({
    token,
    requireToken: true,
    status: () => ({ state: 'missing', browser: null }),
    startInstall: () => { throw new Error('must not start on GET') },
  })
  const { server, origin } = await serve((request, response) => handler(request, response))
  try {
    assert.equal((await call(origin, '/api/video-workbench/runtime')).status, 401)
    assert.equal((await call(origin, '/api/video-workbench/runtime?t=wrong')).status, 401)
    const ok = await call(origin, `/api/video-workbench/runtime?t=${token}`)
    assert.equal(ok.status, 200)
    assert.deepEqual(JSON.parse(ok.body), { state: 'missing', browser: null })
    assert.equal((await call(origin, `/api/video-workbench/runtime?t=${token}`, { method: 'POST' })).status, 405)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('runtime routes: install is POST-only, authenticated, and triggers once', async () => {
  const token = 'runtime-token'
  let installs = 0
  const handler = createRuntimeInstallHandler({
    token,
    requireToken: true,
    status: () => ({ state: 'installing', browser: null }),
    startInstall: () => { installs += 1 },
  })
  const { server, origin } = await serve((request, response) => handler(request, response))
  try {
    assert.equal((await call(origin, '/api/video-workbench/runtime/install')).status, 401)
    assert.equal((await call(origin, `/api/video-workbench/runtime/install?t=${token}`)).status, 405)
    assert.equal(installs, 0)
    const response = await call(origin, `/api/video-workbench/runtime/install?t=${token}`, { method: 'POST' })
    assert.equal(response.status, 202)
    assert.equal(JSON.parse(response.body).state, 'installing')
    assert.equal(installs, 1)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})
