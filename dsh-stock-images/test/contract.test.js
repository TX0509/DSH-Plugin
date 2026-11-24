import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply as hostApply, PACKAGE_NAME, KEY_REFS, __internals as hostInternals } from '../index.js'

const { cacheSearchItems, cachedSearchItem } = hostInternals

/** Minimal Cordis context capturing registrations and effects. */
function createHostContext() {
  const registrations = []
  const effects = []
  const disposed = []
  const ctx = {
    logger: { warn() {}, error() {} },
    get(name) {
      if (name === 'credentials') {
        return {
          async resolve() {
            return undefined
          }
        }
      }
      return undefined
    },
    effect(fn, label) {
      const disposer = fn()
      effects.push(label)
      if (typeof disposer === 'function') disposed.push(disposer)
      return disposer
    },
    tools: {
      register(definition) {
        registrations.push(definition)
        return () => {}
      }
    }
  }
  return { ctx, registrations, effects, disposed }
}

/** Small valid value per tool, for the render contract check. */
const RENDER_FIXTURES = {
  stock_image_search: {
    query: 'x',
    alt_query: '',
    count: 0,
    policy: 'policy',
    results: [],
    providers: [],
    notes: []
  },
  stock_image_download: {
    relative_path: 'stock-images/a.jpg',
    bytes: 1,
    mime: 'image/jpeg',
    width: 1,
    height: 1,
    source: 'wikimedia',
    license: 'CC BY 4.0',
    rights: 'commercial use OK · modification OK · attribution required · risk: medium',
    risk: 'medium',
    rights_notes: [],
    attribution: 'credit',
    attribution_forced: false,
    attribution_file: null,
    attribution_error: null
  },
  stock_image_sources: {
    checked: false,
    providers: [],
    tool_names: [],
    default_directory: 'stock-images',
    max_image_bytes: 1
  }
}

/** A JPEG header: enough for the signature sniffer and the dimension parser. */
function jpegBytes(width = 640, height = 480) {
  const buffer = Buffer.alloc(64, 0)
  buffer.writeUInt8(0xff, 0)
  buffer.writeUInt8(0xd8, 1)
  buffer.writeUInt8(0xff, 2)
  buffer.writeUInt8(0xe0, 3)
  buffer.writeUInt16BE(16, 4)
  buffer.writeUInt8(0xff, 20)
  buffer.writeUInt8(0xc0, 21)
  buffer.writeUInt16BE(17, 22)
  buffer.writeUInt8(8, 24)
  buffer.writeUInt16BE(height, 25)
  buffer.writeUInt16BE(width, 27)
  return buffer
}

/** Compose a fetch Response-like object from bytes or JSON. */
function fakeResponse(body, status = 200) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8')
  return {
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-type'
          ? Buffer.isBuffer(body)
            ? 'image/jpeg'
            : 'application/json'
          : null
      }
    },
    body: null,
    async arrayBuffer() {
      return buffer
    }
  }
}

/** Install a fetch stub that answers by URL matcher, and restore it after. */
async function withFetchStub(routes, run) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    const target = String(url)
    calls.push(target)
    for (const [match, responder] of routes) {
      if (target.includes(match)) return responder(target)
    }
    return fakeResponse({ error: 'unexpected request' }, 500)
  }
  try {
    return await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

test('host apply registers the three tools with a registry-ready shape', () => {
  const { ctx, registrations, effects, disposed } = createHostContext()
  hostApply(ctx)

  assert.equal(registrations.length, 3)
  assert.deepEqual(
    registrations.map((definition) => definition.name).sort(),
    ['stock_image_download', 'stock_image_search', 'stock_image_sources']
  )
  for (const definition of registrations) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 60, 'the description has to teach the model when to use it')
    assert.equal(definition.parameters.type, 'object')
    const required = definition.parameters.required ?? []
    if (definition.name === 'stock_image_search') assert.deepEqual(required, ['query'])
    else if (definition.name === 'stock_image_download') assert.deepEqual(required, ['url'])
    else assert.deepEqual(required, [])
    assert.equal(definition.parameters.additionalProperties, false)
    assert.equal(typeof definition.execute, 'function')
    assert.equal(definition.output.schema.type, 'object')
    assert.equal(typeof definition.output.render, 'function')
    const blocks = definition.output.render({}, RENDER_FIXTURES[definition.name])
    assert.ok(Array.isArray(blocks))
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'text')
    assert.ok(blocks[0].text.length > 0)
  }

  assert.equal(effects.length, 4)
  assert.equal(disposed.length, 4)
  // One of the disposers must drop the process-local search cache, so a
  // disable/unload leaves no validated-download metadata behind.
  cacheSearchItems([
    { downloadUrl: 'https://example.com/a.jpg', source: 'wikimedia', title: 'a', rights: { allowed: true } }
  ])
  for (const disposer of disposed) disposer()
  assert.equal(cachedSearchItem('https://example.com/a.jpg'), undefined)
  for (const disposer of disposed) disposer()
})

test('host tools validate arguments before touching the network', async () => {
  const { ctx, registrations } = createHostContext()
  hostApply(ctx)
  const byName = new Map(registrations.map((definition) => [definition.name, definition]))

  await assert.rejects(() => byName.get('stock_image_search').execute({}, {}), /invalid arguments: query/)
  await assert.rejects(
    () => byName.get('stock_image_search').execute({ query: 'x', sources: ['nope'] }, {}),
    /unknown source/
  )
  await assert.rejects(() => byName.get('stock_image_download').execute({ url: 'http://example.com/a.jpg' }, {}), /https/)
  await assert.rejects(
    () => byName.get('stock_image_download').execute({ url: 'https://example.com/a.jpg' }, {}),
    /rights unverified/
  )

  const sources = await byName.get('stock_image_sources').execute({}, {})
  assert.equal(sources.checked, false)
  assert.equal(sources.providers.length, 5)
  assert.deepEqual(
    [...new Set(sources.providers.filter((provider) => provider.requires_key).map((provider) => provider.key_ref))].sort(),
    [KEY_REFS.pexels, KEY_REFS.pixabay, KEY_REFS.unsplash].sort()
  )
})

test('search returns only policy-approved items and reports what it refused', async () => {
  const { ctx, registrations } = createHostContext()
  hostApply(ctx)
  const search = registrations.find((definition) => definition.name === 'stock_image_search')

  const payload = {
    results: [
      {
        id: 'ok-1',
        title: 'Allowed photo',
        creator: 'Jane Doe',
        license: 'by',
        license_version: '4.0',
        license_url: 'https://creativecommons.org/licenses/by/4.0',
        width: 1600,
        height: 900,
        foreign_landing_url: 'https://example.org/photo-1',
        thumbnail: 'https://93.184.216.34/thumb-1.jpg',
        url: 'https://93.184.216.34/photo-1.jpg',
        attribution: 'Allowed photo by Jane Doe is licensed under CC BY 4.0.'
      },
      {
        id: 'nc-1',
        title: 'Non-commercial photo',
        creator: 'NC Photographer',
        license: 'by-nc',
        license_version: '4.0',
        license_url: 'https://creativecommons.org/licenses/by-nc/4.0',
        width: 1600,
        height: 900,
        url: 'https://93.184.216.34/photo-nc.jpg'
      },
      {
        id: 'nd-1',
        title: 'No-derivatives photo',
        license: 'by-nd',
        license_version: '4.0',
        width: 1600,
        height: 900,
        url: 'https://93.184.216.34/photo-nd.jpg'
      }
    ]
  }

  const value = await withFetchStub([['api.openverse.org', () => fakeResponse(payload)]], () =>
    search.execute({ query: 'test subject', sources: ['openverse'], count: 5 }, {})
  )

  assert.equal(value.count, 1)
  assert.equal(value.results[0].source, 'openverse')
  assert.match(value.results[0].rights, /commercial use OK/)
  assert.equal(value.results[0].risk, 'medium')
  assert.match(value.results[0].attribution, /CC BY 4\.0/)
  assert.match(value.policy, /commercial use and modification allowed/)

  const openverse = value.providers.find((provider) => provider.id === 'openverse')
  assert.equal(openverse.status, 'ok')
  assert.match(openverse.note, /refused/)
  assert.match(openverse.note, /non-commercial/)
  assert.match(openverse.note, /no-derivatives/)

  // Nothing that was refused may later be downloaded.
  const download = registrations.find((definition) => definition.name === 'stock_image_download')
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-stock-images-contract-'))
  try {
    const exec = { agent: { session: { header: { cwd: workspace } } } }
    await assert.rejects(
      () => download.execute({ url: 'https://93.184.216.34/photo-nc.jpg' }, exec),
      /rights unverified/
    )
    await assert.rejects(
      () => download.execute({ url: 'https://93.184.216.34/not-searched.jpg' }, exec),
      /rights unverified/
    )

    const saved = await withFetchStub([['93.184.216.34', () => fakeResponse(jpegBytes(1600, 900))]], () =>
      download.execute({ url: 'https://93.184.216.34/photo-1.jpg', filename: 'allowed-photo' }, exec)
    )
    assert.equal(saved.relative_path, 'stock-images/allowed-photo.jpg')
    assert.equal(saved.mime, 'image/jpeg')
    assert.equal(saved.width, 1600)
    assert.equal(saved.height, 900)
    assert.match(saved.rights, /attribution required/)
    assert.equal(saved.attribution_forced, false)
    assert.equal(saved.attribution_error, null)
    assert.equal(saved.attribution_file, 'stock-images/ATTRIBUTION.md')
    assert.ok((await stat(join(workspace, saved.relative_path))).size > 0)
    assert.match(await readFile(join(workspace, 'stock-images', 'ATTRIBUTION.md'), 'utf8'), /CC BY 4\.0/)

    // Attribution is a license condition: asking to skip it is overridden.
    const forced = await withFetchStub([['93.184.216.34', () => fakeResponse(jpegBytes())]], () =>
      download.execute(
        { url: 'https://93.184.216.34/photo-1.jpg', filename: 'forced', attribution: false },
        exec
      )
    )
    assert.equal(forced.attribution_forced, true)
    assert.equal(forced.attribution_file, 'stock-images/ATTRIBUTION.md')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('a source mismatch is refused even when the result was cached', async () => {
  const { ctx, registrations } = createHostContext()
  hostApply(ctx)
  const search = registrations.find((definition) => definition.name === 'stock_image_search')
  const download = registrations.find((definition) => definition.name === 'stock_image_download')

  const payload = {
    results: [
      {
        id: 'ok-2',
        title: 'Allowed photo',
        license: 'cc0',
        license_version: '1.0',
        license_url: 'https://creativecommons.org/publicdomain/zero/1.0',
        width: 1600,
        height: 900,
        url: 'https://93.184.216.34/photo-2.jpg'
      }
    ]
  }
  await withFetchStub([['api.openverse.org', () => fakeResponse(payload)]], () =>
    search.execute({ query: 'another subject', sources: ['openverse'] }, {})
  )

  const workspace = await mkdtemp(join(tmpdir(), 'dsh-stock-images-contract-'))
  try {
    const exec = { agent: { session: { header: { cwd: workspace } } } }
    await assert.rejects(
      () => download.execute({ url: 'https://93.184.216.34/photo-2.jpg', source: 'pexels' }, exec),
      /belongs to the openverse result/
    )
    // CC0 carries no attribution obligation, so the credit file is optional.
    const saved = await withFetchStub([['93.184.216.34', () => fakeResponse(jpegBytes())]], () =>
      download.execute({ url: 'https://93.184.216.34/photo-2.jpg', attribution: false }, exec)
    )
    assert.equal(saved.attribution_forced, false)
    assert.equal(saved.attribution_file, null)
    assert.match(saved.license, /^CC0/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('the package name is the bundle, client module and config key', () => {
  assert.equal(PACKAGE_NAME, 'dsh-stock-images')
})
