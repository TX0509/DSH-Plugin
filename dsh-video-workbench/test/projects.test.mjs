import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  PING_PATH,
  PROJECTS_PATH,
  apply,
  createProject,
  listProjects,
  migrateProject,
  persistProject,
  readProject,
  slugFor,
  validateProject,
  writeProject,
} from '../index.js'

/** 2026-11-19 00:21:03 local time. */
const FIXED = new Date(2026, 10, 19, 0, 21, 3)
const FIXED_SLUG = '20261119-002103'

function validProject(overrides = {}) {
  return {
    schemaVersion: 1,
    id: FIXED_SLUG,
    title: '演示项目',
    aspect: '9:16',
    fps: 30,
    style: { theme: 'warm', captionStyle: 'bold' },
    scenes: [{
      id: 's1',
      text: '第一句',
      durationSec: 2.5,
      media: { kind: 'image', asset: 'assets/cover.png' },
      voice: { asset: 'assets/voice/s1.mp3', speed: 1 },
      captions: { enabled: true },
    }],
    ...overrides,
  }
}

function temporaryRoots() {
  return {
    mediaRoot: mkdtempSync(path.join(os.tmpdir(), 'dshvw-media-')),
    projectsRoot: mkdtempSync(path.join(os.tmpdir(), 'dshvw-projects-')),
  }
}

function removeRoots(...roots) {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

/** Minimal Cordis context: records what apply() registers. */
function stubContext() {
  const routes = []
  const messages = []
  const listeners = []
  const ctx = {
    logger: {
      info: (message) => messages.push(message),
      error: (message) => messages.push(message),
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
        },
      })
    },
  }
  return { ctx, routes, messages, listeners }
}

/** Read the token the same way the client does: from index injection. */
function tokenOf(listeners) {
  const table = []
  for (const entry of listeners) {
    if (entry.name === 'webserver/index-inject') {
      entry.listener(table, { principal: { kind: 'owner' } })
    }
  }
  return table[0]?.value?.token
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}

/** One request, one connection: see the note in media.test.mjs. */
function call(origin, target, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}${target}`, { headers, agent: false }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }))
      response.on('error', reject)
    })
    request.setTimeout(5000, () => request.destroy(new Error('request timed out')))
    request.on('error', reject)
    request.end()
  })
}

/** Run the plugin's registered routes over real HTTP, project feature enabled. */
async function withPlugin(run) {
  const { mediaRoot, projectsRoot } = temporaryRoots()
  const stub = stubContext()
  apply(stub.ctx, { mediaRoot, projectsRoot, selfcheckOnStartup: false })
  const token = tokenOf(stub.listeners)
  assert.equal(typeof token, 'string')

  const created = createProject(projectsRoot, { title: '演示项目' }, { now: FIXED })
  assert.equal(created.ok, true, JSON.stringify(created.ok ? {} : created.errors))
  const project = created.project
  writeFileSync(path.join(projectsRoot, project.id, 'renders', 'v1.mp4'), Buffer.alloc(200, 7))

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
  const origin = await listen(server)
  try {
    await run({ origin, token, project, mediaRoot, projectsRoot, stub })
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    removeRoots(mediaRoot, projectsRoot)
  }
}

test('validateProject: accepts a complete project and normalizes it', () => {
  const input = validProject()
  input.scenes[0].media.asset = 'assets\\cover.png'
  const result = validateProject(input)
  assert.equal(result.ok, true)
  assert.equal(result.project.aspect, '9:16')
  assert.equal(result.project.scenes[0].media.asset, 'assets/cover.png')
  assert.deepEqual(result.project.scenes[0].voice, { asset: 'assets/voice/s1.mp3', speed: 1 })
})

test('validateProject: fills documented defaults', () => {
  const input = validProject()
  delete input.aspect
  delete input.scenes[0].voice
  delete input.scenes[0].captions
  const result = validateProject(input)
  assert.equal(result.ok, true)
  assert.equal(result.project.aspect, '9:16')
  assert.deepEqual(result.project.scenes[0].voice, { speed: 1 })
  assert.deepEqual(result.project.scenes[0].captions, { enabled: true })
})

test('validateProject: reports every missing required field', () => {
  const result = validateProject({})
  assert.equal(result.ok, false)
  const text = result.errors.join('\n')
  for (const field of ['schemaVersion', 'id', 'title', 'fps', 'style', 'scenes']) {
    assert.ok(text.includes(field), `expected an error mentioning ${field}`)
  }
})

test('validateProject: rejects out-of-range scalar fields', () => {
  const cases = [
    ['id', { id: 'Bad_ID' }],
    ['title', { title: '   ' }],
    ['aspect', { aspect: '1:1' }],
    ['fps', { fps: 50 }],
    ['style.theme', { style: { theme: '', captionStyle: 'bold' } }],
  ]
  for (const [field, patch] of cases) {
    const result = validateProject(validProject(patch))
    assert.equal(result.ok, false, `expected ${field} to fail`)
    assert.ok(result.errors.join(' | ').includes(field), `expected an error mentioning ${field}`)
  }
  const tooLong = validateProject(validProject({ title: '标'.repeat(81) }))
  assert.equal(tooLong.ok, false)
})

test('validateProject: rejects malformed scenes and media', () => {
  const cases = [
    ['scenes 数量', { scenes: [] }],
    ['scenes[0].id', { scenes: [{ ...validProject().scenes[0], id: 'x1' }] }],
    ['scenes[0].id', { scenes: [{ ...validProject().scenes[0], id: 's01' }] }],
    ['scenes[0].id', { scenes: [{ ...validProject().scenes[0], id: 's1000' }] }],
    ['scenes[0].durationSec', { scenes: [{ ...validProject().scenes[0], durationSec: 0 }] }],
    ['durationSec', { scenes: [{ ...validProject().scenes[0], durationSec: 1.2345 }] }],
    ['media.asset', { scenes: [{ ...validProject().scenes[0], media: { kind: 'none', asset: 'assets/a.png' } }] }],
    ['media.asset', { scenes: [{ ...validProject().scenes[0], media: { kind: 'image', asset: '../secret.png' } }] }],
    ['media.asset', { scenes: [{ ...validProject().scenes[0], media: { kind: 'image', asset: 'C:/x.png' } }] }],
    ['media.asset', { scenes: [{ ...validProject().scenes[0], media: { kind: 'image', asset: 'assets/con.png' } }] }],
    ['voice.speed', { scenes: [{ ...validProject().scenes[0], voice: { speed: 3 } }] }],
  ]
  for (const [field, patch] of cases) {
    const result = validateProject(validProject(patch))
    assert.equal(result.ok, false, `expected ${field} to fail`)
    assert.ok(result.errors.join(' | ').includes(field), `expected an error mentioning ${field}`)
  }
  const tooMany = validateProject(validProject({
    scenes: Array.from({ length: 51 }, (_value, index) => ({
      ...validProject().scenes[0],
      id: `s${index + 1}`,
    })),
  }))
  assert.equal(tooMany.ok, false)
  assert.ok(tooMany.errors.join(' | ').includes('scenes 数量'))
})

test('validateProject: scene ids must be unique', () => {
  const duplicate = validateProject(validProject({
    scenes: [
      { ...validProject().scenes[0], id: 's1' },
      { ...validProject().scenes[0], id: 's1' },
    ],
  }))
  assert.equal(duplicate.ok, false)
  assert.ok(duplicate.errors.join(' | ').includes('唯一'))

  // `s01` is not canonical, so it cannot alias `s1`.
  const alias = validateProject(validProject({
    scenes: [
      { ...validProject().scenes[0], id: 's1' },
      { ...validProject().scenes[0], id: 's01' },
    ],
  }))
  assert.equal(alias.ok, false)

  const distinct = validateProject(validProject({
    scenes: [
      { ...validProject().scenes[0], id: 's0' },
      { ...validProject().scenes[0], id: 's1' },
      { ...validProject().scenes[0], id: 's999' },
    ],
  }))
  assert.equal(distinct.ok, true)
})

test('migrateProject: treats a missing schemaVersion as v1', () => {
  const raw = validProject()
  delete raw.schemaVersion
  const result = migrateProject(raw)
  assert.equal(result.ok, true)
  assert.equal(result.value.schemaVersion, 1)
  // `0` records "the file carried no version"; it is not a real v1 file.
  assert.equal(result.from, 0)
})

test('migrateProject: rejects unknown and non-integer versions', () => {
  for (const version of [2, 99, '1', 1.5]) {
    const result = migrateProject({ ...validProject(), schemaVersion: version })
    assert.equal(result.ok, false, `expected version ${JSON.stringify(version)} to fail`)
    assert.ok(result.errors.join(' ').includes('schemaVersion'))
  }
  assert.equal(migrateProject('not-an-object').ok, false)
})

test('slugFor: local timestamp used as the project id', () => {
  assert.equal(slugFor(FIXED), FIXED_SLUG)
})

test('createProject: creates the project layout and de-duplicates the slug', () => {
  const { projectsRoot } = temporaryRoots()
  try {
    const first = createProject(projectsRoot, { title: '第一条' }, { now: FIXED })
    const second = createProject(projectsRoot, { title: '第二条' }, { now: FIXED })
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(first.project.id, FIXED_SLUG)
    assert.equal(second.project.id, `${FIXED_SLUG}-2`)

    for (const id of [first.project.id, second.project.id]) {
      const dir = path.join(projectsRoot, id)
      assert.deepEqual(
        readdirSync(dir).sort(),
        ['assets', 'composition', 'project.json', 'renders'],
      )
      const stored = JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf8'))
      assert.equal(stored.id, id)
      assert.equal(stored.schemaVersion, 1)
    }
  } finally {
    removeRoots(projectsRoot)
  }
})

test('createProject: an invalid title leaves no directory behind', () => {
  const { projectsRoot } = temporaryRoots()
  try {
    const result = createProject(projectsRoot, { title: '   ' }, { now: FIXED })
    assert.equal(result.ok, false)
    assert.deepEqual(readdirSync(projectsRoot), [])
  } finally {
    removeRoots(projectsRoot)
  }
})

test('createProject: unusable roots are reported, not thrown', () => {
  const { projectsRoot } = temporaryRoots()
  try {
    const filesystemRoot = path.parse(process.cwd()).root
    const refused = createProject(filesystemRoot, { title: 'x' }, { now: FIXED })
    assert.equal(refused.ok, false)
    assert.ok(refused.errors.join(' ').includes('盘符根目录'))

    // A path that exists but is not a directory: ensureProjectRoot throws
    // internally, so this is the case that used to escape as an exception.
    const notADir = path.join(projectsRoot, 'not-a-dir.txt')
    writeFileSync(notADir, 'x', 'utf8')
    const asFile = createProject(notADir, { title: 'x' }, { now: FIXED })
    assert.equal(asFile.ok, false)
    assert.ok(asFile.errors.length > 0)
  } finally {
    removeRoots(projectsRoot)
  }
})

test('writeProject: atomic write leaves no temp file and reads back intact', () => {
  const { projectsRoot } = temporaryRoots()
  try {
    const project = validProject()
    const written = writeProject(projectsRoot, project)
    assert.equal(written.ok, true)
    const dir = path.join(projectsRoot, project.id)
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.tmp-')), [])
    const read = readProject(projectsRoot, project.id)
    assert.equal(read.ok, true)
    assert.deepEqual(read.project, project)
  } finally {
    removeRoots(projectsRoot)
  }
})

test('writeProject: refuses a filesystem root and creates a missing root', () => {
  const { projectsRoot } = temporaryRoots()
  try {
    const project = validProject()
    const filesystemRoot = path.parse(process.cwd()).root
    const refused = writeProject(filesystemRoot, project)
    assert.equal(refused.ok, false)
    assert.ok(refused.errors.join(' ').includes('盘符根目录'))

    const nested = path.join(projectsRoot, 'deep', 'nested')
    const written = writeProject(nested, project)
    assert.equal(written.ok, true)
    assert.equal(readProject(nested, project.id).ok, true)
    // writeProject must leave the same layout createProject does.
    for (const name of ['project.json', 'composition', 'assets', 'renders']) {
      assert.equal(existsSync(path.join(nested, project.id, name)), true, `expected ${name} to exist`)
    }
  } finally {
    removeRoots(projectsRoot)
  }
})

test('writeProject: reports a failed write as a result instead of throwing', () => {
  const { projectsRoot } = temporaryRoots()
  try {
    const project = validProject()
    const nested = path.join(projectsRoot, 'write-failure')
    // A directory where project.json belongs makes the atomic rename fail after
    // the project layout has been created.
    mkdirSync(path.join(nested, project.id, 'project.json'), { recursive: true })

    const written = writeProject(nested, project)
    assert.equal(written.ok, false)
    assert.ok(written.errors.length > 0)
    // The directory pre-existed this call, so it must not be deleted.
    assert.equal(existsSync(path.join(nested, project.id)), true)
  } finally {
    removeRoots(projectsRoot)
  }
})

test('persistProject: removes the directory it created when the write fails', () => {
  const { projectsRoot } = temporaryRoots()
  try {
    const dir = path.join(projectsRoot, 'broken-project')
    mkdirSync(dir)
    mkdirSync(path.join(dir, 'project.json'))

    assert.throws(() => persistProject(dir, validProject(), true))
    assert.equal(existsSync(dir), false, 'the directory created by this call must be removed')
  } finally {
    removeRoots(projectsRoot)
  }
})

test('readProject: reports missing files and an id that disagrees with the directory', () => {
  const { projectsRoot } = temporaryRoots()
  try {
    const created = createProject(projectsRoot, { title: '演示项目' }, { now: FIXED })
    assert.equal(created.ok, true)
    renameSync(
      path.join(projectsRoot, created.project.id),
      path.join(projectsRoot, 'renamed-project'),
    )
    const mismatch = readProject(projectsRoot, 'renamed-project')
    assert.equal(mismatch.ok, false)
    assert.ok(mismatch.errors.join(' ').includes('不一致'))
    assert.equal(readProject(projectsRoot, 'missing-project').ok, false)
  } finally {
    removeRoots(projectsRoot)
  }
})

test('listProjects: newest first and broken projects reported separately', () => {
  const { projectsRoot } = temporaryRoots()
  try {
    const older = createProject(projectsRoot, { title: '旧项目' }, { now: new Date(2026, 10, 18, 9, 0, 0) })
    const newer = createProject(projectsRoot, { title: '新项目' }, { now: FIXED })
    assert.equal(older.ok, true)
    assert.equal(newer.ok, true)

    const brokenDir = path.join(projectsRoot, '20261117-080000')
    mkdirSync(brokenDir)
    writeFileSync(path.join(brokenDir, 'project.json'), '{ broken', 'utf8')

    const listed = listProjects(projectsRoot)
    assert.deepEqual(listed.projects.map((entry) => entry.id), [newer.project.id, older.project.id])
    assert.deepEqual(listed.projects.map((entry) => entry.title), ['新项目', '旧项目'])
    assert.deepEqual(listed.invalid.map((entry) => entry.id), ['20261117-080000'])
  } finally {
    removeRoots(projectsRoot)
  }
})

test('listProjects: same-second collisions sort by attempt number, newest first', () => {
  const { projectsRoot } = temporaryRoots()
  try {
    const ids = []
    for (let index = 0; index < 12; index += 1) {
      const created = createProject(projectsRoot, { title: `项目 ${index}` }, { now: FIXED })
      assert.equal(created.ok, true)
      ids.push(created.project.id)
    }
    const listed = listProjects(projectsRoot)
    assert.equal(listed.projects.length, 12)
    // Plain string order would put `…-2` before `…-10`.
    assert.deepEqual(listed.projects.map((entry) => entry.id), [...ids].reverse())
  } finally {
    removeRoots(projectsRoot)
  }
})

test('projects route: rejects a request without the token', async () => {
  await withPlugin(async ({ origin, project }) => {
    const response = await call(origin, `${PROJECTS_PATH}?path=${encodeURIComponent(`${project.id}/project.json`)}`)
    assert.equal(response.status, 401)
  })
})

test('projects route: serves project.json and answers a render range with 206', async () => {
  await withPlugin(async ({ origin, token, project }) => {
    const file = encodeURIComponent(`${project.id}/project.json`)
    const response = await call(origin, `${PROJECTS_PATH}?path=${file}&t=${token}`)
    assert.equal(response.status, 200)
    assert.match(String(response.headers['content-type']), /application\/json/u)
    assert.equal(JSON.parse(response.body.toString()).id, project.id)

    const render = encodeURIComponent(`${project.id}/renders/v1.mp4`)
    const ranged = await call(origin, `${PROJECTS_PATH}?path=${render}&t=${token}`, {
      headers: { Range: 'bytes=10-19' },
    })
    assert.equal(ranged.status, 206)
    assert.equal(ranged.headers['content-range'], 'bytes 10-19/200')
    assert.equal(ranged.body.length, 10)
  })
})

test('projects route: answers 404 for missing files and 400 for traversal', async () => {
  await withPlugin(async ({ origin, token }) => {
    const missing = await call(origin, `${PROJECTS_PATH}?path=missing-project/project.json&t=${token}`)
    assert.equal(missing.status, 404)
    for (const name of ['../project.json', '20261119-002103/../../x.json', '.project.json.tmp-abc']) {
      const response = await call(origin, `${PROJECTS_PATH}?path=${encodeURIComponent(name)}&t=${token}`)
      assert.equal(response.status, 400, `expected 400 for ${name}`)
    }
  })
})

test('apply: projects route is absent until projectsRoot is configured', async () => {
  const { mediaRoot } = temporaryRoots()
  const stub = stubContext()
  apply(stub.ctx, { mediaRoot, selfcheckOnStartup: false })
  try {
    assert.equal(stub.routes.some((route) => route.path === PROJECTS_PATH), false)
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
    const origin = await listen(server)
    try {
      const ping = await call(origin, `${PING_PATH}?t=${token}`)
      assert.equal(ping.status, 200)
      const body = JSON.parse(ping.body.toString())
      assert.equal(body.projects, 'unset')
      assert.equal((await call(origin, `${PROJECTS_PATH}?path=x&t=${token}`)).status, 404)
    } finally {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    }
  } finally {
    removeRoots(mediaRoot)
  }
})
