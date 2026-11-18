// The only module in the host half that talks to DSH's `webServer` service.
// Everything else consumes this adapter, so a DSH API change lands here.

import type {
  HostContext,
  IndexInjection,
  PeerLike,
  WebContext,
  WebRoute,
} from '../../shared/dsh'

/** Undo a registration; safe to call more than once. */
export type Disposer = () => void

/** Index-injection listener for business code; only owner pages reach it. */
export type OwnerIndexListener = (table: IndexInjection[]) => void

export interface WebServerAdapter {
  /** Mount a route; it is removed when the plugin run ends. */
  registerRoute(route: WebRoute, label: string): Disposer

  /**
   * Append page globals to the index-injection table.
   *
   * Only a `principal.kind === 'owner'` page is served: a remote viewer page
   * must never receive this plugin's media token.
   */
  onIndexInject(listener: OwnerIndexListener): Disposer

  /**
   * Root URL local clients use to reach the bound listener, or undefined
   * before it binds a port.
   */
  origin(): string | undefined
}

/** Wrap a live `webServer` context. Exported so tests can drive it directly. */
export function createWebServerAdapter(web: WebContext): WebServerAdapter {
  return {
    registerRoute(route, label) {
      return web.effect(() => web.webServer.register(route), label)
    },
    onIndexInject(listener) {
      return web.effect(
        () => web.on('webserver/index-inject', (table: IndexInjection[], peer?: PeerLike) => {
          if (peer?.principal?.kind !== 'owner') return
          listener(table)
        }),
        'video-workbench:index-inject',
      )
    },
    origin() {
      try {
        return web.webServer.getOrigin()
      } catch {
        // Called before `listen` binds; the self-check reports it as a failure.
        return undefined
      }
    },
  }
}

/**
 * Wait for the optional `webServer` service, then hand the adapter to `setup`.
 *
 * A profile without a web server (or with that service disabled) leaves the
 * plugin inactive instead of failing the whole host.
 */
export function withWebServer(ctx: HostContext, setup: (server: WebServerAdapter) => void): void {
  ctx.inject(['webServer'], (web: WebContext) => setup(createWebServerAdapter(web)))
}
