import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

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
const NAMES = ['routeMounted', 'tokenRequired', 'mediaProbe', 'projectsRootWritable', 'projectsRoute']

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

function options(roots, fetchImpl, extra = {}) {
  return {
    getOrigin: () => ORIGIN,
    token: TOKEN,
    requireToken: true,
    mediaRoot: roots.mediaRoot,
    projects: resolveProjectsRoot(roots.projectsRoot),
    fetchImpl,
    timeoutMs: 2000,
    ...extra,
  }
}

function assertShape(result) {
  assert.equal(typeof result.ok, 'boolean')
  assert.ok(Array.isArray(result.checks))
  assert.equal(result.checks.length, 5)
  assert.deepEqual(result.checks.map((check) => check.name), NAMES)
  for (const check of result.checks) {
    assert.equal(typeof check.ok, 'boolean')
    assert.equal(typeof check.detail, 'string')
    assert.ok(check.detail.length > 0)
  }
  assert.equal(result.ok, result.checks.every((check) => check.ok))
}

test('runSelfcheck: all five checks pass against a healthy plugin', async () => {
  const roots = makeRoots()
  try {
    const created = createProject(roots.projectsRoot, { title: '自检项目' }, { now: FIXED })
    assert.equal(created.ok, true)
    const { fetchImpl, calls } = fetchStub(happyHandler())
    const result = await runSelfcheck(options(roots, fetchImpl))
    assertShape(result)
    assert.deepEqual(result.checks.map((check) => check.ok), [true, true, true, true, true])
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
      [false, false, false, true, true],
      'the writable probe needs no origin, and the project probe skips when no project exists',
    )
    assert.match(result.checks[0].detail, /origin/u)
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
    assert.equal(result.checks[0].name, 'routeMounted')
    assert.equal(result.checks[0].ok, false)
    assert.match(result.checks[0].detail, /401/u)
    assert.equal(result.checks[1].ok, false)
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
    assert.equal(result.checks[0].ok, true)
    assert.equal(result.checks[1].name, 'tokenRequired')
    assert.equal(result.checks[1].ok, false)
    assert.match(result.checks[1].detail, /requireToken=true/u)
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

test('runSelfcheck: unconfigured projectsRoot fails both project checks', async () => {
  const roots = makeRoots()
  try {
    const { fetchImpl } = fetchStub(happyHandler())
    const result = await runSelfcheck(options(roots, fetchImpl, { projects: { state: 'unset' } }))
    assertShape(result)
    const byName = Object.fromEntries(result.checks.map((check) => [check.name, check]))
    assert.equal(byName.projectsRootWritable.ok, false)
    assert.match(byName.projectsRootWritable.detail, /unset/u)
    assert.equal(byName.projectsRoute.ok, false)
    assert.equal(result.ok, false)
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
    assert.match(result.checks[4].detail, /跳过/u)
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
    assert.equal(report.checks.length, 5)
    assert.equal(report.ok, false)
    assert.equal(report.checks.find((check) => check.name === 'projectsRootWritable').ok, true)
  } finally {
    removeRoots(roots.mediaRoot, roots.projectsRoot, dataDir)
  }
})

/** Minimal Cordis context: records what apply() registers. */
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

test('selfcheck route: five green checks over the real HTTP listener', async () => {
  const roots = makeRoots()
  const stub = stubContext()
  apply(stub.ctx, {
    mediaRoot: roots.mediaRoot,
    projectsRoot: roots.projectsRoot,
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
