import assert from 'node:assert/strict'
import test from 'node:test'

import { __internals as internals } from '../index.js'

const { fetchBuffer } = internals

/**
 * Deterministic unit tests for the outbound HTTP guard (`fetchBuffer`).
 *
 * Every URL uses a public IP literal, so `assertPublicHttpsUrl` never touches
 * DNS: the guard short-circuits on IP literals. The real `fetch` is replaced
 * with a stub for the duration of each test and restored afterwards.
 *
 * The DNS-resolution path (`assertPublicHttpsUrl` with a hostname) is not
 * covered here on purpose: stubbing the module-level `dnsLookup` import would
 * require network mocking, and the private-address classification it feeds on
 * is covered exhaustively in unit.test.js.
 */

/** A public IP literal: the guard accepts it without a DNS lookup. */
const PUBLIC = 'https://8.8.8.8/x'

/** Build a fetch Response-like object for the guard's shape. */
function fakeResponse({ status = 200, location = null, body = null, contentLength = null, bytes = null } = {}) {
  const headerMap = new Map()
  if (location !== null) headerMap.set('location', location)
  if (contentLength !== null) headerMap.set('content-length', String(contentLength))
  return {
    status,
    headers: {
      get(name) {
        return headerMap.get(name.toLowerCase()) ?? null
      }
    },
    body,
    async arrayBuffer() {
      if (bytes === null) return new ArrayBuffer(0)
      const copy = new Uint8Array(bytes.length)
      copy.set(bytes)
      return copy.buffer
    }
  }
}

/** Install a fetch stub recording every call; returns a restore function. */
function stubFetch(responder) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return responder(String(url), calls.length)
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    }
  }
}

/** A single-chunk byte stream, as the streaming path reads. */
function byteStream(...chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  })
}

/** Assert a fetchBuffer rejection carries the expected error code. */
async function assertGuardRejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`)
    return true
  })
}

test('the guard refuses insecure schemes, credentials and local names before any request', async () => {
  const stub = stubFetch(() => fakeResponse())
  try {
    await assertGuardRejects(fetchBuffer('http://8.8.8.8/x'), 'INSECURE_URL')
    await assertGuardRejects(fetchBuffer('https://user:secret@8.8.8.8/x'), 'INVALID_URL')
    await assertGuardRejects(fetchBuffer('https://localhost/x'), 'BLOCKED_HOST')
    await assertGuardRejects(fetchBuffer('https://printer.local/x'), 'BLOCKED_HOST')
    await assertGuardRejects(fetchBuffer('https://git.internal/x'), 'BLOCKED_HOST')
    await assertGuardRejects(fetchBuffer('https://127.0.0.1/x'), 'BLOCKED_HOST')
    await assertGuardRejects(fetchBuffer('https://169.254.169.254/latest/meta-data'), 'BLOCKED_HOST')
    await assertGuardRejects(fetchBuffer('https://[::1]/x'), 'BLOCKED_HOST')
    await assertGuardRejects(fetchBuffer('https://[64:ff9b::7f00:1]/x'), 'BLOCKED_HOST')
    // Every refusal happens before fetch is invoked.
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test('a redirect to a private address is refused at the next hop', async () => {
  const stub = stubFetch(() => fakeResponse({ status: 302, location: 'https://127.0.0.1/steal' }))
  try {
    await assertGuardRejects(fetchBuffer(PUBLIC), 'BLOCKED_HOST')
    assert.equal(stub.calls.length, 1)
  } finally {
    stub.restore()
  }
})

test('a redirect downgrading to http is refused', async () => {
  const stub = stubFetch(() => fakeResponse({ status: 302, location: 'http://8.8.8.8/x' }))
  try {
    await assertGuardRejects(fetchBuffer(PUBLIC), 'INSECURE_URL')
    assert.equal(stub.calls.length, 1)
  } finally {
    stub.restore()
  }
})

test('a redirect without a Location header is refused instead of followed', async () => {
  const stub = stubFetch(() => fakeResponse({ status: 302 }))
  try {
    await assertGuardRejects(fetchBuffer(PUBLIC), 'BAD_REDIRECT')
    assert.equal(stub.calls.length, 1)
  } finally {
    stub.restore()
  }
})

test('an endless redirect chain stops after the hop budget', async () => {
  const stub = stubFetch(() => fakeResponse({ status: 302, location: PUBLIC }))
  try {
    await assertGuardRejects(fetchBuffer(PUBLIC), 'TOO_MANY_REDIRECTS')
    // MAX_REDIRECTS is 4: five fetches, then the budget is exhausted.
    assert.equal(stub.calls.length, 5)
  } finally {
    stub.restore()
  }
})

test('a declared content-length above the cap is refused without reading the body', async () => {
  const stub = stubFetch(() => fakeResponse({ status: 200, contentLength: 1_000_000 }))
  try {
    await assertGuardRejects(fetchBuffer(PUBLIC, { maxBytes: 1024 }), 'RESPONSE_TOO_LARGE')
    assert.equal(stub.calls.length, 1)
  } finally {
    stub.restore()
  }
})

test('a streamed body above the cap is cut off mid-read', async () => {
  // 600 + 600 = 1200 bytes: the second chunk crosses the 1024-byte cap mid-read.
  const stub = stubFetch(() =>
    fakeResponse({ status: 200, body: byteStream(new Uint8Array(600), new Uint8Array(600)) })
  )
  try {
    await assertGuardRejects(fetchBuffer(PUBLIC, { maxBytes: 1024 }), 'RESPONSE_TOO_LARGE')
  } finally {
    stub.restore()
  }
})

test('a streamed body within the cap returns the exact bytes', async () => {
  const payload = Buffer.from('image bytes here')
  const stub = stubFetch(() => fakeResponse({ status: 200, body: byteStream(payload) }))
  try {
    const response = await fetchBuffer(PUBLIC, { maxBytes: 1024 })
    assert.equal(response.status, 200)
    assert.deepEqual(response.bytes, payload)
    assert.equal(response.url, PUBLIC)
  } finally {
    stub.restore()
  }
})

test('a response without a body falls back to arrayBuffer', async () => {
  const payload = Buffer.from('compact body')
  const stub = stubFetch(() => fakeResponse({ status: 200, body: null, bytes: payload }))
  try {
    const response = await fetchBuffer(PUBLIC, { maxBytes: 1024 })
    assert.deepEqual(response.bytes, payload)
  } finally {
    stub.restore()
  }
})

test('HTTP 204 yields an empty buffer without reading a body', async () => {
  const stub = stubFetch(() => fakeResponse({ status: 204 }))
  try {
    const response = await fetchBuffer(PUBLIC, { maxBytes: 1024 })
    assert.equal(response.status, 204)
    assert.equal(response.bytes.length, 0)
  } finally {
    stub.restore()
  }
})

test('every stubbed request carries the guard headers and manual redirects', async () => {
  const stub = stubFetch(() => fakeResponse({ status: 200, body: byteStream(Buffer.from('x')) }))
  try {
    await fetchBuffer(PUBLIC, { maxBytes: 1024, accept: 'image/*' })
    assert.equal(stub.calls.length, 1)
    const { init } = stub.calls[0]
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'manual')
    assert.equal(init.headers.accept, 'image/*')
    assert.match(init.headers['user-agent'], /^dsh-stock-images\//)
    assert.ok(init.signal instanceof AbortSignal)
  } finally {
    stub.restore()
  }
})
