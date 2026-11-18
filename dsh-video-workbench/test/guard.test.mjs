import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  MEDIA_PATH,
  PING_PATH,
  TOKEN_GLOBAL,
  apply,
  createIndexInjector,
  defaultMediaRoot,
  isFilesystemRoot,
  matchesEtag,
} from '../index.js'

test('createIndexInjector: an owner page receives the token', () => {
  const table = []
  createIndexInjector('token-1')(table, { principal: { kind: 'owner' } })
  assert.deepEqual(table, [{ kind: 'global', name: TOKEN_GLOBAL, value: { token: 'token-1' } }])
})

test('createIndexInjector: non-owner and missing peers receive nothing', () => {
  for (const peer of [{ principal: { kind: 'guest' } }, { principal: undefined }, undefined]) {
    const table = []
    createIndexInjector('token-1')(table, peer)
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

/** Minimal Cordis context: records what apply() registers. */
function stubContext() {
  const routes = []
  const messages = []
  const events = []
  const ctx = {
    logger: {
      info: (message) => messages.push(message),
      error: (message) => messages.push(message),
    },
    inject(_dependencies, callback) {
      callback({
        on: (name) => events.push(name),
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
  return { ctx, routes, messages, events }
}

test('apply registers both routes and the index injector', () => {
  const stub = stubContext()
  apply(stub.ctx, { mediaRoot: path.join(process.cwd(), 'media') })

  assert.deepEqual(
    stub.routes.map((route) => [route.kind, route.path]).sort(),
    [['exact', PING_PATH], ['prefix', MEDIA_PATH]].sort(),
  )
  assert.deepEqual(stub.events, ['webserver/index-inject'])
  assert.equal(stub.messages.some((message) => message.includes('filesystem root')), false)
})

test('apply falls back to the default root when configured with a filesystem root', () => {
  const stub = stubContext()
  apply(stub.ctx, { mediaRoot: path.parse(process.cwd()).root })

  assert.equal(stub.routes.length, 2)
  const message = stub.messages.find((entry) => entry.includes('filesystem root'))
  assert.ok(message, 'expected a filesystem-root error log')
  assert.ok(message.includes(defaultMediaRoot()), 'expected the fallback root in the log')
})
