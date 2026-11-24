import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import { KEY_REFS, PACKAGE_NAME } from '../index.js'

/** Capture the lazy factory the loader receives. */
let loaded
globalThis.window = {
  __ModuleLoader__: {
    load(specification) {
      loaded = specification
    }
  }
}

/** Minimal React stand-in: the factory only reads hooks and createElement. */
const fakeReact = {
  createElement() {
    return null
  },
  useCallback(fn) {
    return fn
  },
  useEffect() {},
  useMemo(fn) {
    return fn()
  },
  useState(initial) {
    return [initial, function set() {}]
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot()
  }
}

await import('../client.js')

const client = loaded.factory(function require(name) {
  if (name === 'react') return fakeReact
  throw new Error(`unexpected require: ${name}`)
})

const { DICT, KEY_ROWS, KEYLESS_ROWS, translate, normalizeLang, createCredentialsAccess } = client.__internals

test('client registers under the package name and needs the slot service', () => {
  assert.equal(loaded.id, PACKAGE_NAME)
  assert.deepEqual(client.inject, ['slots'])
  assert.equal(typeof client.apply, 'function')
})

test('both UI dictionaries carry exactly the same keys', () => {
  const zhKeys = Object.keys(DICT.zh).sort()
  const enKeys = Object.keys(DICT.en).sort()
  assert.deepEqual(zhKeys, enKeys)
  for (const key of zhKeys) {
    assert.equal(typeof DICT.zh[key], 'string')
    assert.equal(typeof DICT.en[key], 'string')
    assert.notEqual(DICT.zh[key].trim(), '')
    assert.notEqual(DICT.en[key].trim(), '')
  }
})

test('translate interpolates placeholders and falls back to English', () => {
  assert.equal(translate('zh', 'summary', { configured: 2, total: 3 }), '2 / 3 个 Key 已配置，另有 2 个免 Key 图库可直接使用。')
  assert.equal(translate('en', 'summary', { configured: 2, total: 3 }), '2 of 3 keys configured, plus 2 key-free libraries ready to use.')
  assert.equal(translate('de', 'save'), 'Save')
  assert.equal(translate('zh', 'missing-key'), 'missing-key')
})

test('normalizeLang maps locale ids onto the two dictionaries', () => {
  assert.equal(normalizeLang('zh'), 'zh')
  assert.equal(normalizeLang('zh-CN'), 'zh')
  assert.equal(normalizeLang('en-US'), 'en')
  assert.equal(normalizeLang('ja'), 'en')
  assert.equal(normalizeLang(''), '')
  assert.equal(normalizeLang(undefined), '')
})

test('the card lists the same credential refs the Host reads', () => {
  assert.equal(KEY_ROWS.length, 3)
  const refs = KEY_ROWS.map((row) => row.ref)
  assert.deepEqual(refs, [KEY_REFS.pexels, KEY_REFS.pixabay, KEY_REFS.unsplash])
  for (const row of KEY_ROWS) {
    assert.match(row.applyUrl, /^https:\/\//)
    assert.equal(typeof row.note.zh, 'string')
    assert.equal(typeof row.note.en, 'string')
  }
  assert.deepEqual(
    KEYLESS_ROWS.map((row) => row.id),
    ['openverse', 'wikimedia']
  )
})

test('credential access forwards the modern remote namespace', async () => {
  const calls = []
  const remote = {
    async describe(refs) {
      calls.push(['describe', refs])
      return { ok: true, value: { PEXELS_API_KEY: { configured: true, masked: 'PE…1234', source: 'stored', writable: true } } }
    },
    async set(ref, value) {
      calls.push(['set', ref, value])
      return { ok: true }
    },
    async unset(ref) {
      calls.push(['unset', ref])
      return { ok: true }
    }
  }
  const ctx = { get: (name) => (name === 'remote.credentials' ? remote : undefined) }
  const access = createCredentialsAccess(ctx)
  assert.equal(access.available(), true)
  const described = await access.describe(['PEXELS_API_KEY'])
  assert.equal(described.ok, true)
  assert.equal(described.value.PEXELS_API_KEY.masked, 'PE…1234')
  assert.deepEqual(await access.set('PEXELS_API_KEY', 'abc'), { ok: true })
  assert.deepEqual(await access.unset('PEXELS_API_KEY'), { ok: true })
  assert.deepEqual(calls, [
    ['describe', ['PEXELS_API_KEY']],
    ['set', 'PEXELS_API_KEY', 'abc'],
    ['unset', 'PEXELS_API_KEY']
  ])
})

test('credential access reports an unavailable service instead of throwing', async () => {
  const access = createCredentialsAccess({ get: () => undefined })
  assert.equal(access.available(), false)
  assert.deepEqual(await access.describe(['X']), { ok: false, value: {} })
  const failed = await access.set('X', 'v')
  assert.equal(failed.ok, false)
  assert.match(failed.error.message, /unavailable/)
})

test('credential access keeps provider error messages', async () => {
  const ctx = {
    get: (name) =>
      name === 'remote.credentials'
        ? {
            async describe() {
              return { ok: false, error: { message: 'provider refused' } }
            },
            async set() {
              return { ok: false, error: { message: 'value rejected by the store' } }
            }
          }
        : undefined
  }
  const access = createCredentialsAccess(ctx)
  const described = await access.describe(['X'])
  assert.equal(described.ok, false)
  const failed = await access.set('X', 'v')
  assert.equal(failed.ok, false)
  assert.equal(failed.error.message, 'value rejected by the store')
})

test('locale resources carry localized manager metadata', async () => {
  const zh = JSON.parse(await readFile(new URL('../locale/zh.json', import.meta.url), 'utf8'))
  const en = JSON.parse(await readFile(new URL('../locale/en.json', import.meta.url), 'utf8'))
  for (const locale of [zh, en]) {
    assert.equal(typeof locale.meta.title, 'string')
    assert.equal(typeof locale.meta.description, 'string')
    assert.ok(locale.meta.title.length > 0)
    assert.ok(locale.meta.description.length > 0)
  }
  assert.notEqual(zh.meta.title, en.meta.title)
})


test('client apply registers the settings card and releases every resource', () => {
  const slotInjectCalls = []
  const registrations = []
  const effects = []
  const injectCleanups = []
  const localeRegistrations = []
  let localeUnsubscribeCalls = 0

  const previousDocument = globalThis.document
  const previousObserver = globalThis.MutationObserver
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const removedStyles = []
  const observerDisconnects = []

  globalThis.document = {
    documentElement: { getAttribute: () => 'zh-CN', lang: 'zh-CN' },
    head: { appendChild(node) { node.dataset.plugin = 'dsh-stock-images' } },
    createElement() {
      return {
        dataset: {},
        style: {},
        textContent: '',
        remove() {
          removedStyles.push(true)
        }
      }
    }
  }
  globalThis.MutationObserver = class {
    constructor() {}
    observe() {}
    disconnect() {
      observerDisconnects.push(true)
    }
  }
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })

  try {
    const locale = {
      register(namespace, dictionaries) {
        localeRegistrations.push({ namespace, dictionaries })
        return () => {
          localeUnsubscribeCalls += 1
        }
      },
      getSnapshot() {
        return { active: 'zh' }
      },
      subscribe() {
        return () => {
          localeUnsubscribeCalls += 1
        }
      }
    }
    const ctx = {
      effect(fn) {
        const disposer = fn()
        effects.push(disposer)
        return disposer
      },
      get() {
        return undefined
      },
      inject(_deps, callback) {
        const cleanup = callback({
          get: (name) => (name === 'locale' ? locale : undefined),
          effect: (fn) => {
            const disposer = fn()
            effects.push(disposer)
            return disposer
          }
        })
        if (typeof cleanup === 'function') injectCleanups.push(cleanup)
        return cleanup
      },
      slots: {
        inject(name, callback) {
          slotInjectCalls.push(name)
          return callback()
        },
        register(options, Component) {
          registrations.push({ options, Component })
          return () => {}
        }
      }
    }

    client.apply(ctx)

    assert.deepEqual(slotInjectCalls, ['plugins.bundle.config'])
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].options.name, 'plugins.bundle.config')
    assert.equal(registrations[0].options.key, PACKAGE_NAME)
    assert.equal(typeof registrations[0].Component, 'function')
    const injected = registrations[0].options.inject()
    assert.equal(typeof injected.access.describe, 'function')
    assert.equal(injected.access.available(), false)

    assert.equal(localeRegistrations.length, 1)
    assert.equal(localeRegistrations[0].namespace, 'dshStockImages')
    assert.deepEqual(Object.keys(localeRegistrations[0].dictionaries).sort(), ['en', 'zh'])
    assert.ok(effects.length >= 2)

    for (const disposer of effects) {
      if (typeof disposer === 'function') disposer()
    }
    assert.equal(removedStyles.length, 1)
    assert.equal(observerDisconnects.length, 1)
    // The locale scope's cleanup is returned for Cordis to own; it must also
    // release the subscription and the dictionary.
    assert.equal(injectCleanups.length, 1)
    injectCleanups[0]()
    assert.ok(localeUnsubscribeCalls >= 2, `expected locale cleanup, got ${localeUnsubscribeCalls}`)
  } finally {
    globalThis.document = previousDocument
    globalThis.MutationObserver = previousObserver
    if (navigatorDescriptor === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
  }
})
