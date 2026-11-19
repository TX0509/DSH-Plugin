// Small HTTP helpers shared by every plugin route.
//
// Routes all authenticate the same way (token via `?t=` or the dedicated
// header), then answer JSON. Keeping this in one module means a new route cannot
// accidentally skip the check.

import type { IncomingMessage, ServerResponse } from 'node:http'

import { TOKEN_HEADER } from '../shared/routes'

/** Send a JSON body; always `no-store` (these responses are live state). */
export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

/** Read the token from the query string or the plugin header. */
export function readToken(request: IncomingMessage): string | undefined {
  const url = new URL(request.url ?? '/', 'http://placeholder.invalid')
  const query = url.searchParams.get('t')
  if (typeof query === 'string' && query.length > 0) return query
  const header = request.headers[TOKEN_HEADER]
  if (typeof header === 'string' && header.length > 0) return header
  return undefined
}

/**
 * Answer the request when it must not proceed:
 * - wrong token → 401
 * - method not allowed → 405 with `Allow`
 * Returns true when the caller should stop.
 */
export function rejectRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: { requireToken: boolean; tokenMatches: boolean; allow: string[] },
): boolean {
  if (options.requireToken && !options.tokenMatches) {
    sendJson(response, 401, { error: 'unauthorized' })
    return true
  }
  if (!options.allow.includes(request.method ?? '')) {
    response.writeHead(405, { allow: options.allow.join(', ') })
    response.end()
    return true
  }
  return false
}
