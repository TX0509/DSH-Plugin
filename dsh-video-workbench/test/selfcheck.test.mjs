import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import {
  MEDIA_PATH,
  PING_PATH,
  PROJECTS_PATH,
  SELFCHECK_PATH,
  apply,
  createProject,
  readSelfcheckReport,
  resolveProjectsRoot,
  runSelfcheck,
  writeSelfcheckReport,
} from '../index.js'

/** 2026-11-19 00:21:03 local time. */
const FIXED = new Date(2026, 10, 19, 0, 21, 3)
const ORIGIN = 'http://127.0.0.1:65521'
const TOKEN = 'selfcheck-token'
const NAMES = ['routeMounted', 'tokenRequired', 'mediaProbe', 'projectsRootWritable', 'projectsRoute', 'runtimeReady', 'browserFound', 'ffmpegReady']

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeRoots() {
  const mediaRoot = mkdtempSync(path.join(os.tmpdir(), 'dshvw-sc-media-'))
  const projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'dshvw-sc-projects-'))
  writeFileSync(path.join(mediaRoot, 'test.mp4'), Buffer.alloc(200, 7))
  return { mediaRoot, projectsRoot }
}

function removeRoots(...roots) {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

/** Deterministic fetch double; every request is recorded. */
function fetchStub(handler) {
  const calls = []
  const fetchImpl = async (target, init) => {
    const url = new URL(String(target))
    calls.push({ url, init })
    return handler(url, init)
  }
  return { fetchImpl, calls }
}

function happyHandler(overrides = {}) {
  return (url) => {
    if (url.pathname === PING_PATH) {
      if (url.searchParams.get('t') === null) return json(401, { error: 'unauthorized' })
      return json(200, {
        ok: true,
        mediaRootExists: true,
        requireToken: overrides.requireToken ?? true,
        projects: 'ready',
      })
    }
    if (url.pathname === MEDIA_PATH) {
      return new Response('', { status: 206, headers: { 'content-range': 'bytes 0-99/200' } })
    }
    if (url.pathname === PROJECTS_PATH) {
      const file = url.searchParams.get('path') ?? ''
      return json(200, { id: file.split('/')[0] })
    }
    return json(404, { error: 'not-found' })
  }
}

/**
 * A fake installed runtime + Chrome so `apply()` sees a ready M2 environment on
 * any machine. Files only matter for `existsSync`; nothing is executed here.
 */
function fakeRuntime() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dshvw-runtime-'))
  const cli = path.join(dir, 'node_modules', 'hyperframes', 'dist', 'cli.js')
  mkdirSync(path.dirname(cli), { recursive: true })
  writeFileSync(cli, '', 'utf8')
  const ffmpeg = path.join(dir, 'ffmpeg.exe')
  const ffprobe = path.join(dir, 'ffprobe.exe')
  const chrome = path.join(dir, 'chrome.exe')
  for (const file of [ffmpeg, ffprobe, chrome]) writeFileSync(file, '', 'utf8')
  writeFileSync(path.join(dir, 'supplied.json'), JSON.stringify({
    schemaVersion: 1,
    installedAt: new Date().toISOString(),
    versions: { hyperframes: '0.6.33', ffmpegStatic: '5.2.0', ffprobeStatic: '3.1.0' },
    binaries: { cli, ffmpeg, ffprobe },
  }, null, 2), 'utf8')
  return { dir, chrome }
}

const FAKE_RUNTIME = fakeRuntime()
after(() => rmSync(FAKE_RUNTIME.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))

function options(roots, fetchImpl, extra = {}) {
  return {
    getOrigin: () => ORIGIN,
    token: TOKEN,
    requireToken: true,
    mediaRoot: roots.mediaRoot,
    projects: resolveProjectsRoot(roots.projectsRoot),
    fetchImpl,
    timeoutMs: 2000,
    // A ready runtime + a browser so the M2 checks pass unless a test overrides them.
    runtime: {
      state: 'ready',
      cliExists: true,
      ffmpegExists: true,
      ffprobeExists: true,
      browser: { source: 'program-files' },
    },
    ...extra,
  }
}

function assertShape(result) {
  assert.equal(typeof result.ok, 'boolean')
  assert.ok(Array.isArray(result.checks))
  assert.equal(result.checks.length, NAMES.length)
  assert.deepEqual(result.checks.map((check) => check.name), NAMES)
  for (const check of result.checks) {
    assert.equal(typeof check.ok, 'boolean')
    assert.equal(typeof check.detail, 'string')
    assert.ok(check.detail.length > 0)
  }
  assert.equal(result.ok, result.checks.every((check) => check.ok))
}

test('runSelfcheck: every check passes against a healthy plugin', async () => {
  const roots = makeRoots()
  try {
    const created = createProject(roots.projectsRoot, { title: '自检项目' }, { now: FIXED })
    assert.equal(created.ok, true)
    const { fetchImpl, calls } = fetchStub(happyHandler())
    const result = await runSelfcheck(options(roots, fetchImpl))
    assertShape(result)
    assert.deepEqual(result.checks.map((check) => check.ok), NAMES.map(() => true))
    assert.deepEqual(result.checks.map((check) => check.name), NAMES)

    const mediaCall = calls.find((entry) => entry.url.pathname === MEDIA_PATH)
    assert.equal(mediaCall.init.headers.Range, 'bytes=0-99')
    assert.ok(mediaCall.url.searchParams.get('t') === TOKEN)
    assert.ok(calls.some((entry) => entry.url.pathname === PROJECTS_PATH
      && entry.url.searchParams.get('path') === `${created.project.id}/project.json`))
  } finally {
    removeRoots(roots.mediaRoot, roots.projectsRoot)
  }
})

test('runSelfcheck: missing origin fails every HTTP check but not the writable probe', async () => {
  const roots = makeRoots()
  try {
    const { fetchImpl } = fetchStub(happyHandler())
    const result = await runSelfcheck(options(roots, fetchImpl, { getOrigin: () => undefined }))
    assertShape(result)
    assert.equal(result.ok, false)
    assert.deepEqual(
      result.checks.map((check) => check.ok),
      [false, false, false, true, true, true, true, true],
      'the writable probe needs no origin, the project probe skips when no project exists, and the runtime checks are local',
    )
    assert.match(result.checks.find((check) => check.name === 'routeMounted').detail, /origin/u)
  } finally {
    removeRoots(roots.mediaRoot, roots.projectsRoot)
  }
})

test('runSelfcheck: an anonymous ping answering 200 means the route is not ours', async () => {
  const roots = makeRoots()
  try {
    const handler = (url) => {
      if (url.pathname === PING_PATH) return json(200, { ok: true })
      return happyHandler()(url)
    }
    const { fetchImpl } = fetchStub(handler)
    const result = await runSelfcheck(options(roots, fetchImpl))
    assertShape(result)
    const byName = Object.fromEntries(result.checks.map((check) => [check.name, check]))
    assert.equal(byName.routeMounted.name, 'routeMounted')
    assert.equal(byName.routeMounted.ok, false)
    assert.match(byName.routeMounted.detail, /401/u)
    assert.equal(byName.tokenRequired.ok, false)
  } finally {
    removeRoots(roots.mediaRoot, roots.projectsRoot)
  }
})

test('runSelfcheck: tokenRequired compares the ping response with the config', async () => {
  const roots = makeRoots()
  try {
    const { fetchImpl } = fetchStub(happyHandler({ requireToken: false }))
    const result = await runSelfcheck(options(roots, fetchImpl))
    assertShape(result)
    const byName = Object.fromEntries(result.checks.map((check) => [check.name, check]))
    assert.equal(byName.routeMounted.ok, true)
    assert.equal(byName.tokenRequired.ok, false)
    assert.match(byName.tokenRequired.detail, /requireToken=true/u)
  } finally {
    removeRoots(roots.mediaRoot, roots.projectsRoot)
  }
})

test('runSelfcheck: a 404 media probe is reported with the expected status', async () => {
  const roots = makeRoots()
  try {
    const handler = (url) => {
      if (url.pathname === MEDIA_PATH) return json(404, { error: 'not-found' })
      return happyHandler()(url)
    }
    const { fetchImpl } = fetchStub(handler)
    const result = await runSelfcheck(options(roots, fetchImpl))
    assertShape(result)
    const media = result.checks.find((check) => check.name === 'mediaProbe')
    assert.equal(media.ok, false)
    assert.match(media.detail, /206/u)
    assert.match(media.detail, /test\.mp4/u)
  } finally {
    removeRoots(roots.mediaRoot, roots.projectsRoot)
  }
})

test('runSelfcheck: unconfigured projectsRoot is skipped, not failed', async () => {
  const roots = makeRoots()
  try {
    const { fetchImpl } = fetchStub(happyHandler())
    const result = await runSelfcheck(options(roots, fetchImpl, { projects: { state: 'unset' } }))
    assertShape(result)
    const byName = Object.fromEntries(result.checks.map((check) => [check.name, check]))
    assert.equal(byName.projectsRootWritable.ok, true)
    assert.equal(byName.projectsRootWritable.skipped, true)
    assert.match(byName.projectsRootWritable.detail, /未配置/u)
    assert.equal(byName.projectsRoute.ok, true)
    assert.equal(byName.projectsRoute.skipped, true)
    // An unset optional feature must not make the whole report fail.
    assert.equal(result.ok, true)
  } finally {
    removeRoots(roots.mediaRoot, roots.projectsRoot)
  }
})

test('runSelfcheck: an invalid projectsRoot is a real failure', async () => {
  const roots = makeRoots()
  try {
    const { fetchImpl } = fetchStub(happyHandler())
    const result = await runSelfcheck(options(roots, fetchImpl, {
      projects: { state: 'invalid', detail: 'projectsRoot 不可用（EACCES）' },
    }))
    assertShape(result)
    const byName = Object.fromEntries(result.checks.map((check) => [check.name, check]))
    assert.equal(byName.projectsRootWritable.ok, false)
    assert.equal(byName.projectsRootWritable.skipped, undefined)
    assert.equal(result.ok, false)
  } finally {
    removeRoots(roots.mediaRoot, roots.projectsRoot)
  }
})

test('runSelfcheck: mediaProbePath overrides the probed file', async () => {
  const roots = makeRoots()
  try {
    const { fetchImpl, calls } = fetchStub(happyHandler())
    const result = await runSelfcheck(options(roots, fetchImpl, { mediaProbePath: 'custom/clip.mp4' }))
    assertShape(result)
    assert.equal(result.checks.find((check) => check.name === 'mediaProbe').ok, true)
    const mediaCall = calls.find((entry) => entry.url.pathname === MEDIA_PATH)
    assert.equal(mediaCall.url.searchParams.get('path'), 'custom/clip.mp4')
  } finally {
    removeRoots(roots.mediaRoot, roots.projectsRoot)
  }
})

test('runSelfcheck: an already-aborted signal cancels every check', async () => {
  const roots = makeRoots()
  try {
    const { fetchImpl, calls } = fetchStub(happyHandler())
    const controller = new AbortController()
    controller.abort()
    const result = await runSelfcheck(options(roots, fetchImpl, { signal: controller.signal }))
    assertShape(result)
    assert.equal(result.ok, false)
    assert.equal(calls.length, 0)
    for (const check of result.checks) {
      assert.equal(check.ok, false)
      assert.match(check.detail, /取消/u)
    }
  } finally {
    removeRoots(roots.mediaRoot, roots.projectsRoot)
  }
})

test('runSelfcheck: aborting mid-run stops the remaining requests', async () => {
  const roots = makeRoots()
  try {
    const controller = new AbortController()
    // Abort while the media probe is in flight.
    const handler = (url, init) => {
      if (url.pathname === MEDIA_PATH) {
        controller.abort()
        throw new Error('aborted')
      }
      return happyHandler()(url, init)
    }
    const { fetchImpl, calls } = fetchStub(handler)
    const result = await runSelfcheck(options(roots, fetchImpl, { signal: controller.signal }))
    assertShape(result)
    assert.equal(result.ok, false)
    assert.equal(calls.some((entry) => entry.url.pathname === PROJECTS_PATH), false)
  } finally {
    removeRoots(roots.mediaRoot, roots.projectsRoot)
  }
})

test('runSelfcheck: projectsRoute skips the read probe when no project exists', async () => {
  const roots = makeRoots()
  try {
    const { fetchImpl, calls } = fetchStub(happyHandler())
    const result = await runSelfcheck(options(roots, fetchImpl))
    assertShape(result)
    assert.equal(result.ok, true)
    assert.match(result.checks.find((check) => check.name === 'projectsRoute').detail, /跳过/u)
    assert.equal(calls.some((entry) => entry.url.pathname === PROJECTS_PATH), false)
  } finally {
    removeRoots(roots.mediaRoot, roots.projectsRoot)
  }
})

test('runSelfcheck: every call carries the token and stays on the given origin', async () => {
  const roots = makeRoots()
  try {
    createProject(roots.projectsRoot, { title: '自检项目' }, { now: FIXED })
    const { fetchImpl, calls } = fetchStub(happyHandler())
    await runSelfcheck(options(roots, fetchImpl))
    assert.ok(calls.length >= 3)
    for (const entry of calls) {
      assert.equal(entry.url.origin, ORIGIN)
      // The anonymous ping deliberately carries no token.
      const supplied = entry.url.searchParams.get('t')
      assert.ok(supplied === null || supplied === TOKEN, `unexpected token ${String(supplied)}`)
    }
  } finally {
    removeRoots(roots.mediaRoot, roots.projectsRoot)
  }
})

test('writeSelfcheckReport: atomic JSON report with a timestamp', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dshvw-report-'))
  try {
    const result = {
      ok: true,
      checks: [{ name: 'routeMounted', ok: true, detail: 'ok' }],
    }
    const file = writeSelfcheckReport(dir, result, FIXED)
    assert.equal(path.basename(file), 'selfcheck.json')
    const report = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(report.ranAt, FIXED.toISOString())
    assert.equal(report.ok, true)
    assert.deepEqual(report.checks, result.checks)
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.tmp-')), [])
    assert.deepEqual(readSelfcheckReport(dir), report)
  } finally {
    removeRoots(dir)
  }
})

test('readSelfcheckReport: missing or corrupt reports are undefined', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dshvw-report-'))
  try {
    assert.equal(readSelfcheckReport(dir), undefined)
    writeFileSync(path.join(dir, 'selfcheck.json'), 'not json', 'utf8')
    assert.equal(readSelfcheckReport(dir), undefined)
    writeFileSync(path.join(dir, 'selfcheck.json'), JSON.stringify({ ok: true }), 'utf8')
    assert.equal(readSelfcheckReport(dir), undefined)
  } finally {
    removeRoots(dir)
  }
})

test('apply: the startup selfcheck leaves a report on disk', async () => {
  const roots = makeRoots()
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dshvw-report-'))
  const stub = stubContext()
  apply(stub.ctx, {
    mediaRoot: roots.mediaRoot,
    projectsRoot: roots.projectsRoot,
    runtimeDir: FAKE_RUNTIME.dir,
    chromePath: FAKE_RUNTIME.chrome,
    dataDir,
    selfcheckDelayMs: 10,
  })
  try {
    // No origin in this stub, so the three HTTP checks fail without any network
    // call; the writable probe still passes and the report is written.
    let report
    for (let attempt = 0; attempt < 50 && report === undefined; attempt += 1) {
      report = readSelfcheckReport(dataDir)
      if (report === undefined) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(report, 'expected a report after the startup check ran')
    assert.equal(report.checks.length, NAMES.length)
    assert.equal(report.ok, false)
    assert.equal(report.checks.find((check) => check.name === 'projectsRootWritable').ok, true)
  } finally {
    removeRoots(roots.mediaRoot, roots.projectsRoot, dataDir)
  }
})

test('apply: unloading before the delay cancels the startup selfcheck', async () => {
  const roots = makeRoots()
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dshvw-report-'))
  const disposers = []
  const ctx = {
    logger: { info: () => {}, error: () => {} },
    effect: (callback) => {
      const dispose = callback()
      disposers.push(dispose)
      return dispose
    },
    inject(_dependencies, callback) {
      callback({
        on: () => () => {},
        effect: (effect) => {
          effect()
          return () => {}
        },
        webServer: { register: () => () => {}, getOrigin: () => undefined },
      })
    },
  }
  apply(ctx, {
    mediaRoot: roots.mediaRoot,
    projectsRoot: roots.projectsRoot,
    runtimeDir: FAKE_RUNTIME.dir,
    chromePath: FAKE_RUNTIME.chrome,
    dataDir,
    selfcheckDelayMs: 50,
  })
  try {
    assert.ok(disposers.length > 0, 'expected the selfcheck to be scheduled through ctx.effect')
    for (const dispose of disposers) dispose()
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(readSelfcheckReport(dataDir), undefined, 'an unloaded plugin must not write a report')
  } finally {
    removeRoots(roots.mediaRoot, roots.projectsRoot, dataDir)
  }
})

test('apply: an unwritable data dir logs a redacted failure, not the raw path', async () => {
  const roots = makeRoots()
  // A file where the data dir should be: mkdir inside writeSelfcheckReport fails.
  const badDataDir = path.join(os.tmpdir(), `dshvw-data-file-${process.pid}-${Date.now()}`)
  writeFileSync(badDataDir, 'not a directory', 'utf8')
  const messages = []
  const ctx = {
    logger: { info: (message) => messages.push(message), error: (message) => messages.push(message) },
    effect: (callback) => {
      callback()
      return () => {}
    },
    inject(_dependencies, callback) {
      callback({
        on: () => () => {},
        effect: (effect) => {
          effect()
          return () => {}
        },
        webServer: { register: () => () => {}, getOrigin: () => undefined },
      })
    },
  }
  apply(ctx, {
    mediaRoot: roots.mediaRoot,
    projectsRoot: roots.projectsRoot,
    runtimeDir: FAKE_RUNTIME.dir,
    chromePath: FAKE_RUNTIME.chrome,
    dataDir: badDataDir,
    selfcheckDelayMs: 10,
  })
  try {
    let message
    for (let attempt = 0; attempt < 50 && message === undefined; attempt += 1) {
      message = messages.find((entry) => entry.includes('无法写入 selfcheck 报告'))
      if (message === undefined) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(message, 'expected a write-failure log')
    assert.equal(message.includes(badDataDir), false, 'the raw data dir must not be logged')
    assert.match(message, /EEXIST|ENOTDIR|EACCES|EPERM|unknown/u)
  } finally {
    removeRoots(roots.mediaRoot, roots.projectsRoot)
    rmSync(badDataDir, { force: true })
  }
})

/**
 * Minimal Cordis context: records what apply() registers, and keeps the host
 * effect disposers so a test can unload the plugin.
 */
function stubContext() {
  const routes = []
  const listeners = []
  let origin
  const ctx = {
    logger: { info: () => {}, error: () => {} },
    // The host context itself owns `effect`; the injected web context has its own.
    effect: (callback) => {
      callback()
      return () => {}
    },
    inject(_dependencies, callback) {
      callback({
        on: (name, listener) => {
          listeners.push({ name, listener })
          return () => {}
        },
        effect: (effect) => {
          effect()
          return () => {}
        },
        webServer: {
          register: (route) => {
            routes.push(route)
            return () => {}
          },
          getOrigin: () => origin,
        },
      })
    },
  }
  return { ctx, routes, listeners, setOrigin: (value) => { origin = value } }
}

function tokenOf(listeners) {
  const table = []
  for (const entry of listeners) {
    if (entry.name === 'webserver/index-inject') {
      entry.listener(table, { principal: { kind: 'owner' } })
    }
  }
  return table[0]?.value?.token
}

function call(origin, target) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}${target}`, { agent: false }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString(),
      }))
      response.on('error', reject)
    })
    request.setTimeout(5000, () => request.destroy(new Error('request timed out')))
    request.on('error', reject)
    request.end()
  })
}

test('selfcheck route: every check is green over the real HTTP listener', async () => {
  const roots = makeRoots()
  const stub = stubContext()
  apply(stub.ctx, {
    mediaRoot: roots.mediaRoot,
    projectsRoot: roots.projectsRoot,
    runtimeDir: FAKE_RUNTIME.dir,
    chromePath: FAKE_RUNTIME.chrome,
    selfcheckOnStartup: false,
  })
  const created = createProject(roots.projectsRoot, { title: '真实链路项目' }, { now: FIXED })
  assert.equal(created.ok, true)
  const token = tokenOf(stub.listeners)

  const server = createServer((request, response) => {
    const target = request.url ?? '/'
    const route = stub.routes.find((entry) => target.startsWith(entry.path))
    if (route === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    route.handler(request, response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`
  stub.setOrigin(origin)
  try {
    assert.equal((await call(origin, SELFCHECK_PATH)).status, 401)
    const response = await call(origin, `${SELFCHECK_PATH}?t=${encodeURIComponent(token)}`)
    assert.equal(response.status, 200)
    const result = JSON.parse(response.body)
    assertShape(result)
    assert.equal(result.ok, true, JSON.stringify(result.checks, null, 2))
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    removeRoots(roots.mediaRoot, roots.projectsRoot)
  }
})

// --- M2 runtime checks -----------------------------------------------------

test('runSelfcheck: a missing runtime fails runtimeReady and skips ffmpegReady', async () => {
  const roots = makeRoots()
  try {
    const { fetchImpl } = fetchStub(happyHandler())
    const result = await runSelfcheck(options(roots, fetchImpl, {
      runtime: {
        state: 'missing',
        cliExists: false,
        ffmpegExists: false,
        ffprobeExists: false,
        browser: { source: 'program-files' },
      },
    }))
    assertShape(result)
    const byName = Object.fromEntries(result.checks.map((check) => [check.name, check]))
    assert.equal(byName.runtimeReady.ok, false)
    assert.match(byName.runtimeReady.detail, /未安装/u)
    assert.equal(byName.ffmpegReady.ok, true)
    assert.equal(byName.ffmpegReady.skipped, true)
    assert.equal(byName.browserFound.ok, true)
    assert.equal(result.ok, false)
  } finally {
    removeRoots(roots.mediaRoot, roots.projectsRoot)
  }
})

test('runSelfcheck: a missing browser and missing ffmpeg are separate failures', async () => {
  const roots = makeRoots()
  try {
    const { fetchImpl } = fetchStub(happyHandler())
    const noBrowser = await runSelfcheck(options(roots, fetchImpl, {
      runtime: { state: 'ready', cliExists: true, ffmpegExists: true, ffprobeExists: true },
    }))
    assertShape(noBrowser)
    const withoutBrowser = Object.fromEntries(noBrowser.checks.map((check) => [check.name, check]))
    assert.equal(withoutBrowser.browserFound.ok, false)
    assert.match(withoutBrowser.browserFound.detail, /Chrome/u)

    const noFfmpeg = await runSelfcheck(options(roots, fetchImpl, {
      runtime: {
        state: 'ready',
        cliExists: true,
        ffmpegExists: false,
        ffprobeExists: true,
        browser: { source: 'program-files' },
      },
    }))
    const withoutFfmpeg = Object.fromEntries(noFfmpeg.checks.map((check) => [check.name, check]))
    assert.equal(withoutFfmpeg.ffmpegReady.ok, false)
    assert.match(withoutFfmpeg.ffmpegReady.detail, /ffmpeg/u)
  } finally {
    removeRoots(roots.mediaRoot, roots.projectsRoot)
  }
})
