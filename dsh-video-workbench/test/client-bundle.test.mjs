import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

/** The module id must equal the package name; read it instead of duplicating it. */
const PLUGIN_NAME = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).name

/** Page global DSH injects the media token into; see src/shared/routes.ts. */
const TOKEN_GLOBAL = '__DSH_VIDEO_WORKBENCH__'

/**
 * Load the real built `client.js` in a VM with just enough browser surface to
 * execute it. This catches the two things the source-level tests cannot see:
 * the lazy-CJS wrapper (registered once, under the package id) and the shape of
 * what its factory returns.
 */
function loadClientBundle() {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const loads = []
  const styles = []
  const registrations = []
  const injected = []
  const effects = []

  const React = {
    Fragment: 'fragment',
    createElement: (...args) => ({ type: args[0], props: args[1] ?? {}, children: args.slice(2) }),
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  }

  const documentStub = {
    // The Desktop surface the plugin must work on: no http origin to fall back to.
    baseURI: 'dsh-app://app/',
    head: {
      appendChild: (element) => {
        styles.push(element)
      },
    },
    createElement: () => ({
      textContent: '',
      removed: false,
      remove() {
        this.removed = true
      },
    }),
    addEventListener() {},
    removeEventListener() {},
  }

  const windowStub = {
    __ModuleLoader__: {
      load: (options) => {
        loads.push(options)
      },
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  }

  const sandbox = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    document: documentStub,
    window: windowStub,
  }

  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })

  const require = (id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require(${JSON.stringify(id)})`)
  }

  const context = {
    effect: (callback, label) => {
      const dispose = callback()
      effects.push({ label, dispose })
      return dispose
    },
    slots: {
      inject: (key, callback) => {
        injected.push(key)
        callback()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }

  return { loads, styles, registrations, injected, effects, context, require, React, sandbox }
}

test('client bundle: registers the module exactly once with the package id', () => {
  const bundle = loadClientBundle()
  assert.equal(bundle.loads.length, 1, 'expected a single __ModuleLoader__.load call')
  assert.equal(bundle.loads[0].id, PLUGIN_NAME)
  assert.equal(typeof bundle.loads[0].factory, 'function')
})

test('client bundle: the factory returns the plugin module itself', () => {
  const bundle = loadClientBundle()
  const plugin = bundle.loads[0].factory(bundle.require)
  // The v0.1.0 client registration bug lived inside the factory body, so the
  // single-registration assertion must hold after the factory has run.
  assert.equal(bundle.loads.length, 1, 'the factory must not register the module again')
  // `inject` comes from the VM realm, so compare a copy rather than the
  // cross-realm array prototype.
  assert.deepEqual(Array.from(plugin.inject), ['slots'])
  assert.equal(typeof plugin.apply, 'function')
  // Defensive: never hand DSH a CJS namespace object instead of the plugin.
  assert.equal(plugin.default, undefined)
})

test('client bundle: apply installs the stylesheet and both slots', () => {
  const bundle = loadClientBundle()
  const plugin = bundle.loads[0].factory(bundle.require)
  plugin.apply(bundle.context)

  assert.deepEqual(
    bundle.effects.map((entry) => entry.label),
    ['video-workbench:styles'],
  )
  assert.equal(bundle.styles.length, 1)
  assert.match(bundle.styles[0].textContent, /dshvw-trigger/u)
  assert.deepEqual(bundle.injected, ['conversation.input.left', 'shell.overlay'])
  assert.deepEqual(
    bundle.registrations.map((entry) => entry.options.id),
    ['video-workbench-trigger', 'video-workbench-panel'],
  )
  for (const registration of bundle.registrations) {
    assert.equal(typeof registration.component, 'function')
  }
})

test('client bundle: unloading removes the injected stylesheet', () => {
  const bundle = loadClientBundle()
  const plugin = bundle.loads[0].factory(bundle.require)
  plugin.apply(bundle.context)
  assert.equal(bundle.styles[0].removed, false)
  bundle.effects[0].dispose()
  assert.equal(bundle.styles[0].removed, true)
})

test('client bundle: internals resolve host URLs and the injected token', () => {
  const bundle = loadClientBundle()
  const plugin = bundle.loads[0].factory(bundle.require)
  const { hostUrl, readToken } = plugin.__internals

  // Desktop loads from `dsh-app://app/`, so no http origin may be assumed.
  assert.equal(readToken(), '', 'no token before DSH injects one')
  bundle.sandbox[TOKEN_GLOBAL] = { token: 'tok-1' }
  assert.equal(readToken(), 'tok-1')

  assert.equal(
    hostUrl('api/video-workbench/media', { path: 'a b.mp4', t: 'tok-1' }),
    'dsh-app://app/api/video-workbench/media?path=a+b.mp4&t=tok-1',
  )
  assert.equal(hostUrl('/api/video-workbench/ping'), 'dsh-app://app/api/video-workbench/ping')
  assert.equal(
    hostUrl('api/video-workbench/ping', { t: '' }),
    'dsh-app://app/api/video-workbench/ping',
    'empty params must not add an empty query string',
  )
})
