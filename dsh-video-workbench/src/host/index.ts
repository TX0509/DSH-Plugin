import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { HostContext, IndexInjection, PeerLike, WebContext } from '../shared/dsh'

/** Global injected into the page so the client can authenticate media requests. */
export const TOKEN_GLOBAL = '__DSH_VIDEO_WORKBENCH__'

export const PING_PATH = '/api/video-workbench/ping'
export const MEDIA_PATH = '/api/video-workbench/media'

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
}

/** Control characters plus the characters Windows reserves in file names. */
const FORBIDDEN = /[<>:"|?*\u0000-\u001f]/u
const MAX_SEGMENTS = 5
const MAX_SEGMENT_LENGTH = 128

export interface PluginConfig {
  mediaRoot?: string
  requireToken?: boolean
}

interface RouteContext {
  mediaRoot: string
  token: string
  requireToken: boolean
}

interface HandlerOptions {
  mediaRoot: string
  token: string
  requireToken?: boolean
}

type RangeBounds = { start: number; end: number }
type ParsedRange = RangeBounds | 'invalid' | undefined

export function defaultMediaRoot(): string {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'cache', 'dsh-video-workbench', 'media')
}

/** A configured root of `C:\` or `/` would expose the whole drive. */
export function isFilesystemRoot(candidate: string): boolean {
  const resolved = path.resolve(candidate)
  return path.parse(resolved).root === resolved
}

/** Case-insensitive on Windows; exact elsewhere. */
function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  if (relative === '') return false
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false
  return true
}

/**
 * Resolve a client-supplied relative name under `root`.
 * Accepts Unicode names, rejects traversal, absolute paths, hidden files,
 * Windows-reserved characters, and names that would escape `root`.
 */
export function safeResolve(root: string, relative: string | null | undefined): string | undefined {
  const raw = String(relative ?? '')
  if (raw.length === 0 || raw.length > 512) return undefined
  const parts = raw.split(/[\\/]+/u).filter((part) => part.length > 0)
  if (parts.length === 0 || parts.length > MAX_SEGMENTS) return undefined
  for (const part of parts) {
    if (part.length > MAX_SEGMENT_LENGTH) return undefined
    if (part.startsWith('.') || part.endsWith('.') || part.endsWith(' ')) return undefined
    if (FORBIDDEN.test(part)) return undefined
  }
  const resolved = path.resolve(root, ...parts)
  return contains(root, resolved) ? resolved : undefined
}

/** Parse one `Range: bytes=` header. Returns undefined (no range), 'invalid', or bounds. */
export function parseRange(header: string | undefined, size: number): ParsedRange {
  if (typeof header !== 'string') return undefined
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
  if (match === null) return 'invalid'
  const rawStart = match[1]
  const rawEnd = match[2]
  if (rawStart === '' && rawEnd === '') return 'invalid'
  let start: number
  let end: number
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 'invalid'
  }
  if (start > end || start >= size || end < 0) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

export function tokenEquals(supplied: string | undefined, expected: string): boolean {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false
  if (supplied.length === 0 || expected.length === 0) return false
  const left = Buffer.from(supplied)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** `If-None-Match` may carry a weak prefix or a list; compare each member. */
export function matchesEtag(header: string | undefined, etag: string): boolean {
  if (typeof header !== 'string') return false
  const value = header.trim()
  if (value === '*') return true
  if (value.length === 0) return false
  return value.split(',').some((part) => {
    const member = part.trim()
    return member === etag || member === `W/${etag}`
  })
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

function readToken(request: IncomingMessage): string | undefined {
  const url = new URL(request.url ?? '/', 'http://placeholder.invalid')
  const query = url.searchParams.get('t')
  if (typeof query === 'string' && query.length > 0) return query
  const header = request.headers['x-dsh-video-workbench-token']
  if (typeof header === 'string' && header.length > 0) return header
  return undefined
}

function statFile(candidate: string): fs.Stats | undefined {
  try {
    return fs.statSync(candidate)
  } catch {
    return undefined
  }
}

/** Resolve symlinks and prove the real file still lives under the real root. */
function realFileInside(root: string, candidate: string): string | undefined {
  let real: string
  let rootReal: string
  try {
    real = fs.realpathSync(candidate)
    // Resolved per request: the root may be created after the plugin loads, or
    // reach the filesystem through a junction.
    rootReal = fs.realpathSync(root)
  } catch {
    return undefined
  }
  return contains(rootReal, real) ? real : undefined
}

function serveMedia(request: IncomingMessage, response: ServerResponse, context: RouteContext): void {
  if (context.requireToken && !tokenEquals(readToken(request), context.token)) {
    sendJson(response, 401, { error: 'unauthorized' })
    return
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' })
    response.end()
    return
  }

  const url = new URL(request.url ?? '/', 'http://placeholder.invalid')
  const relative = url.searchParams.get('path') ?? ''
  const absolute = safeResolve(context.mediaRoot, relative)
  if (absolute === undefined) {
    sendJson(response, 400, { error: 'invalid-path' })
    return
  }

  const real = realFileInside(context.mediaRoot, absolute)
  if (real === undefined) {
    sendJson(response, 404, { error: 'not-found' })
    return
  }

  const stat = statFile(real)
  if (stat === undefined) {
    sendJson(response, 404, { error: 'not-found' })
    return
  }
  if (!stat.isFile()) {
    sendJson(response, 404, { error: 'not-a-file' })
    return
  }

  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}-${Math.floor(stat.ctimeMs).toString(16)}"`
  const base: Record<string, string> = {
    'content-type': MIME[path.extname(real).toLowerCase()] ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
    etag,
    'last-modified': stat.mtime.toUTCString(),
  }

  const requested = request.headers['if-range']
  const range: ParsedRange = requested === undefined || requested === etag
    ? parseRange(request.headers.range, stat.size)
    : undefined

  if (range === 'invalid') {
    response.writeHead(416, { ...base, 'content-range': `bytes */${stat.size}` })
    response.end()
    return
  }

  if (range === undefined && matchesEtag(request.headers['if-none-match'], etag)) {
    response.writeHead(304, {
      etag,
      'cache-control': base['cache-control'],
      'last-modified': base['last-modified'],
      'accept-ranges': base['accept-ranges'],
    })
    response.end()
    return
  }

  const start = range === undefined ? 0 : range.start
  const end = range === undefined ? Math.max(0, stat.size - 1) : range.end
  const length = stat.size === 0 ? 0 : end - start + 1
  const headers: Record<string, string> = { ...base, 'content-length': String(length) }
  if (range !== undefined) headers['content-range'] = `bytes ${start}-${end}/${stat.size}`
  response.writeHead(range === undefined ? 200 : 206, headers)

  if (request.method === 'HEAD' || length === 0) {
    response.end()
    return
  }

  const stream = fs.createReadStream(real, { start, end })
  stream.on('error', () => response.destroy())
  response.on('close', () => stream.destroy())
  stream.pipe(response)
}

/** Shared request context for the two route handlers. */
function createContext(options: HandlerOptions): RouteContext {
  return {
    mediaRoot: path.resolve(options.mediaRoot),
    token: options.token,
    requireToken: options.requireToken !== false,
  }
}

/** Build the media route handler; exported so tests can drive it over real HTTP. */
export function createMediaHandler(options: HandlerOptions): (request: IncomingMessage, response: ServerResponse) => void {
  const context = createContext(options)
  return (request, response) => serveMedia(request, response, context)
}

/** Build the health route handler. */
export function createPingHandler(options: HandlerOptions): (request: IncomingMessage, response: ServerResponse) => void {
  const context = createContext(options)
  return (request, response) => {
    if (context.requireToken && !tokenEquals(readToken(request), context.token)) {
      sendJson(response, 401, { error: 'unauthorized' })
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' })
      response.end()
      return
    }
    sendJson(response, 200, {
      ok: true,
      mediaRootExists: fs.existsSync(context.mediaRoot),
      requireToken: context.requireToken,
    })
  }
}

/** Index-injection row carrying the media token; exported so tests can drive it. */
export function createIndexInjector(token: string): (table: IndexInjection[], peer?: PeerLike) => void {
  return (table, peer) => {
    // Only the owner's page may read media; a non-owner peer page (remote
    // viewer) must not receive this token.
    if (peer?.principal?.kind !== 'owner') return
    table.push({ kind: 'global', name: TOKEN_GLOBAL, value: { token } })
  }
}

export function apply(ctx: HostContext, config: PluginConfig = {}): void {
  const configured = typeof config.mediaRoot === 'string' && config.mediaRoot.trim().length > 0
    ? config.mediaRoot.trim()
    : defaultMediaRoot()
  let mediaRoot = path.resolve(configured)
  if (isFilesystemRoot(mediaRoot)) {
    const fallback = path.resolve(defaultMediaRoot())
    if (typeof ctx.logger?.error === 'function') {
      ctx.logger.error(`[video-workbench] mediaRoot "${mediaRoot}" is a filesystem root; falling back to ${fallback}`)
    }
    mediaRoot = fallback
  }
  const requireToken = config.requireToken !== false
  const token = randomBytes(24).toString('base64url')

  ctx.inject(['webServer'], (webCtx: WebContext) => {
    // The page receives the token as a global during index injection; only an
    // authenticated owner page gets it.
    webCtx.on('webserver/index-inject', createIndexInjector(token))

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: PING_PATH,
      handler: createPingHandler({ mediaRoot, token, requireToken }),
    }), 'video-workbench:ping')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: MEDIA_PATH,
      handler: createMediaHandler({ mediaRoot, token, requireToken }),
    }), 'video-workbench:media')
  })

  if (typeof ctx.logger?.info === 'function') {
    ctx.logger.info(`[video-workbench] media root: ${mediaRoot} (token required: ${requireToken})`)
  }
}
