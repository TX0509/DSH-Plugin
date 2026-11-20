// HTTP routes for renders.
//
//   POST   /api/video-workbench/render          → start a render
//   GET    /api/video-workbench/render/<id>     → poll one job
//   DELETE /api/video-workbench/render/<id>     → cancel a job
//
// Registered as one prefix route because the web server has no path parameters.

import type { IncomingMessage, ServerResponse } from 'node:http'

import { readToken, rejectRequest, sendJson } from '../http'
import { tokenEquals } from '../index-internal'

import type { RenderJobView } from './jobs'
import { RENDER_PATH } from '../../shared/routes'

export type StartResult =
  | { ok: true; job: RenderJobView }
  | { ok: false; error: string }

export type CancelResult =
  | { ok: true; job: RenderJobView }
  | { ok: false; error: string }

export interface RenderRouteOptions {
  token: string
  requireToken: boolean
  start(projectId: string): StartResult
  get(id: string): RenderJobView | undefined
  cancel(id: string): CancelResult
  /** Body limit for the start request. */
  maxBodyBytes?: number
}

const START_ERROR_STATUS: Record<string, number> = {
  busy: 409,
  'invalid-project': 400,
  disposed: 503,
}

const CANCEL_ERROR_STATUS: Record<string, number> = {
  'not-found': 404,
  finished: 409,
}

function authorized(request: IncomingMessage, options: RenderRouteOptions): boolean {
  return tokenEquals(readToken(request), options.token)
}

/** Read a small JSON body; resolves `undefined` when it is not usable. */
function readJsonBody(request: IncomingMessage, limit: number): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        resolve(undefined)
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined)
      } catch {
        resolve(undefined)
      }
    })
    request.on('error', () => resolve(undefined))
  })
}

export function createRenderHandler(
  options: RenderRouteOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  const limit = options.maxBodyBytes ?? 16 * 1024
  return (request, response) => {
    const url = new URL(request.url ?? '/', 'http://placeholder.invalid')
    const suffix = url.pathname.slice(RENDER_PATH.length).replace(/^\/+/u, '')

    if (suffix === '') {
      if (rejectRequest(request, response, {
        requireToken: options.requireToken,
        tokenMatches: authorized(request, options),
        allow: ['POST'],
      })) return
      void readJsonBody(request, limit).then((body) => {
        const projectId = typeof body?.projectId === 'string' ? body.projectId : ''
        if (projectId === '') {
          sendJson(response, 400, { error: 'invalid-request' })
          return
        }
        const result = options.start(projectId)
        if (!result.ok) {
          sendJson(response, START_ERROR_STATUS[result.error] ?? 400, { error: result.error })
          return
        }
        sendJson(response, 202, { job: result.job })
      }).catch(() => {
        // Start must fail the request, never reject unhandled inside the host.
        if (!response.headersSent) sendJson(response, 500, { error: 'internal' })
      })
      return
    }

    if (rejectRequest(request, response, {
      requireToken: options.requireToken,
      tokenMatches: authorized(request, options),
      allow: ['GET', 'HEAD', 'DELETE'],
    })) return

    if (request.method === 'DELETE') {
      const result = options.cancel(suffix)
      if (!result.ok) {
        sendJson(response, CANCEL_ERROR_STATUS[result.error] ?? 400, { error: result.error })
        return
      }
      sendJson(response, 202, { job: result.job })
      return
    }

    const job = options.get(suffix)
    if (job === undefined) {
      sendJson(response, 404, { error: 'not-found' })
      return
    }
    sendJson(response, 200, { job })
  }
}
