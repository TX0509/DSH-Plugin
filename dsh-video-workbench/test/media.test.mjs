import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createFileHandler, createPingHandler } from '../index.js'

const TOKEN = 'test-token-value'

function setup(options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dshvw-root-'))
  const outside = mkdtempSync(path.join(os.tmpdir(), 'dshvw-outside-'))
  writeFileSync(path.join(root, 'clip.mp4'), Buffer.alloc(200, 7))
  writeFileSync(path.join(root, 'empty.mp4'), Buffer.alloc(0))
  writeFileSync(path.join(root, '中文 片段.mp4'), Buffer.from('unicode-name'))
  mkdirSync(path.join(root, 'nested'))
  writeFileSync(path.join(root, 'nested', 'v1.mp4'), Buffer.from('nested'))
  writeFileSync(path.join(outside, 'secret.txt'), 'do not serve')
  let linked = true
  try {
    symlinkSync(outside, path.join(root, 'link'), 'junction')
  } catch {
    linked = false
  }

  const server = createServer((request, response) => {
    if (request.url?.startsWith('/api/video-workbench/media')) {
      createFileHandler({ root, token: TOKEN, ...options })(request, response)
      return
    }
    createPingHandler({ root, token: TOKEN, ...options })(request, response)
  })
  return { root, outside, linked, server }
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}

/**
 * One request, one connection. The global fetch pool keys by origin, and Windows
 * recycles ephemeral ports quickly; a pooled keep-alive socket could then point
 * at a server that no longer exists.
 */
function call(origin, target, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}${target}`, { method, headers, agent: false }, (response) => {
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

async function withServer(run, options = {}) {
  const fixture = setup(options)
  const origin = await listen(fixture.server)
  try {
    await run({ ...fixture, origin })
  } finally {
    fixture.server.closeAllConnections?.()
    await new Promise((resolve) => fixture.server.close(resolve))
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(fixture.outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

const mediaPath = (name, token = TOKEN) =>
  `/api/video-workbench/media?path=${encodeURIComponent(name)}&t=${encodeURIComponent(token)}`

test('media route rejects a request without the token', async () => {
  await withServer(async ({ origin }) => {
    const response = await call(origin, '/api/video-workbench/media?path=clip.mp4')
    assert.equal(response.status, 401)
  })
})

test('media route rejects a wrong token', async () => {
  await withServer(async ({ origin }) => {
    const response = await call(origin, mediaPath('clip.mp4', 'nope'))
    assert.equal(response.status, 401)
  })
})

test('media route serves a full body with length and etag', async () => {
  await withServer(async ({ origin }) => {
    const response = await call(origin, mediaPath('clip.mp4'))
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-length'], '200')
    assert.equal(response.headers['accept-ranges'], 'bytes')
    assert.equal(response.headers['content-type'], 'video/mp4')
    assert.equal(response.body.length, 200)
  })
})

test('media route answers a range with 206 and content-range', async () => {
  await withServer(async ({ origin }) => {
    const response = await call(origin, mediaPath('clip.mp4'), { headers: { Range: 'bytes=10-19' } })
    assert.equal(response.status, 206)
    assert.equal(response.headers['content-range'], 'bytes 10-19/200')
    assert.equal(response.headers['content-length'], '10')
    assert.equal(response.body.length, 10)
  })
})

test('media route answers 416 for an unsatisfiable range', async () => {
  await withServer(async ({ origin }) => {
    const response = await call(origin, mediaPath('clip.mp4'), { headers: { Range: 'bytes=9999-' } })
    assert.equal(response.status, 416)
    assert.equal(response.headers['content-range'], 'bytes */200')
  })
})

test('media route answers 304 for a matching If-None-Match', async () => {
  await withServer(async ({ origin }) => {
    const first = await call(origin, mediaPath('clip.mp4'))
    const etag = first.headers.etag
    assert.ok(etag)
    const second = await call(origin, mediaPath('clip.mp4'), { headers: { 'If-None-Match': etag } })
    assert.equal(second.status, 304)
  })
})

test('media route rejects traversal and hidden files', async () => {
  await withServer(async ({ origin }) => {
    for (const name of ['../outside.txt', '..\\secret.txt', '.env', 'nested/../../x.mp4']) {
      const response = await call(origin, `/api/video-workbench/media?path=${encodeURIComponent(name)}&t=${TOKEN}`)
      assert.equal(response.status, 400, `expected 400 for ${name}`)
    }
  })
})

test('media route serves nested and Unicode names', async () => {
  await withServer(async ({ origin }) => {
    const nested = await call(origin, mediaPath('nested/v1.mp4'))
    assert.equal(nested.status, 200)
    assert.equal(nested.body.toString(), 'nested')

    const unicode = await call(origin, mediaPath('中文 片段.mp4'))
    assert.equal(unicode.status, 200)
    assert.equal(unicode.body.toString(), 'unicode-name')
  })
})

test('media route serves an empty file without hanging', async () => {
  await withServer(async ({ origin }) => {
    const response = await call(origin, mediaPath('empty.mp4'))
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-length'], '0')
    assert.equal(response.body.length, 0)
  })
})

test('media route answers 404 for a missing or non-file path', async () => {
  await withServer(async ({ origin }) => {
    assert.equal((await call(origin, mediaPath('missing.mp4'))).status, 404)
    assert.equal((await call(origin, mediaPath('nested'))).status, 404)
  })
})

test('media route refuses to follow a link that escapes the root', async (t) => {
  await withServer(async ({ origin, linked }) => {
    if (!linked) {
      t.skip('junction could not be created on this machine')
      return
    }
    const response = await call(origin, mediaPath('link/secret.txt'))
    assert.equal(response.status, 404)
    assert.deepEqual(JSON.parse(response.body.toString()), { error: 'not-found' })
  })
})

test('If-None-Match wins over a Range request', async () => {
  await withServer(async ({ origin }) => {
    const first = await call(origin, mediaPath('clip.mp4'))
    const etag = first.headers.etag
    assert.ok(etag)
    const response = await call(origin, mediaPath('clip.mp4'), {
      headers: { Range: 'bytes=0-9', 'If-None-Match': etag },
    })
    assert.equal(response.status, 304)
    assert.equal(response.body.length, 0)
  })
})

test('If-None-Match wins over an unsatisfiable Range (304, not 416)', async () => {
  await withServer(async ({ origin }) => {
    const first = await call(origin, mediaPath('clip.mp4'))
    const etag = first.headers.etag
    assert.ok(etag)
    const response = await call(origin, mediaPath('clip.mp4'), {
      headers: { Range: 'bytes=9999-', 'If-None-Match': etag },
    })
    assert.equal(response.status, 304)
    assert.equal(response.body.length, 0)
  })
})

test('a non-matching If-None-Match still answers a Range request with 206', async () => {
  await withServer(async ({ origin }) => {
    const response = await call(origin, mediaPath('clip.mp4'), {
      headers: { Range: 'bytes=10-19', 'If-None-Match': '"stale"' },
    })
    assert.equal(response.status, 206)
    assert.equal(response.headers['content-range'], 'bytes 10-19/200')
    assert.equal(response.body.length, 10)
  })
})

test('HEAD with a matching If-None-Match and a Range answers 304', async () => {
  await withServer(async ({ origin }) => {
    const first = await call(origin, mediaPath('clip.mp4'), { method: 'HEAD' })
    const etag = first.headers.etag
    assert.ok(etag)
    const response = await call(origin, mediaPath('clip.mp4'), {
      method: 'HEAD',
      headers: { Range: 'bytes=0-9', 'If-None-Match': etag },
    })
    assert.equal(response.status, 304)
    assert.equal(response.body.length, 0)
  })
})

test('media route answers HEAD without a body and 405 for other methods', async () => {
  await withServer(async ({ origin }) => {
    const head = await call(origin, mediaPath('clip.mp4'), { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers['content-length'], '200')
    assert.equal(head.body.length, 0)

    const post = await call(origin, mediaPath('clip.mp4'), { method: 'POST' })
    assert.equal(post.status, 405)
    assert.equal(post.headers.allow, 'GET, HEAD')
  })
})

test('ping requires the token and reports readiness without absolute paths', async () => {
  await withServer(async ({ origin }) => {
    assert.equal((await call(origin, '/api/video-workbench/ping')).status, 401)
    const response = await call(origin, `/api/video-workbench/ping?t=${TOKEN}`)
    assert.equal(response.status, 200)
    const body = JSON.parse(response.body.toString())
    assert.equal(body.ok, true)
    assert.equal(body.requireToken, true)
    assert.equal(body.mediaRoot, undefined)
    assert.equal(body.node, undefined)
  })
})

test('media route accepts the token as a header', async () => {
  await withServer(async ({ origin }) => {
    const response = await call(origin, '/api/video-workbench/media?path=clip.mp4', {
      headers: { 'x-dsh-video-workbench-token': TOKEN },
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.length, 200)
  })
})

test('media and ping can run without a token when requireToken is false', async () => {
  await withServer(async ({ origin }) => {
    const media = await call(origin, '/api/video-workbench/media?path=clip.mp4')
    assert.equal(media.status, 200)

    const ping = await call(origin, '/api/video-workbench/ping')
    assert.equal(ping.status, 200)
    assert.equal(JSON.parse(ping.body.toString()).requireToken, false)
  }, { requireToken: false })
})

test('If-Range with a stale validator ignores the range', async () => {
  await withServer(async ({ origin }) => {
    const response = await call(origin, mediaPath('clip.mp4'), {
      headers: { Range: 'bytes=0-9', 'If-Range': '"stale-validator"' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-length'], '200')
    assert.equal(response.headers['content-range'], undefined)
  })
})

test('If-Range with the current validator still answers 206', async () => {
  await withServer(async ({ origin }) => {
    const first = await call(origin, mediaPath('clip.mp4'))
    const etag = first.headers.etag
    assert.ok(etag)
    const response = await call(origin, mediaPath('clip.mp4'), {
      headers: { Range: 'bytes=0-9', 'If-Range': etag },
    })
    assert.equal(response.status, 206)
    assert.equal(response.body.length, 10)
  })
})

test('HEAD honours If-None-Match', async () => {
  await withServer(async ({ origin }) => {
    const first = await call(origin, mediaPath('clip.mp4'), { method: 'HEAD' })
    const etag = first.headers.etag
    assert.ok(etag)
    const second = await call(origin, mediaPath('clip.mp4'), {
      method: 'HEAD',
      headers: { 'If-None-Match': etag },
    })
    assert.equal(second.status, 304)
  })
})

test('ping accepts the token as a header', async () => {
  await withServer(async ({ origin }) => {
    const response = await call(origin, '/api/video-workbench/ping', {
      headers: { 'x-dsh-video-workbench-token': TOKEN },
    })
    assert.equal(response.status, 200)
  })
})

test('If-None-Match accepts weak and listed validators', async () => {
  await withServer(async ({ origin }) => {
    const first = await call(origin, mediaPath('clip.mp4'))
    const etag = first.headers.etag
    assert.ok(etag)
    for (const header of [`W/${etag}`, `"stale", ${etag}`, '*']) {
      const response = await call(origin, mediaPath('clip.mp4'), { headers: { 'If-None-Match': header } })
      assert.equal(response.status, 304, `expected 304 for ${header}`)
    }
  })
})

test('an unauthorized request is rejected before the method check', async () => {
  await withServer(async ({ origin }) => {
    const response = await call(origin, '/api/video-workbench/media?path=clip.mp4', { method: 'POST' })
    assert.equal(response.status, 401)
  })
})
