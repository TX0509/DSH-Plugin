import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  MEDIA_PATH,
  PING_PATH,
  SELFCHECK_PATH,
  TOKEN_GLOBAL,
  apply,
  defaultMediaRoot,
  isFilesystemRoot,
  matchesEtag,
} from '../index.js'

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

/** Drive every index-injection listener the plugin registered. */
function emitIndexInject(listeners, table, peer) {
  for (const entry of listeners) {
    if (entry.name === 'webserver/index-inject') entry.listener(table, peer)
  }
}

test('index injection: an owner page receives the token global', () => {
  const stub = stubContext()
  apply(stub.ctx, { mediaRoot: path.join(process.cwd(), 'media'), selfcheckOnStartup: false })

  const table = []
  emitIndexInject(stub.listeners, table, { principal: { kind: 'owner' } })
  assert.equal(table.length, 1)
  assert.equal(table[0].kind, 'global')
  assert.equal(table[0].name, TOKEN_GLOBAL)
  assert.equal(typeof table[0].value.token, 'string')
  assert.ok(table[0].value.token.length > 0, 'expected a non-empty token')
})

test('index injection: non-owner and missing peers receive nothing', () => {
  const stub = stubContext()
  apply(stub.ctx, { mediaRoot: path.join(process.cwd(), 'media'), selfcheckOnStartup: false })

  for (const peer of [{ principal: { kind: 'guest' } }, { principal: undefined }, undefined]) {
    const table = []
    emitIndexInject(stub.listeners, table, peer)
    assert.deepEqual(table, [], `expected no injection for ${JSON.stringify(peer)}`)
  }
})

test('isFilesystemRoot: detects drive and POSIX roots only', () => {
  const root = path.parse(process.cwd()).root
  assert.equal(isFilesystemRoot(root), true)
  assert.equal(isFilesystemRoot(path.join(root, 'tmp')), false)
  assert.equal(isFilesystemRoot(path.join(process.cwd(), 'media')), false)
})

test('matchesEtag: accepts exact, weak, listed and wildcard validators', () => {
  assert.equal(matchesEtag('"abc"', '"abc"'), true)
  assert.equal(matchesEtag('W/"abc"', '"abc"'), true)
  assert.equal(matchesEtag('"no", "abc"', '"abc"'), true)
  assert.equal(matchesEtag(' "abc" ', '"abc"'), true)
  assert.equal(matchesEtag('*', '"abc"'), true)
  assert.equal(matchesEtag('"no"', '"abc"'), false)
  assert.equal(matchesEtag(undefined, '"abc"'), false)
  assert.equal(matchesEtag('', '"abc"'), false)
})

test('apply registers both routes and the index injector', () => {
  const stub = stubContext()
  apply(stub.ctx, { mediaRoot: path.join(process.cwd(), 'media'), selfcheckOnStartup: false })

  assert.deepEqual(
    stub.routes.map((route) => [route.kind, route.path]).sort(),
    [['exact', PING_PATH], ['exact', SELFCHECK_PATH], ['prefix', MEDIA_PATH]].sort(),
  )
  assert.deepEqual(stub.listeners.map((entry) => entry.name), ['webserver/index-inject'])
  assert.equal(stub.messages.some((message) => message.includes('filesystem root')), false)
})

test('apply falls back to the default root when configured with a filesystem root', () => {
  const stub = stubContext()
  apply(stub.ctx, { mediaRoot: path.parse(process.cwd()).root, selfcheckOnStartup: false })

  assert.equal(stub.routes.length, 3)
  const message = stub.messages.find((entry) => entry.includes('filesystem root'))
  assert.ok(message, 'expected a filesystem-root error log')
  assert.ok(message.includes(defaultMediaRoot()), 'expected the fallback root in the log')
})
