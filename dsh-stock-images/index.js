/**
 * dsh-stock-images — Host half.
 *
 * Registers three model-facing tools on `ctx.tools`:
 *
 *   stock_image_search    search free stock libraries and return licensed
 *                         candidates with preview/download URLs
 *   stock_image_download  download one candidate into the Session workspace
 *                         and record its attribution
 *   stock_image_sources   report provider status and verify API keys
 *
 * API keys live in the DSH credential store (refs such as `PEXELS_API_KEY`),
 * never in this plugin's configuration. The browser half renders the settings
 * card that writes those refs through the Host credential Remote.
 *
 * Design notes:
 * - Every outbound request goes through `fetchBuffer`, which only allows
 *   HTTPS, resolves DNS itself and rejects private/link-local targets, follows
 *   a bounded number of redirects with the same checks, and caps the body
 *   size. This keeps the download tool from becoming an SSRF primitive.
 * - API-key sources are skipped with a status note instead of failing the
 *   whole search, so the two keyless providers keep working out of the box.
 * - Result text is compact on purpose: the model gets URLs plus one-line
 *   attribution, and reads the saved file with `read_image` when it needs to
 *   confirm the subject.
 */

import { promises as fs } from 'node:fs'
import { isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Plugin identity for the Loader row and diagnostics. */
export const name = 'dsh-stock-images'

/** `tools` is required; the credential store is read opportunistically. */
export const inject = ['tools']

/** NPM package name — also the Client module id and `plugins.bundle.config` key. */
export const PACKAGE_NAME = 'dsh-stock-images'

/** Credential refs (environment-variable shaped) that hold provider API keys. */
export const KEY_REFS = Object.freeze({
  pexels: 'PEXELS_API_KEY',
  pixabay: 'PIXABAY_API_KEY',
  unsplash: 'UNSPLASH_ACCESS_KEY'
})

/** Recipients of every outbound request; Wikimedia in particular requires one. */
const USER_AGENT = 'dsh-stock-images/0.1.0 (DeepSeek Harness plugin; +https://deepseek.com)'

/** Formats DSH's `read_image` can read back, so the model can verify the subject. */
const SAVEABLE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

/** Hard cap for one downloaded image. */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024

/** Hard cap for one JSON/API response. */
const MAX_JSON_BYTES = 4 * 1024 * 1024

/** Redirect hops allowed for one request. */
const MAX_REDIRECTS = 4

/** Default request timeout. */
const DEFAULT_TIMEOUT_MS = 15000

/** Default folder, relative to the Session working directory. */
const DEFAULT_DOWNLOAD_DIR = 'stock-images'

/** Attribution file written next to downloaded images. */
const ATTRIBUTION_FILE = 'ATTRIBUTION.md'

/** Error carrying a stable code and a model-facing message. */
export class StockImageError extends Error {
  constructor(message, code = 'STOCK_IMAGE_ERROR') {
    super(message)
    this.name = 'StockImageError'
    this.code = code
  }
}

/* ------------------------------------------------------------------------- *
 * Small helpers
 * ------------------------------------------------------------------------- */

/** Collapse whitespace and trim; returns '' for non-strings. */
function cleanText(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

/** Strip tags/entities from the HTML snippets some providers return. */
function stripHtml(value) {
  if (typeof value !== 'string') return ''
  return cleanText(
    value
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/[^>]+>/g, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
  )
}

/** Human-readable byte size. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Clamp an integer option into a range, falling back to a default. */
function clampInt(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/** Sanitize a free-form name into a safe ASCII-ish file stem. */
function sanitizeFilename(value, fallback = 'image') {
  const raw = cleanText(value).normalize('NFKD')
  const ascii = raw
    .replace(/[\u0300-\u036f]/g, '')
    // Keep CJK and letters/digits; drop path separators and controls.
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '')
  // Slice by code point so a surrogate pair (emoji) is never cut in half.
  const codepoints = Array.from(ascii)
  const stem = codepoints.length > 60 ? codepoints.slice(0, 60).join('') : ascii
  return stem === '' || stem === '.' || stem === '..' ? fallback : stem
}

/**
 * Resolve `dir` under `root` and refuse anything that escapes it lexically.
 * Returns the absolute target directory; the real-path check happens after the
 * directory exists (see `assertRealDirectoryInsideRoot`).
 */
function resolveInsideRoot(root, dir) {
  const absoluteRoot = resolve(root)
  const target = isAbsolute(dir) ? resolve(dir) : resolve(absoluteRoot, dir)
  const rel = relative(absoluteRoot, target)
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new StockImageError(
      `refusing to write outside the Session workspace: "${dir}" points outside it`,
      'PATH_OUTSIDE_WORKSPACE'
    )
  }
  return target
}

/**
 * Verify a created directory's real path is still inside the workspace.
 *
 * Lexical containment alone cannot stop a symlink inside the workspace from
 * pointing somewhere else; this compares resolved real paths, so a symlinked
 * directory (or a symlinked ancestor) is refused instead of followed.
 */
async function assertRealDirectoryInsideRoot(root, directory) {
  let realRoot
  let realDirectory
  try {
    realRoot = await fs.realpath(root)
  } catch {
    throw new StockImageError('the Session workspace is not readable', 'NO_WORKSPACE')
  }
  try {
    realDirectory = await fs.realpath(directory)
  } catch {
    throw new StockImageError('cannot resolve the target directory', 'PATH_UNRESOLVED')
  }
  const rel = relative(realRoot, realDirectory)
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new StockImageError('the target directory resolves outside the Session workspace (symlink refused)', 'PATH_SYMLINK')
  }
  return realDirectory
}

/** Refuse to write through a symbolic link (used for the attribution file). */
async function assertNotSymlink(target) {
  try {
    const stats = await fs.lstat(target)
    if (stats.isSymbolicLink()) {
      throw new StockImageError('refusing to write through a symbolic link', 'PATH_SYMLINK')
    }
  } catch (error) {
    if (error instanceof StockImageError) throw error
    // ENOENT is the normal case: the file does not exist yet.
  }
}

/**
 * Session working directory from the calling Agent's Session header.
 * A tool call without a Session has no workspace, so it refuses instead of
 * falling back to the process directory (which may be the app installation).
 */
function workspaceRootFromExec(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd !== '' && isAbsolute(cwd)) return cwd
  throw new StockImageError('this tool needs an active Session workspace; open a conversation and retry', 'NO_WORKSPACE')
}

/* ------------------------------------------------------------------------- *
 * Outbound HTTP with SSRF and size guards
 * ------------------------------------------------------------------------- */

/**
 * Expand an IPv6 literal into eight 16-bit groups, handling `::` compression,
 * an embedded IPv4 tail and a zone suffix. Returns null when unparseable.
 */
export function expandIpv6(address) {
  let text = String(address).toLowerCase()
  const zone = text.indexOf('%')
  if (zone >= 0) text = text.slice(0, zone)
  if (text === '') return null
  // Rewrite an embedded IPv4 tail ("::ffff:192.168.0.1") into two hex groups.
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':')
    if (lastColon < 0) return null
    const parts = text.slice(lastColon + 1).split('.').map((part) => Number(part))
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
    const high = ((parts[0] << 8) | parts[1]).toString(16)
    const low = ((parts[2] << 8) | parts[3]).toString(16)
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`
  }
  const parseGroups = (part) =>
    part === '' ? [] : part.split(':').map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN))
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = parseGroups(halves[0])
  const tail = halves.length === 2 ? parseGroups(halves[1]) : []
  let groups
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length
    if (fill < 1) return null
    groups = [...head, ...Array(fill).fill(0), ...tail]
  } else {
    groups = head
  }
  if (groups.length !== 8) return null
  return groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null
}

/** True for private, loopback, link-local, CGNAT and unique-local addresses. */
export function isPrivateAddress(address) {
  const family = isIP(address)
  if (family === 4) {
    const parts = address.split('.').map((part) => Number(part))
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return true
    }
    const [a, b] = parts
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
    if (a === 169 && b === 254) return true // link-local
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 192 && b === 0) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a >= 224) return true // multicast / reserved / broadcast
    return false
  }
  if (family === 6) {
    const groups = expandIpv6(address)
    // Unparseable IPv6 is treated as unsafe.
    if (groups === null) return true
    // Only 2000::/3 is global unicast. Loopback, link-local (fe80::/10),
    // unique-local (fc00::/7), multicast (ff00::/8), IPv4-mapped (::ffff:0:0/96),
    // NAT64 (64:ff9b::/96), discard (100::/64) and everything else fall outside it.
    if ((groups[0] & 0xe000) !== 0x2000) return true
    // 6to4 (2002::/16) embeds an IPv4 address; block it when that IPv4 is private.
    if (groups[0] === 0x2002) {
      const embedded = `${groups[1] >> 8}.${groups[1] & 0xff}.${groups[2] >> 8}.${groups[2] & 0xff}`
      return isPrivateAddress(embedded)
    }
    // Teredo (2001::/32) can reach private endpoints through a tunnel.
    if (groups[0] === 0x2001 && groups[1] === 0x0000) return true
    return false
  }
  // Not an IP literal: callers resolve separately.
  return true
}

/** Validate one absolute URL and its resolved DNS addresses. */
async function assertPublicHttpsUrl(rawUrl) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    // Never echo the raw URL: API-key providers put their key in the query string.
    throw new StockImageError('invalid URL', 'INVALID_URL')
  }
  if (url.protocol !== 'https:') {
    throw new StockImageError(`only https URLs are allowed, got "${url.protocol}"`, 'INSECURE_URL')
  }
  if (url.username !== '' || url.password !== '') {
    throw new StockImageError('URLs with embedded credentials are not allowed', 'INVALID_URL')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === '') throw new StockImageError('URL has no host', 'INVALID_URL')
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) {
    throw new StockImageError(`refusing to fetch a local host: ${host}`, 'BLOCKED_HOST')
  }
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) {
      throw new StockImageError(`refusing to fetch a private address: ${host}`, 'BLOCKED_HOST')
    }
    return url
  }
  let records
  try {
    records = await dnsLookup(host, { all: true, verbatim: true })
  } catch {
    throw new StockImageError(`cannot resolve host: ${host}`, 'DNS_FAILURE')
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new StockImageError(`cannot resolve host: ${host}`, 'DNS_FAILURE')
  }
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new StockImageError(`refusing to fetch ${host}: it resolves to a private address`, 'BLOCKED_HOST')
    }
  }
  return url
}

/** Combine abort signals, tolerating runtimes without `AbortSignal.any`. */
function anySignal(signals) {
  const active = signals.filter((signal) => signal !== undefined && signal !== null)
  if (active.length === 0) return undefined
  if (active.length === 1) return active[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(active)
  const controller = new AbortController()
  const abort = () => controller.abort()
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener('abort', abort, { once: true })
  }
  return controller.signal
}

/** Read a bounded body from a fetch Response; aborts once the cap is crossed. */
async function readBoundedBody(response, maxBytes, signal) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new StockImageError(
      `response is too large (${formatBytes(declared)} > ${formatBytes(maxBytes)})`,
      'RESPONSE_TOO_LARGE'
    )
  }
  if (response.body === null || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) {
      throw new StockImageError(`response exceeds ${formatBytes(maxBytes)}`, 'RESPONSE_TOO_LARGE')
    }
    return buffer
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      if (signal?.aborted === true) throw new StockImageError('request aborted', 'ABORTED')
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      total += chunk.length
      if (total > maxBytes) {
        throw new StockImageError(`response exceeds ${formatBytes(maxBytes)}`, 'RESPONSE_TOO_LARGE')
      }
      chunks.push(chunk)
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* already finished */
    }
  }
  return Buffer.concat(chunks, total)
}

/**
 * One guarded HTTPS GET.
 * Returns `{ status, headers, bytes, url }`; non-2xx is returned, not thrown,
 * so callers can turn provider errors into status notes.
 */
async function fetchBuffer(rawUrl, options = {}) {
  const {
    headers = {},
    signal,
    maxBytes = MAX_JSON_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    accept = '*/*'
  } = options
  let currentUrl = await assertPublicHttpsUrl(rawUrl)
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = anySignal([signal, timeout]) ?? timeout

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response
    try {
      response = await fetch(currentUrl, {
        method: 'GET',
        headers: {
          accept,
          'user-agent': USER_AGENT,
          ...headers
        },
        redirect: 'manual',
        signal: combined
      })
    } catch (error) {
      if (error?.name === 'TimeoutError') {
        throw new StockImageError(`request timed out after ${timeoutMs}ms: ${currentUrl.host}`, 'TIMEOUT')
      }
      if (error?.name === 'AbortError') {
        throw new StockImageError('request aborted', 'ABORTED')
      }
      throw new StockImageError(`request failed: ${error instanceof Error ? error.message : String(error)}`, 'NETWORK_ERROR')
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      try {
        await response.body?.cancel()
      } catch {
        /* ignore */
      }
      if (location === null || location === '') {
        throw new StockImageError(`redirect without Location from ${currentUrl.host}`, 'BAD_REDIRECT')
      }
      currentUrl = await assertPublicHttpsUrl(new URL(location, currentUrl).href)
      continue
    }

    const bytes = response.status === 204 ? Buffer.alloc(0) : await readBoundedBody(response, maxBytes, combined)
    return { status: response.status, headers: response.headers, bytes, url: currentUrl.href }
  }
  throw new StockImageError('too many redirects', 'TOO_MANY_REDIRECTS')
}

/** JSON GET with a provider-friendly error message. */
async function fetchJson(rawUrl, options = {}) {
  const response = await fetchBuffer(rawUrl, { ...options, accept: 'application/json' })
  if (response.status < 200 || response.status >= 300) {
    const detail = cleanText(response.bytes.toString('utf8')).slice(0, 200)
    throw new StockImageError(
      `provider returned HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`,
      `PROVIDER_HTTP_${response.status}`
    )
  }
  try {
    return JSON.parse(response.bytes.toString('utf8'))
  } catch {
    throw new StockImageError('provider returned invalid JSON', 'PROVIDER_BAD_JSON')
  }
}

/* ------------------------------------------------------------------------- *
 * Image type sniffing
 * ------------------------------------------------------------------------- */

/**
 * Identify a raster image from its signature bytes.
 * Returns `{ mime, extension }` or null when the bytes are not a supported image.
 */
export function sniffImageType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', extension: '.jpg' }
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mime: 'image/png', extension: '.png' }
  }
  const header = bytes.subarray(0, 12).toString('latin1')
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return { mime: 'image/gif', extension: '.gif' }
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return { mime: 'image/webp', extension: '.webp' }
  }
  if (header.slice(4, 8) === 'ftyp') {
    const brand = header.slice(8, 12)
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', extension: '.avif' }
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return { mime: 'image/heic', extension: '.heic' }
  }
  return null
}

/** Provider-neutral orientation mapping. */
function normalizeOrientation(value) {
  if (typeof value !== 'string') return 'any'
  const lower = value.toLowerCase()
  if (lower === 'landscape' || lower === 'horizontal') return 'landscape'
  if (lower === 'portrait' || lower === 'vertical') return 'portrait'
  if (lower === 'square' || lower === 'squarish') return 'square'
  return 'any'
}

/** Drop results below `minWidth` and outside the requested orientation. */
function filterItems(items, { minWidth, orientation }) {
  return items.filter((item) => {
    if (!Number.isFinite(item.width) || !Number.isFinite(item.height)) return true
    if (item.width < minWidth) return false
    if (orientation === 'landscape' && item.width <= item.height) return false
    if (orientation === 'portrait' && item.width >= item.height) return false
    if (orientation === 'square') {
      const ratio = item.width / item.height
      if (ratio < 0.85 || ratio > 1.18) return false
    }
    return true
  })
}

/* ------------------------------------------------------------------------- *
 * Query helpers shared by the providers
 * ------------------------------------------------------------------------- */

/** True when the text contains CJK characters. */
function hasCjk(text) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text)
}

/**
 * Pexels/Pixabay/Unsplash index English metadata, so a CJK query rarely
 * matches there. Prefer `alt_query` for those three when it is non-empty.
 */
function latinQuery(primary, alternative) {
  // Only swap in the alternative when the primary query cannot match a
  // Latin-script index (a CJK name). A Latin primary always stays primary.
  if (alternative !== '' && hasCjk(primary)) return alternative
  return primary
}

/**
 * Query forms to try for one provider.
 *
 * Key-based libraries index English metadata, so `latinQuery` already swaps in
 * the alternative form. The key-free libraries accept any language, but their
 * indexes are uneven: a CJK name often matches in Openverse/Wikimedia while the
 * English name matches in one and not the other, so both forms are tried and
 * the first non-empty answer wins.
 */
function providerQueries(provider, args) {
  if (provider.requiresKey) return [latinQuery(args.query, args.altQuery)]
  const queries = [args.query]
  if (args.altQuery !== '' && args.altQuery !== args.query) queries.push(args.altQuery)
  return queries
}

/** Append the Unsplash referral parameters required by its attribution rules. */
function withUnsplashUtm(rawUrl) {
  try {
    const url = new URL(rawUrl)
    url.searchParams.set('utm_source', 'dsh_stock_images')
    url.searchParams.set('utm_medium', 'referral')
    return url.href
  } catch {
    return rawUrl
  }
}

/** Build `/v1/search`-style URLs without leaking undefined parameters. */
function buildUrl(base, params) {
  const url = new URL(base)
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url.href
}

/* ------------------------------------------------------------------------- *
 * Rights policy
 *
 * The plugin only surfaces and saves material whose license is verified to
 * allow commercial use and modification. Anything else — non-commercial,
 * no-derivatives, "all rights reserved", an unknown license text, or a
 * platform we cannot classify — is dropped before it reaches the model, and
 * the download tool refuses URLs that no validated search produced.
 * ------------------------------------------------------------------------- */

/** Platform licenses: commercial use and modification allowed. */
const PLATFORM_LICENSES = Object.freeze({
  pexels: { license: 'Pexels License', attributionRequired: true },
  pixabay: { license: 'Pixabay Content License', attributionRequired: false },
  unsplash: { license: 'Unsplash License', attributionRequired: true }
})

/** Human-readable note for each risk flag. */
const RISK_NOTES = Object.freeze({
  personality:
    'identifiable people: personality/publicity rights may apply — normally fine for editorial use, a model release is needed for advertising or implied endorsement',
  trademark: 'contains trademarks or logos: do not imply endorsement by the brand',
  'share-alike':
    'share-alike license: any modified version (crop, text overlay, edit) must carry the same license',
  attribution: 'attribution is a license condition: keep the credit line with the image'
})

/**
 * Classify one result's license.
 *
 * @param {{ source?: string, license?: string, licenseUrl?: string, attributionRequired?: boolean, restrictions?: string[] }} item
 * @returns {{ allowed: boolean, reason: string, commercial: boolean, derivatives: boolean,
 *             attributionRequired: boolean, risk: 'low'|'medium', notes: string[], shareAlike: boolean }}
 */
export function assessRights(item) {
  const source = cleanText(item?.source).toLowerCase()
  const text = cleanText(item?.license)
  const lower = `${text} ${cleanText(item?.licenseUrl)}`.toLowerCase()
  // License names arrive as free text: "CC BY-NC 4.0", "CC BY NC 4.0",
  // "Attribution-NonCommercial 4.0" and "BY NC ND" all mean the same thing.
  // Matching runs against a separator-free form so spacing cannot slip through.
  const flat = lower.replace(/[^a-z0-9]+/g, '')
  const notes = []
  let risk = 'low'
  let shareAlike = false

  const deny = (reason) => ({
    allowed: false,
    reason,
    commercial: false,
    derivatives: false,
    attributionRequired: false,
    risk: 'medium',
    notes,
    shareAlike: false
  })

  // Separators cannot hide a restriction: "CC BY-NC"、"CC BY NC"、"BY/NC" all
  // normalize to tokens that contain `nc`, and a bare `nd` token means
  // NoDerivatives. Matching runs on both the separator-free form and the
  // token list so neither spacing nor punctuation can slip through.
  const tokens = lower.split(/[^a-z0-9]+/).filter((token) => token !== '')

  if (source === 'openverse' || source === 'wikimedia') {
    if (
      /bync|ncnd|ncsa|noncommercial/.test(flat) ||
      tokens.includes('nc') ||
      tokens.includes('noncommercial')
    ) {
      return deny('non-commercial license')
    }
    if (/bynd|noderiv|noderivatives/.test(flat) || tokens.includes('nd') || tokens.includes('noderivatives')) {
      return deny('no-derivatives license')
    }
    if (/allrightsreserved|nonfree|fairuse|editorialuseonly|copyrightonly|nolicense/.test(flat)) {
      return deny('restricted or editorial-only license')
    }
  }

  let commercial = false
  let derivatives = false
  let attributionRequired = item?.attributionRequired === true

  if (PLATFORM_LICENSES[source] !== undefined) {
    commercial = true
    derivatives = true
    attributionRequired = attributionRequired || PLATFORM_LICENSES[source].attributionRequired
  } else if (
    /cc0|publicdomain|pdm|norestrictions/.test(flat) ||
    /\bpd-(usgov|art|old|self|us|uk)\b/i.test(text)
  ) {
    commercial = true
    derivatives = true
  } else if (/bysa|attributionsharealike/.test(flat)) {
    commercial = true
    derivatives = true
    attributionRequired = true
    shareAlike = true
  } else if (/ccby|creativecommonsattribution|attribution/.test(flat)) {
    commercial = true
    derivatives = true
    attributionRequired = true
  } else if (/opengovernment|godl/.test(flat) || /\bogl\b/i.test(text)) {
    commercial = true
    derivatives = true
    attributionRequired = true
    notes.push('government open-data license: keep the attribution notice')
  } else {
    return deny(`unrecognized license "${text === '' ? 'none given' : text}"`)
  }

  if (attributionRequired) {
    notes.push(RISK_NOTES.attribution)
    risk = 'medium'
  }
  if (shareAlike) {
    notes.push(RISK_NOTES['share-alike'])
    risk = 'medium'
  }
  for (const restriction of Array.isArray(item?.restrictions) ? item.restrictions : []) {
    const key = cleanText(restriction).toLowerCase()
    if (key === 'personality') {
      notes.push(RISK_NOTES.personality)
      risk = 'medium'
    } else if (key === 'trademark' || key === 'insignia') {
      notes.push(RISK_NOTES.trademark)
      risk = 'medium'
    } else if (key !== '') {
      notes.push(`usage restriction on the source page: "${key}" — check it before publishing`)
      risk = 'medium'
    }
  }

  return {
    allowed: true,
    reason: '',
    commercial,
    derivatives,
    attributionRequired,
    risk,
    notes,
    shareAlike
  }
}

/** Compact one-line rights summary for the model. */
function describeRights(rights) {
  const parts = [
    rights.commercial ? 'commercial use OK' : 'commercial use NOT allowed',
    rights.derivatives ? 'modification OK' : 'modification NOT allowed',
    rights.attributionRequired ? 'attribution required' : 'no attribution required'
  ]
  return `${parts.join(' · ')} · risk: ${rights.risk}`
}

/* ------------------------------------------------------------------------- *
 * Providers
 *
 * Each provider exposes `buildRequest(args, key)` (pure, unit-tested) and
 * `normalize(payload, args)` (pure, unit-tested). `runProvider` joins them
 * with the guarded HTTP client.
 * ------------------------------------------------------------------------- */

/** Provider catalog, in the order results are interleaved. */
const PROVIDERS = [
  {
    id: 'pexels',
    label: 'Pexels',
    requiresKey: true,
    keyRef: KEY_REFS.pexels,
    homepage: 'https://www.pexels.com',
    docsUrl: 'https://www.pexels.com/api/documentation/',
    limits: '200 requests/hour and 20,000/month with a free key',
    license: 'Pexels License',
    licenseUrl: 'https://www.pexels.com/license/',
    attributionRule: 'Link to Pexels and credit the photographer',
    maxPerRequest: 80,
    buildRequest(args, key) {
      return {
        url: buildUrl('https://api.pexels.com/v1/search', {
          query: latinQuery(args.query, args.altQuery),
          per_page: args.perSource,
          page: 1,
          orientation: args.orientation === 'square' ? 'square' : args.orientation === 'any' ? '' : args.orientation
        }),
        headers: { authorization: key }
      }
    },
    normalize(payload) {
      const photos = Array.isArray(payload?.photos) ? payload.photos : []
      return photos.map((photo) => {
        const source = photo?.src ?? {}
        const pageUrl = cleanText(photo?.url)
        const creator = cleanText(photo?.photographer)
        return {
          source: 'pexels',
          id: String(photo?.id ?? ''),
          title: cleanText(photo?.alt),
          creator,
          creatorUrl: cleanText(photo?.photographer_url),
          width: Number(photo?.width),
          height: Number(photo?.height),
          license: 'Pexels License',
          licenseUrl: 'https://www.pexels.com/license/',
          attribution: creator === '' ? `Pexels — ${pageUrl}` : `Photo by ${creator} on Pexels — ${pageUrl}`,
          pageUrl,
          previewUrl: cleanText(source.large) || cleanText(source.medium),
          downloadUrl: cleanText(source.original) || cleanText(source.large2x) || cleanText(source.large)
        }
      })
    }
  },
  {
    id: 'pixabay',
    label: 'Pixabay',
    requiresKey: true,
    keyRef: KEY_REFS.pixabay,
    homepage: 'https://pixabay.com',
    docsUrl: 'https://pixabay.com/api/docs/',
    limits: '100 requests/minute with a free key; results must not be stored more than 24h',
    license: 'Pixabay Content License',
    licenseUrl: 'https://pixabay.com/service/license-summary/',
    attributionRule: 'Tell users the images come from Pixabay; permanent hotlinking is not allowed',
    maxPerRequest: 200,
    buildRequest(args, key) {
      return {
        url: buildUrl('https://pixabay.com/api/', {
          key,
          q: latinQuery(args.query, args.altQuery).slice(0, 100),
          image_type: 'photo',
          safesearch: 'true',
          per_page: args.perSource,
          page: 1,
          orientation:
            args.orientation === 'landscape' ? 'horizontal' : args.orientation === 'portrait' ? 'vertical' : ''
        }),
        headers: {}
      }
    },
    normalize(payload) {
      const hits = Array.isArray(payload?.hits) ? payload.hits : []
      return hits.map((hit) => {
        const pageUrl = cleanText(hit?.pageURL)
        const creator = cleanText(hit?.user)
        return {
          source: 'pixabay',
          id: String(hit?.id ?? ''),
          title: cleanText(hit?.tags),
          creator,
          creatorUrl: creator === '' ? '' : `https://pixabay.com/users/${encodeURIComponent(creator)}-${hit?.user_id ?? ''}/`,
          width: Number(hit?.imageWidth),
          height: Number(hit?.imageHeight),
          license: 'Pixabay Content License',
          licenseUrl: 'https://pixabay.com/service/license-summary/',
          attribution: creator === '' ? `Pixabay — ${pageUrl}` : `Image by ${creator} on Pixabay — ${pageUrl}`,
          pageUrl,
          previewUrl: cleanText(hit?.webformatURL),
          // `largeImageURL` (1280px) is the largest size a default API key returns.
          downloadUrl: cleanText(hit?.largeImageURL) || cleanText(hit?.webformatURL)
        }
      })
    }
  },
  {
    id: 'unsplash',
    label: 'Unsplash',
    requiresKey: true,
    keyRef: KEY_REFS.unsplash,
    homepage: 'https://unsplash.com',
    docsUrl: 'https://unsplash.com/documentation',
    limits: '50 requests/hour for a demo app, 1,000/hour after production approval',
    license: 'Unsplash License',
    licenseUrl: 'https://unsplash.com/license',
    attributionRule: 'Credit Unsplash and the photographer with referral links, and call download_location when saving',
    maxPerRequest: 30,
    buildRequest(args, key) {
      return {
        url: buildUrl('https://api.unsplash.com/search/photos', {
          query: latinQuery(args.query, args.altQuery),
          per_page: args.perSource,
          page: 1,
          orientation: args.orientation === 'square' ? 'squarish' : args.orientation === 'any' ? '' : args.orientation
        }),
        headers: { authorization: `Client-ID ${key}` }
      }
    },
    normalize(payload) {
      const results = Array.isArray(payload?.results) ? payload.results : []
      return results
        .filter((photo) => {
          const full = cleanText(photo?.urls?.full) || cleanText(photo?.urls?.regular)
          if (full === '') return false
          try {
            return !isUnsplashPlusHost(new URL(full).hostname.toLowerCase())
          } catch {
            return false
          }
        })
        .map((photo) => {
        const user = photo?.user ?? {}
        const links = photo?.links ?? {}
        const urls = photo?.urls ?? {}
        const creator = cleanText(user.name)
        const pageUrl = withUnsplashUtm(cleanText(links.html))
        return {
          source: 'unsplash',
          id: String(photo?.id ?? ''),
          title: cleanText(photo?.alt_description) || cleanText(photo?.description),
          creator,
          creatorUrl: withUnsplashUtm(cleanText(user?.links?.html)),
          width: Number(photo?.width),
          height: Number(photo?.height),
          license: 'Unsplash License',
          licenseUrl: 'https://unsplash.com/license',
          attribution:
            creator === ''
              ? `Unsplash — ${pageUrl}`
              : `Photo by ${creator} on Unsplash (${withUnsplashUtm(cleanText(user?.links?.html))}) — ${pageUrl}`,
          pageUrl,
          // Hotlinking `urls.*` is required by the Unsplash API guidelines.
          previewUrl: cleanText(urls.small) || cleanText(urls.regular),
          downloadUrl: cleanText(urls.full) || cleanText(urls.regular),
          // Must be requested when the image is saved, per the API guidelines.
          trackUrl: cleanText(links.download_location)
        }
      })
    }
  },
  {
    id: 'openverse',
    label: 'Openverse',
    requiresKey: false,
    keyRef: null,
    homepage: 'https://openverse.org',
    docsUrl: 'https://api.openverse.org/v1/',
    limits: 'no key needed; anonymous limit 20 requests/minute and 200/day',
    license: 'Creative Commons (per result)',
    licenseUrl: 'https://creativecommons.org/licenses/',
    attributionRule: 'Keep the license and creator notice from the attribution field',
    maxPerRequest: 20,
    buildRequest(args) {
      return {
        url: buildUrl('https://api.openverse.org/v1/images/', {
          q: args.query,
          page_size: args.perSource,
          page: 1,
          mature: 'false',
          filter_dead: 'true',
          // Commercial use plus modification: BY, BY-SA, CC0 and public domain.
          // Non-commercial and no-derivatives licenses are never requested.
          license_type: 'commercial',
          license: 'by,by-sa,cc0,pdm',
          aspect_ratio:
            args.orientation === 'landscape' ? 'wide' : args.orientation === 'portrait' ? 'tall' : args.orientation === 'square' ? 'square' : ''
        }),
        headers: {}
      }
    },
    normalize(payload) {
      const results = Array.isArray(payload?.results) ? payload.results : []
      return results.map((image) => {
        const licenseCode = cleanText(image?.license).toUpperCase()
        const licenseVersion = cleanText(image?.license_version)
        // Openverse returns codes such as `by`, `by-sa`, `cc0` or `pdm`.
        const license =
          licenseCode === ''
            ? 'Creative Commons'
            : licenseCode === 'CC0'
              ? 'CC0'
              : licenseCode === 'PDM'
                ? 'Public domain mark'
                : `${licenseCode === 'BY' || licenseCode.startsWith('BY-') ? 'CC ' : ''}${licenseCode}${licenseVersion === '' ? '' : ` ${licenseVersion}`}`
        const creator = cleanText(image?.creator)
        const attribution = cleanText(image?.attribution)
        return {
          source: 'openverse',
          id: String(image?.id ?? ''),
          title: cleanText(image?.title),
          creator,
          creatorUrl: cleanText(image?.creator_url),
          width: Number(image?.width),
          height: Number(image?.height),
          license,
          licenseUrl: cleanText(image?.license_url),
          attribution:
            attribution !== ''
              ? attribution
              : `${creator === '' ? 'Unknown creator' : creator} — ${license}${cleanText(image?.license_url) === '' ? '' : ` (${cleanText(image?.license_url)})`}`,
          pageUrl: cleanText(image?.foreign_landing_url) || cleanText(image?.detail_url),
          previewUrl: cleanText(image?.thumbnail),
          downloadUrl: cleanText(image?.url)
        }
      })
    }
  },
  {
    id: 'wikimedia',
    label: 'Wikimedia Commons',
    requiresKey: false,
    keyRef: null,
    homepage: 'https://commons.wikimedia.org',
    docsUrl: 'https://commons.wikimedia.org/wiki/Special:MyLanguage/Commons:First_steps/Reuse',
    limits: 'no key needed; send a descriptive User-Agent and avoid parallel requests',
    license: 'Per file (CC0/CC BY/CC BY-SA/public domain)',
    licenseUrl: 'https://commons.wikimedia.org/wiki/Commons:Licensing',
    attributionRule: 'Credit the author and license exactly as the file page requires',
    maxPerRequest: 20,
    buildRequest(args) {
      return {
        url: buildUrl('https://commons.wikimedia.org/w/api.php', {
          action: 'query',
          format: 'json',
          formatversion: 2,
          generator: 'search',
          gsrsearch: `${args.query} filetype:bitmap`,
          gsrnamespace: 6,
          gsrlimit: args.perSource,
          prop: 'imageinfo',
          iiprop: 'url|size|mime|extmetadata',
          iiurlwidth: 640
        }),
        headers: {}
      }
    },
    normalize(payload) {
      const pages = Array.isArray(payload?.query?.pages) ? payload.query.pages : []
      const items = []
      for (const page of pages) {
        const info = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : undefined
        if (info === undefined) continue
        const mime = cleanText(info.mime).toLowerCase()
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) continue
        const meta = info?.extmetadata ?? {}
        const title = cleanText(page?.title).replace(/^File:/i, '').replace(/\.[a-z0-9]+$/i, '')
        const creator = stripHtml(meta?.Artist?.value) || stripHtml(meta?.Credit?.value)
        const licenseShortName = stripHtml(meta?.LicenseShortName?.value)
        const usageTerms = stripHtml(meta?.UsageTerms?.value)
        const license = licenseShortName || usageTerms || 'unknown'
        const licenseUrl = cleanText(meta?.LicenseUrl?.value)
        const restrictions = stripHtml(meta?.Restrictions?.value)
          .toLowerCase()
          .split(/[,;\s]+/)
          .filter((entry) => entry !== '')
        items.push({
          source: 'wikimedia',
          id: String(page?.pageid ?? ''),
          title,
          creator,
          creatorUrl: cleanText(meta?.Artist?.value).startsWith('http') ? stripHtml(meta.Artist.value) : '',
          width: Number(info?.width),
          height: Number(info?.height),
          license,
          licenseUrl,
          attribution: `${creator === '' ? 'Wikimedia Commons' : creator} — Wikimedia Commons — ${license}`,
          pageUrl: cleanText(info?.descriptionurl),
          previewUrl: cleanText(info?.thumburl) || cleanText(info?.url),
          downloadUrl: cleanText(info?.url),
          // `AttributionRequired` is a string in extmetadata; empty / "false" means no.
          attributionRequired: cleanText(meta?.AttributionRequired?.value).toLowerCase() === 'true',
          // `personality`, `trademark`, `insignia`, ... raise the risk flag.
          restrictions,
          usageTerms
        })
      }
      return items
    }
  }
]

/** Look a provider up by id. */
function providerById(id) {
  return PROVIDERS.find((provider) => provider.id === id)
}

/**
 * Try each query form for one provider. A failing key/rate limit stops the
 * attempt immediately; an empty answer moves on to the next form.
 */
async function runProviderQueries(provider, args, key, signal) {
  const queries = providerQueries(provider, args)
  const refused = new Map()
  const mergeRefused = (excluded) => {
    for (const group of excluded ?? []) {
      refused.set(group.reason, (refused.get(group.reason) ?? 0) + group.count)
    }
  }
  const collect = () => [...refused.entries()].map(([reason, count]) => ({ reason, count }))
  let lastError
  for (const query of queries) {
    try {
      const result = await runProvider(provider, { ...args, query, altQuery: '' }, key, signal)
      mergeRefused(result.excluded)
      if (result.items.length > 0) return { items: result.items, excluded: collect() }
    } catch (error) {
      lastError = error
      const code = typeof error?.code === 'string' ? error.code : ''
      const transientQueryProblem = code === 'PROVIDER_HTTP_400' || code === 'PROVIDER_HTTP_404'
      if (!transientQueryProblem) break
    }
    if (queries.length === 1) break
  }
  if (lastError !== undefined) throw lastError
  return { items: [], excluded: collect() }
}

/**
 * Run one provider: build the request, fetch JSON, normalize, drop anything the
 * rights policy refuses, then apply the size/orientation filter.
 *
 * Returns `{ items, excluded }`; `excluded` carries one `{ reason, count }` per
 * rejection class so the tool can tell the model what it filtered out.
 */
async function runProvider(provider, args, key, signal) {
  const request = provider.buildRequest(args, key)
  const payload = await fetchJson(request.url, { headers: request.headers, signal })
  const rawItems = provider.normalize(payload, args)
  const excludedByReason = new Map()
  const accepted = []
  for (const item of rawItems) {
    if (typeof item.downloadUrl !== 'string' || !item.downloadUrl.startsWith('https://')) {
      excludedByReason.set('not a usable https image URL', (excludedByReason.get('not a usable https image URL') ?? 0) + 1)
      continue
    }
    const rights = assessRights(item)
    if (!rights.allowed) {
      excludedByReason.set(rights.reason, (excludedByReason.get(rights.reason) ?? 0) + 1)
      continue
    }
    accepted.push({ ...item, rights })
  }
  const inRange = filterItems(accepted, { minWidth: args.minWidth, orientation: args.orientation })
  const excluded = [...excludedByReason.entries()].map(([reason, count]) => ({ reason, count }))
  return { items: inRange.slice(0, provider.maxPerRequest), excluded }
}

/* ------------------------------------------------------------------------- *
 * Argument validation
 * ------------------------------------------------------------------------- */

/** Argument error with a model-facing message. */
class ToolArgsError extends StockImageError {
  constructor(message) {
    super(`invalid arguments: ${message}`, 'INVALID_ARGS')
    this.name = 'ToolArgsError'
  }
}

/** Read an optional trimmed string argument. */
function optionalString(args, field, maxLength = 400) {
  const value = args?.[field]
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new ToolArgsError(`${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length > maxLength) throw new ToolArgsError(`${field} is longer than ${maxLength} characters`)
  return trimmed
}

/** Validate and normalize `stock_image_search` arguments. */
function validateSearchArgs(raw) {
  const args = raw ?? {}
  const query = optionalString(args, 'query', 300)
  if (query === '') throw new ToolArgsError('query must be a non-empty string')
  const altQuery = optionalString(args, 'alt_query', 300)
  const rawSources = args.sources
  const sources = []
  if (rawSources !== undefined && rawSources !== null) {
    if (!Array.isArray(rawSources)) throw new ToolArgsError('sources must be an array of provider ids')
    for (const entry of rawSources) {
      if (typeof entry !== 'string') throw new ToolArgsError('sources must contain provider ids')
      const provider = providerById(entry.trim().toLowerCase())
      if (provider === undefined) {
        throw new ToolArgsError(
          `unknown source "${entry}"; available sources: ${PROVIDERS.map((item) => item.id).join(', ')}`
        )
      }
      if (!sources.includes(provider.id)) sources.push(provider.id)
    }
  }
  return {
    query,
    altQuery,
    sources,
    orientation: normalizeOrientation(args.orientation),
    count: clampInt(args.count, 8, 1, 20),
    minWidth: clampInt(args.min_width, 800, 0, 20000)
  }
}

/** Validate and normalize `stock_image_download` arguments. */
function validateDownloadArgs(raw) {
  const args = raw ?? {}
  const url = optionalString(args, 'url', 2000)
  if (url === '') throw new ToolArgsError('url must be a non-empty string')
  if (!url.startsWith('https://')) throw new ToolArgsError('url must be an https URL')
  const source = optionalString(args, 'source', 40).toLowerCase()
  if (source !== '' && providerById(source) === undefined) {
    throw new ToolArgsError(
      `unknown source "${source}"; available sources: ${PROVIDERS.map((item) => item.id).join(', ')}`
    )
  }
  return {
    url,
    source,
    filename: optionalString(args, 'filename', 120),
    directory: optionalString(args, 'directory', 200) || DEFAULT_DOWNLOAD_DIR,
    attribution: args.attribution === undefined ? true : args.attribution !== false
  }
}

/* ------------------------------------------------------------------------- *
 * Provider failures and credentials
 * ------------------------------------------------------------------------- */

/** Turn a provider failure into a short model-facing status line. */
function describeProviderFailure(provider, error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  const status = /^PROVIDER_HTTP_(\d{3})$/.exec(code)
  if (status !== null) {
    const httpStatus = status[1]
    if (httpStatus === '401' || httpStatus === '403') {
      return provider.keyRef === null
        ? `${provider.label} refused the request (HTTP ${httpStatus}); retry later`
        : `${provider.label} rejected the API key (HTTP ${httpStatus}); check ${provider.keyRef} on the plugin settings page`
    }
    if (httpStatus === '429') return `${provider.label} rate limit reached; wait and retry`
    return `${provider.label} returned HTTP ${httpStatus}`
  }
  if (code === 'TIMEOUT') return `${provider.label} timed out; retry later`
  return `${provider.label}: ${error instanceof Error ? error.message : String(error)}`
}

/** Where a missing key is configured. */
function keySetupHint(provider) {
  return `set ${provider.keyRef} on the plugin settings page (Plugins → Stock images) or in the DSH credential store`
}

/**
 * Read one credential ref through `ctx.credentials`, falling back to the
 * process environment. The store already layers environment values; the
 * fallback keeps the plugin usable in a bare composition.
 */
function createKeyReader(ctx) {
  return async function readKey(ref) {
    if (typeof ref !== 'string' || ref === '') return undefined
    let credentials
    try {
      credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
    } catch {
      credentials = undefined
    }
    if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
      try {
        const hit = await credentials.resolve(ref)
        const value = typeof hit?.value === 'string' ? hit.value.trim() : ''
        if (value !== '') {
          return { value, source: typeof hit.source === 'string' && hit.source !== '' ? hit.source : 'credentials' }
        }
      } catch {
        /* fall through to the environment */
      }
    }
    const fromEnv = process.env[ref]
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
      return { value: fromEnv.trim(), source: 'environment' }
    }
    return undefined
  }
}

/* ------------------------------------------------------------------------- *
 * Search-result cache
 *
 * Download reuses the metadata of the search that produced the URL: the
 * Unsplash download callback, the credit line and the provider id. Keyed by
 * download URL, bounded, short-lived and process-local by design.
 * ------------------------------------------------------------------------- */

const SEARCH_CACHE_LIMIT = 1000
const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000
const searchCache = new Map()

function cacheSearchItems(items) {
  const now = Date.now()
  for (const item of items) {
    if (typeof item.downloadUrl !== 'string' || item.downloadUrl === '') continue
    searchCache.delete(item.downloadUrl)
    searchCache.set(item.downloadUrl, { item, at: now })
  }
  while (searchCache.size > SEARCH_CACHE_LIMIT) {
    const oldest = searchCache.keys().next()
    if (oldest.done === true) break
    searchCache.delete(oldest.value)
  }
}

function cachedSearchItem(url) {
  const hit = searchCache.get(url)
  if (hit === undefined) return undefined
  if (Date.now() - hit.at > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(url)
    return undefined
  }
  return hit.item
}

/* ------------------------------------------------------------------------- *
 * Operations
 * ------------------------------------------------------------------------- */

/**
 * Search every enabled provider, interleave the results, and report one status
 * line per provider. One failing provider never fails the whole search.
 */
async function performSearch({ readKey, args, signal, logger }) {
  if (signal?.aborted === true) throw new StockImageError('search aborted', 'ABORTED')

  const selected =
    args.sources.length === 0 ? PROVIDERS : PROVIDERS.filter((provider) => args.sources.includes(provider.id))
  const ready = []
  const statuses = new Map()
  for (const provider of selected) {
    if (!provider.requiresKey) {
      ready.push({ provider, key: undefined })
      continue
    }
    const key = await readKey(provider.keyRef)
    if (key === undefined) {
      statuses.set(provider.id, {
        status: 'unconfigured',
        note: `${provider.keyRef} not configured — add it on the plugin settings page`
      })
      continue
    }
    ready.push({ provider, key: key.value })
  }

  if (ready.length === 0) {
    throw new StockImageError(
      `no image provider is available for this search. ${PROVIDERS.filter((provider) => provider.requiresKey)
        .map((provider) => `Set ${provider.keyRef} for ${provider.label}`)
        .join(', ')}, or keep the key-free providers: Openverse and Wikimedia Commons work without a key.`,
      'NO_PROVIDER'
    )
  }

  // Ask for more than `count / providers` so a strict orientation filter still
  // leaves enough candidates to fill the requested total.
  const perSource = Math.min(20, Math.max(4, Math.ceil(args.count / ready.length) + 3))
  const settled = await Promise.all(
    ready.map(async ({ provider, key }) => {
      try {
        const result = await runProviderQueries(provider, { ...args, perSource }, key, signal)
        return { provider, items: result.items, excluded: result.excluded }
      } catch (error) {
        if (typeof logger?.warn === 'function') {
          logger.warn(
            `dsh-stock-images: ${provider.id} search failed: ${error instanceof Error ? error.message : String(error)}`
          )
        }
        return { provider, error }
      }
    })
  )

  const buckets = []
  const excluded = []
  for (const entry of settled) {
    for (const group of entry.excluded ?? []) {
      excluded.push({ source: entry.provider.id, reason: group.reason, count: group.count })
    }
    if (entry.error !== undefined) {
      statuses.set(entry.provider.id, { status: 'error', note: describeProviderFailure(entry.provider, entry.error) })
      continue
    }
    if (entry.items.length === 0) {
      const filtered =
        entry.excluded === undefined || entry.excluded.length === 0
          ? ''
          : ` (${entry.excluded.map((group) => `${group.count} refused: ${group.reason}`).join('; ')})`
      statuses.set(entry.provider.id, { status: 'empty', note: `no usable image${filtered}` })
      continue
    }
    buckets.push(entry)
    const filtered =
      entry.excluded === undefined || entry.excluded.length === 0
        ? ''
        : `; ${entry.excluded.map((group) => `${group.count} refused: ${group.reason}`).join('; ')}`
    statuses.set(entry.provider.id, {
      status: 'ok',
      note: `${entry.items.length} match${entry.items.length === 1 ? '' : 'es'}${filtered}`
    })
  }

  // Round-robin across providers so the first results are not all from one source.
  const merged = []
  const seen = new Set()
  for (let index = 0; merged.length < args.count; index += 1) {
    let available = 0
    for (const bucket of buckets) {
      const item = bucket.items[index]
      if (item === undefined) continue
      available += 1
      if (seen.has(item.downloadUrl)) continue
      seen.add(item.downloadUrl)
      merged.push(item)
      if (merged.length >= args.count) break
    }
    if (available === 0) break
  }

  if (merged.length === 0) {
    const reasons = [...statuses.values()].map((state) => state.note).filter((note) => typeof note === 'string')
    throw new StockImageError(
      `no provider returned an image for "${args.query}"${reasons.length === 0 ? '' : ` — ${reasons.join('; ')}`}`,
      'NO_RESULTS'
    )
  }

  const results = merged.slice(0, args.count).map((item, index) => ({
    n: index + 1,
    source: item.source,
    id: item.id,
    title: item.title,
    creator: item.creator,
    width: Number.isFinite(item.width) ? item.width : null,
    height: Number.isFinite(item.height) ? item.height : null,
    license: item.license,
    license_url: item.licenseUrl,
    attribution: item.attribution,
    rights: describeRights(item.rights),
    risk: item.rights.risk,
    rights_notes: item.rights.notes,
    page_url: item.pageUrl,
    preview_url: item.previewUrl,
    download_url: item.downloadUrl
  }))
  cacheSearchItems(merged)

  const providers = selected.map((provider) => {
    const state = statuses.get(provider.id) ?? { status: 'skipped', note: 'not used for this search' }
    return {
      id: provider.id,
      label: provider.label,
      requires_key: provider.requiresKey,
      key_ref: provider.keyRef,
      status: state.status,
      note: state.note
    }
  })

  const notes = []
  if (excluded.length > 0) {
    notes.push(
      `Refused ${excluded.reduce((total, group) => total + group.count, 0)} result(s) on license grounds: ${excluded
        .map((group) => `${group.count} ${group.reason}`)
        .join(', ')}. Only commercial-use, modification-allowed licenses are returned.`
    )
  }
  if (results.some((result) => result.risk === 'medium')) {
    notes.push(
      'Some results carry rights notes (attribution, share-alike, personality or trademark). Read the rights line before publishing; use them editorially, not as an implied endorsement.'
    )
  }
  if (results.some((result) => result.source === 'pexels')) {
    notes.push('Pexels API terms: show a link to Pexels and credit the photographer when you publish.')
  }
  if (results.some((result) => result.source === 'pixabay')) {
    notes.push('Pixabay terms: say that the image comes from Pixabay, and do not resell it as a standalone file.')
  }
  if (results.some((result) => result.source === 'unsplash')) {
    notes.push(
      'Unsplash API terms: credit Unsplash and the photographer with the referral links, and keep the download callback.'
    )
  }
  if (results.some((result) => result.source === 'openverse' || result.source === 'wikimedia')) {
    notes.push(
      'Creative Commons images keep their license: carry the license line and attribution into the published work.'
    )
  }

  return {
    query: args.query,
    alt_query: args.altQuery,
    count: results.length,
    policy: 'commercial use and modification allowed; NC, ND, all-rights-reserved and unknown licenses are refused',
    results,
    providers,
    notes
  }
}

/** Parse the pixel dimensions of a JPEG/PNG/GIF/WebP buffer when possible. */
export function readImageDimensions(bytes, mime) {
  if (!Buffer.isBuffer(bytes)) return undefined
  try {
    if (mime === 'image/png' && bytes.length >= 24) {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    }
    if (mime === 'image/gif' && bytes.length >= 10) {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
    }
    if (mime === 'image/webp' && bytes.length >= 30) {
      const chunk = bytes.subarray(12, 16).toString('latin1')
      if (chunk === 'VP8X') {
        const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
        const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
        return { width, height }
      }
      if (chunk === 'VP8 ') {
        return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
      }
      if (chunk === 'VP8L') {
        const bits = bytes.readUInt32LE(21)
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
      }
      return undefined
    }
    if (mime === 'image/jpeg') {
      let offset = 2
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1
          continue
        }
        const marker = bytes[offset + 1]
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2
          continue
        }
        const length = bytes.readUInt16BE(offset + 2)
        const isStartOfFrame =
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        if (isStartOfFrame && offset + 9 <= bytes.length) {
          return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
        }
        offset += 2 + length
      }
      return undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

/** Guess the provider from a URL host when the caller omits `source`. */
function inferSourceFromUrl(url) {
  let host
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
  if (host.endsWith('pexels.com')) return 'pexels'
  if (host.endsWith('pixabay.com')) return 'pixabay'
  if (host.endsWith('unsplash.com')) return 'unsplash'
  if (host === 'api.openverse.org') return 'openverse'
  if (host.endsWith('wikimedia.org') || host.endsWith('wikipedia.org')) return 'wikimedia'
  return undefined
}

/** Pick a non-colliding file name inside `dir`. */
async function uniqueTargetPath(dir, stem, extension) {
  for (let counter = 1; counter <= 200; counter += 1) {
    const candidate = counter === 1 ? `${stem}${extension}` : `${stem}-${counter}${extension}`
    try {
      await fs.access(join(dir, candidate))
    } catch {
      return candidate
    }
  }
  throw new StockImageError(`cannot find a free file name for "${stem}" in ${dir}`, 'FILENAME_EXHAUSTED')
}

/** Append one credit line to the folder's ATTRIBUTION.md. */
async function recordAttribution(dir, entry) {
  const absolutePath = join(dir, ATTRIBUTION_FILE)
  const line = `- ${entry.date} · ${entry.file} · ${entry.credit}${entry.source === '' ? '' : ` [${entry.source}]`}\n`
  let existing
  try {
    existing = await fs.readFile(absolutePath, 'utf8')
  } catch {
    existing = '# Image attribution\n\nCredits for the images in this folder. Keep them with the images when publishing.\n\n'
  }
  if (existing.includes(line)) return absolutePath
  await fs.writeFile(absolutePath, `${existing}${line}`, 'utf8')
  return absolutePath
}

/**
 * Decide whether this URL may be saved, and with what rights.
 *
 * A URL that came from a validated search carries its assessed rights. A URL
 * with no search behind it is accepted only for a platform license whose host
 * belongs to that platform (Pexels / Pixabay / Unsplash); everything else is
 * refused, because the plugin cannot verify a per-file license it never saw.
 */
/** True for the subscription-only Unsplash+ CDN, which is not the free license. */
function isUnsplashPlusHost(host) {
  return host === 'plus.unsplash.com' || host.endsWith('.plus.unsplash.com')
}

export function resolveDownloadPolicy({ url, source, cached }) {
  if (cached === undefined) {
    const looksLike = inferSourceFromUrl(url)
    return {
      allowed: false,
      reason:
        looksLike === undefined
          ? 'only an image returned by stock_image_search in this session can be saved — search again and use the download_url from those results'
          : `this looks like a ${looksLike} image URL, but only a download_url returned by stock_image_search in this session can be saved — search again and use that URL`
    }
  }
  if (cached.rights?.allowed !== true) {
    return {
      allowed: false,
      reason: `this result was refused by the license policy (${cached.rights?.reason ?? 'unknown reason'})`
    }
  }
  if (source !== '' && source !== cached.source) {
    return {
      allowed: false,
      reason: `the URL belongs to the ${cached.source} result, not ${source}`
    }
  }
  let host
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return { allowed: false, reason: 'invalid URL' }
  }
  if (isUnsplashPlusHost(host)) {
    return { allowed: false, reason: 'Unsplash+ images use a paid subscription license, not the free Unsplash License' }
  }
  return {
    allowed: true,
    source: cached.source,
    rights: cached.rights,
    attribution: cached.attribution,
    trackUrl: cached.trackUrl,
    license: cached.license,
    licenseUrl: cached.licenseUrl
  }
}

/** Download one image into the Session workspace and record its credit. */
async function performDownload({ args, exec, logger }) {
  if (exec?.signal?.aborted === true) throw new StockImageError('download aborted', 'ABORTED')
  const cached = cachedSearchItem(args.url)
  const policy = resolveDownloadPolicy({ url: args.url, source: args.source, cached })
  if (!policy.allowed) {
    throw new StockImageError(`refusing to save the image (rights unverified): ${policy.reason}`, 'RIGHTS_UNVERIFIED')
  }
  const sourceId = policy.source
  const provider = sourceId === undefined ? undefined : providerById(sourceId)
  const rights = policy.rights

  let targetUrl = args.url
  // Unsplash requires calling download_location when an image is used.
  if (sourceId === 'unsplash' && typeof policy.trackUrl === 'string' && policy.trackUrl.startsWith('https://')) {
    try {
      const tracking = await fetchJson(policy.trackUrl, { signal: exec?.signal })
      if (typeof tracking?.url === 'string' && tracking.url.startsWith('https://')) {
        try {
          const host = new URL(tracking.url).hostname.toLowerCase()
          if (host === 'images.unsplash.com' || host.endsWith('.unsplash.com')) targetUrl = tracking.url
        } catch {
          /* keep the original URL */
        }
      }
    } catch (error) {
      if (typeof logger?.warn === 'function') {
        logger.warn(
          `dsh-stock-images: unsplash download callback failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }

  const response = await fetchBuffer(targetUrl, {
    signal: exec?.signal,
    maxBytes: MAX_IMAGE_BYTES,
    timeoutMs: 30000,
    accept: 'image/*'
  })
  if (response.status < 200 || response.status >= 300) {
    throw new StockImageError(`image host returned HTTP ${response.status}`, `DOWNLOAD_HTTP_${response.status}`)
  }
  const sniffed = sniffImageType(response.bytes)
  if (sniffed === null) {
    throw new StockImageError(
      `the URL did not return a supported image (JPEG/PNG/WebP/GIF); content-type was "${response.headers.get('content-type') ?? 'unknown'}"`,
      'NOT_AN_IMAGE'
    )
  }
  // AVIF/HEIC are valid images but DSH's read_image cannot read them back, so
  // saving one would leave the model unable to verify the subject.
  if (!SAVEABLE_EXTENSIONS.has(sniffed.extension)) {
    throw new StockImageError(
      `refusing to save ${sniffed.mime}: only JPEG, PNG, WebP and GIF can be reviewed with read_image afterwards`,
      'UNSUPPORTED_IMAGE_FORMAT'
    )
  }

  const workspaceRoot = workspaceRootFromExec(exec)
  const directory = resolveInsideRoot(workspaceRoot, args.directory)
  await fs.mkdir(directory, { recursive: true })
  // Lexical containment is not enough: a symlinked directory must not redirect
  // the write outside the Session workspace.
  await assertRealDirectoryInsideRoot(workspaceRoot, directory)

  const stemSource =
    args.filename !== '' ? args.filename : cached !== undefined && cached.title !== '' ? cached.title : ''
  const fallbackStem = `stock-image-${provider?.id ?? 'image'}`
  const stem = sanitizeFilename(stemSource, fallbackStem)
  const extension = sniffed.extension
  const stemWithoutExtension =
    stem.toLowerCase().endsWith(extension) && stem.length > extension.length
      ? stem.slice(0, stem.length - extension.length)
      : stem
  const safeStem = sanitizeFilename(stemWithoutExtension, fallbackStem)
  let absolutePath
  let written = false
  for (let attempt = 0; attempt < 4 && !written; attempt += 1) {
    const fileName = await uniqueTargetPath(directory, safeStem, extension)
    absolutePath = join(directory, fileName)
    try {
      await fs.writeFile(absolutePath, response.bytes, { flag: 'wx' })
      written = true
    } catch (error) {
      if (error?.code === 'EEXIST') continue // another call took the name; pick the next one
      throw new StockImageError(
        `cannot write ${relative(workspaceRoot, absolutePath) || 'the image'}: ${error instanceof Error ? error.message : String(error)}`,
        'WRITE_FAILED'
      )
    }
  }
  if (!written || absolutePath === undefined) {
    throw new StockImageError('cannot find a free file name after several attempts', 'WRITE_FAILED')
  }

  const dimensions = readImageDimensions(response.bytes, sniffed.mime)
  const credit =
    typeof policy.attribution === 'string' && policy.attribution !== ''
      ? policy.attribution
      : provider === undefined
        ? 'source and credit unknown — verify the license before publishing'
        : `${provider.label} image; verify the credit on ${provider.homepage} before publishing`
  // Attribution is a license condition for several licenses: it is recorded even
  // when the caller asked to skip the credit file.
  const attributionForced = rights.attributionRequired === true && args.attribution === false
  let attributionPath
  let attributionError
  if (args.attribution || attributionForced) {
    try {
      await assertNotSymlink(join(directory, ATTRIBUTION_FILE))
      attributionPath = await recordAttribution(directory, {
        date: new Date().toISOString().slice(0, 10),
        file: relative(workspaceRoot, absolutePath).split(sep).join('/'),
        credit,
        source: provider?.id ?? ''
      })
    } catch (error) {
      attributionError = error instanceof Error ? error.message : String(error)
      if (typeof logger?.warn === 'function') {
        logger.warn(`dsh-stock-images: cannot write the attribution file: ${attributionError}`)
      }
    }
  }

  return {
    path: absolutePath,
    relative_path: relative(workspaceRoot, absolutePath).split(sep).join('/'),
    bytes: response.bytes.length,
    mime: sniffed.mime,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    source: provider?.id ?? null,
    license: policy.license ?? provider?.license ?? null,
    license_url: policy.licenseUrl ?? provider?.licenseUrl ?? null,
    rights: describeRights(rights),
    risk: rights.risk,
    rights_notes: rights.notes,
    attribution: credit,
    attribution_forced: attributionForced,
    attribution_file:
      attributionPath === undefined ? null : relative(workspaceRoot, attributionPath).split(sep).join('/'),
    attribution_error: attributionError ?? null
  }
}

/** Report provider status, optionally verifying each key with a live request. */
async function performSources({ readKey, check, signal }) {
  const checkArgs = {
    query: 'nature',
    altQuery: '',
    orientation: 'any',
    count: 1,
    minWidth: 0,
    perSource: 1
  }
  const providers = await Promise.all(
    PROVIDERS.map(async (provider) => {
      const entry = {
        id: provider.id,
        label: provider.label,
        requires_key: provider.requiresKey,
        key_ref: provider.keyRef,
        key_state: provider.requiresKey ? 'missing' : 'not_required',
        key_source: null,
        homepage: provider.homepage,
        docs_url: provider.docsUrl,
        limits: provider.limits,
        license: provider.license,
        attribution_rule: provider.attributionRule,
        status: provider.requiresKey ? 'unconfigured' : 'available',
        note: null
      }
      if (provider.requiresKey) {
        const key = await readKey(provider.keyRef)
        if (key === undefined) {
          entry.note = keySetupHint(provider)
          return entry
        }
        entry.key_state = 'configured'
        entry.key_source = key.source
        if (!check) {
          entry.status = 'configured'
          return entry
        }
        try {
          await runProvider(provider, checkArgs, key.value, signal)
          entry.status = 'ok'
        } catch (error) {
          entry.status = 'error'
          entry.note = describeProviderFailure(provider, error)
        }
        return entry
      }
      if (!check) return entry
      try {
        await runProvider(provider, checkArgs, undefined, signal)
        entry.status = 'ok'
      } catch (error) {
        entry.status = 'error'
        entry.note = describeProviderFailure(provider, error)
      }
      return entry
    })
  )
  return {
    checked: check === true,
    providers,
    tool_names: [TOOL_SEARCH, TOOL_DOWNLOAD, TOOL_SOURCES],
    default_directory: DEFAULT_DOWNLOAD_DIR,
    max_image_bytes: MAX_IMAGE_BYTES
  }
}

/* ------------------------------------------------------------------------- *
 * Model-facing rendering
 * ------------------------------------------------------------------------- */

function renderSearchItem(item) {
  const size = item.width === null || item.height === null ? 'size unknown' : `${item.width}×${item.height}`
  return [
    `${item.n}. [${item.source}] ${size} · ${item.creator === '' ? 'creator unknown' : item.creator} · ${item.license}`,
    `   title: ${item.title === '' ? '(none)' : item.title}`,
    `   download_url: ${item.download_url}`,
    `   preview_url: ${item.preview_url === '' ? '(none)' : item.preview_url}`,
    `   page: ${item.page_url === '' ? '(none)' : item.page_url}`,
    `   credit: ${item.attribution}`,
    `   rights: ${item.rights}${item.risk === 'medium' ? ' — check the notes before publishing' : ''}`,
    ...(Array.isArray(item.rights_notes) && item.rights_notes.length > 0
      ? [`   rights notes: ${item.rights_notes.join(' / ')}`]
      : [])
  ].join('\n')
}

function renderSearchText(value) {
  const header = `Found ${value.count} image${value.count === 1 ? '' : 's'} for "${value.query}"${
    value.alt_query === '' ? '' : ` (also searched "${value.alt_query}")`
  }.`
  const providerLines = value.providers.map((provider) => {
    const key = provider.requires_key ? `, key ${provider.key_ref}` : ', no key'
    return `- ${provider.label} [${provider.id}${key}]: ${provider.status}${provider.note === null ? '' : ` — ${provider.note}`}`
  })
  const body =
    value.results.length === 0 ? '(no candidate image)' : value.results.map(renderSearchItem).join('\n')
  const lines = [header, '', `License policy: ${value.policy}.`, '', body, '', 'Providers:', ...providerLines]
  if (value.notes.length > 0) {
    lines.push('', 'Notes:', ...value.notes.map((note) => `- ${note}`))
  }
  lines.push(
    '',
    `Next: call ${TOOL_DOWNLOAD}({ url: "<download_url>" }) to save the chosen image into the workspace, then read the saved file with read_image to confirm it shows the right subject.`
  )
  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

function renderDownloadText(value) {
  const size = value.width === null || value.height === null ? '' : ` · ${value.width}×${value.height}`
  const lines = [
    `Saved ${value.relative_path}${size} · ${formatBytes(value.bytes)} · ${value.mime}`,
    `source: ${value.source ?? 'unknown'}${value.license === null ? '' : ` · license: ${value.license}`}`,
    `rights: ${value.rights}`,
    `credit: ${value.attribution}`
  ]
  if (Array.isArray(value.rights_notes) && value.rights_notes.length > 0) {
    lines.push(`rights notes: ${value.rights_notes.join(' / ')}`)
  }
  if (value.attribution_forced === true) {
    lines.push('attribution was recorded because the license requires it')
  }
  if (value.attribution_file !== null) lines.push(`credit recorded in: ${value.attribution_file}`)
  if (value.attribution_error) {
    lines.push(`WARNING: the credit file could not be written (${value.attribution_error}) — save this credit line with the image manually: ${value.attribution}`)
  }
  lines.push('', `Next: read_image({ file_path: "${value.relative_path}" }) to check the subject before using it.`)
  return lines.join('\n')
}

function renderSourcesText(value) {
  const lines = [
    value.checked
      ? 'Provider status (verified with a live request):'
      : 'Provider status (configuration only; pass check=true to verify with a live request):'
  ]
  for (const provider of value.providers) {
    const state =
      provider.key_state === 'configured'
        ? `key ${provider.key_ref} configured (${provider.key_source})`
        : provider.key_state === 'missing'
          ? `key ${provider.key_ref} missing`
          : 'no key needed'
    lines.push(
      `- ${provider.label} [${provider.id}]: ${provider.status} · ${state}${provider.note === null ? '' : ` — ${provider.note}`}`,
      `   allows: ${provider.limits} · license: ${provider.license}`,
      `   credit: ${provider.attribution_rule}`
    )
  }
  lines.push(
    '',
    `Tools: ${value.tool_names.join(', ')}`,
    `Downloads land in ${value.default_directory}/ inside the Session workspace; override it with the directory argument.`,
    `Maximum image size: ${formatBytes(value.max_image_bytes)}.`,
    'License policy: only commercial-use, modification-allowed licenses are returned; non-commercial, no-derivatives, all-rights-reserved and unknown licenses are refused, and attribution is recorded whenever the license requires it.'
  )
  return lines.join('\n')
}

/* ------------------------------------------------------------------------- *
 * Tool definitions
 * ------------------------------------------------------------------------- */

const TOOL_SEARCH = 'stock_image_search'
const TOOL_DOWNLOAD = 'stock_image_download'
const TOOL_SOURCES = 'stock_image_sources'

/** Build the three tool definitions bound to one plugin context. */
function createToolDefinitions({ ctx, logger }) {
  const readKey = createKeyReader(ctx)

  const searchTool = {
    name: TOOL_SEARCH,
    description:
      'Search free, licensed stock-image libraries for a picture to use in an article, Xiaohongshu/WeChat post, or video. Only images whose license allows commercial use and modification are returned: non-commercial, no-derivatives, all-rights-reserved and unrecognized licenses are refused and counted in the provider status. Each result carries a rights line (commercial/modification/attribution) and a risk flag with notes; save a chosen image with stock_image_download. Pexels, Pixabay and Unsplash are best for generic scenes, objects and places; Openverse and Wikimedia Commons index real people, so a public figure name usually only matches there. When the name is written differently across languages, pass both forms.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search terms: a subject, object, place or person name. Be specific ("Jensen Huang keynote") rather than broad ("business").'
        },
        alt_query: {
          type: 'string',
          description:
            'Alternative wording for providers that index another language, for example the English name for a Chinese query.'
        },
        sources: {
          type: 'array',
          items: { type: 'string', enum: PROVIDERS.map((provider) => provider.id) },
          description: 'Restrict the search to these providers; omit to search every available provider.'
        },
        orientation: {
          type: 'string',
          enum: ['landscape', 'portrait', 'square'],
          description:
            'Preferred aspect for the final layout: landscape for cover images, portrait for 3:4 cards, square for avatars.'
        },
        count: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Total candidates to return across providers. Default 8.'
        },
        min_width: {
          type: 'integer',
          minimum: 0,
          maximum: 20000,
          description: 'Minimum pixel width; default 800. Raise it for print or 4K video.'
        }
      },
      required: ['query'],
      additionalProperties: false
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: renderSearchText(value) }]
      }
    },
    async execute(rawArgs, exec) {
      const args = validateSearchArgs(rawArgs)
      return performSearch({ readKey, args, signal: exec?.signal, logger })
    }
  }

  const downloadTool = {
    name: TOOL_DOWNLOAD,
    description:
      'Save one image returned by stock_image_search into the Session workspace and record its credit and license. Pass the download_url from a search result of this session: the tool reuses that search\'s rights assessment, credit line, provider license and the Unsplash download callback. A URL that no validated search produced is refused, as are AVIF/HEIC images and URLs on paid hosts such as Unsplash+. Attribution is recorded even when attribution:false is passed if the license requires it. After saving, read the file with read_image to confirm the subject before placing it in the document, card or video.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The download_url of the chosen stock_image_search result.' },
        source: {
          type: 'string',
          enum: PROVIDERS.map((provider) => provider.id),
          description: 'Provider id of the search result; omit it, or repeat the result\'s source — a mismatch is refused.'
        },
        filename: {
          type: 'string',
          description: 'File name stem without extension, e.g. "jensen-huang-keynote". Defaults to the image title.'
        },
        directory: {
          type: 'string',
          description: 'Directory inside the Session workspace. Default "stock-images".'
        },
        attribution: {
          type: 'boolean',
          description: 'Append the credit line to the folder\'s ATTRIBUTION.md. Default true.'
        }
      },
      required: ['url'],
      additionalProperties: false
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: renderDownloadText(value) }]
      }
    },
    async execute(rawArgs, exec) {
      const args = validateDownloadArgs(rawArgs)
      return performDownload({ args, exec, logger })
    }
  }

  const sourcesTool = {
    name: TOOL_SOURCES,
    description:
      'List the configured stock-image providers, the API-key reference each one needs, and what that library allows. Set check=true to verify configured keys and provider reachability with one live request per provider.',
    parameters: {
      type: 'object',
      properties: {
        check: {
          type: 'boolean',
          description: 'Verify each provider with a live request instead of reporting configuration only. Default false.'
        }
      },
      additionalProperties: false
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: renderSourcesText(value) }]
      }
    },
    async execute(rawArgs, exec) {
      const check = rawArgs?.check === true
      return performSources({ readKey, check, signal: exec?.signal })
    }
  }

  return [searchTool, downloadTool, sourcesTool]
}

/* ------------------------------------------------------------------------- *
 * Plugin entry
 * ------------------------------------------------------------------------- */

/** Register the tools; every registration is owned by an effect. */
export function apply(ctx) {
  const logger = ctx.logger
  let definitions
  try {
    definitions = createToolDefinitions({ ctx, logger })
  } catch (error) {
    if (typeof logger?.error === 'function') {
      logger.error(`dsh-stock-images: cannot build tool definitions: ${error instanceof Error ? error.message : String(error)}`)
    }
    return
  }
  for (const definition of definitions) {
    ctx.effect(() => {
      try {
        return ctx.tools.register(definition)
      } catch (error) {
        const message = `dsh-stock-images: cannot register ${definition.name}: ${error instanceof Error ? error.message : String(error)}`
        if (typeof logger?.error === 'function') logger.error(message)
        else if (typeof logger?.warn === 'function') logger.warn(message)
        return function cleanupNoop() {}
      }
    }, `dsh-stock-images: ${definition.name}`)
  }
}

/** Test surface: pure helpers and provider normalizers. */
export const __internals = {
  PACKAGE_NAME,
  KEY_REFS,
  PROVIDERS,
  DEFAULT_DOWNLOAD_DIR,
  ATTRIBUTION_FILE,
  MAX_IMAGE_BYTES,
  providerById,
  runProvider,
  runProviderQueries,
  fetchJson,
  fetchBuffer,
  stripHtml,
  cleanText,
  formatBytes,
  clampInt,
  sanitizeFilename,
  normalizeOrientation,
  filterItems,
  hasCjk,
  latinQuery,
  providerQueries,
  buildUrl,
  withUnsplashUtm,
  resolveInsideRoot,
  inferSourceFromUrl,
  assessRights,
  describeRights,
  resolveDownloadPolicy,
  isUnsplashPlusHost,
  SAVEABLE_EXTENSIONS,
  assertRealDirectoryInsideRoot,
  assertNotSymlink,
  workspaceRootFromExec,
  expandIpv6,
  validateSearchArgs,
  validateDownloadArgs,
  describeProviderFailure,
  renderSearchText,
  renderDownloadText,
  renderSourcesText
}

