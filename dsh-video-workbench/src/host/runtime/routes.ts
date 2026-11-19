// HTTP routes for the render runtime: status + install trigger.
//
// Both require the plugin token. Install is asynchronous: the POST answers
// immediately and the UI polls the status route (M2-PLAN §3.3, decision A).

import type { IncomingMessage, ServerResponse } from 'node:http'

import { readToken, rejectRequest, sendJson } from '../http'
import { tokenEquals } from '../index-internal'

import type { RuntimeStatusView } from './status'

export interface RuntimeRouteOptions {
  token: string
  requireToken: boolean
  status(): RuntimeStatusView
  /** Start the install once; repeated calls while running are no-ops. */
  startInstall(): void
}

function authorized(request: IncomingMessage, options: RuntimeRouteOptions): boolean {
  return tokenEquals(readToken(request), options.token)
}

/** `GET /api/video-workbench/runtime` — current supply state. */
export function createRuntimeStateHandler(
  options: RuntimeRouteOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (rejectRequest(request, response, {
      requireToken: options.requireToken,
      tokenMatches: authorized(request, options),
      allow: ['GET', 'HEAD'],
    })) return
    sendJson(response, 200, options.status())
  }
}

/** `POST /api/video-workbench/runtime/install` — kick off the install. */
export function createRuntimeInstallHandler(
  options: RuntimeRouteOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (rejectRequest(request, response, {
      requireToken: options.requireToken,
      tokenMatches: authorized(request, options),
      allow: ['POST'],
    })) return
    options.startInstall()
    sendJson(response, 202, options.status())
  }
}
