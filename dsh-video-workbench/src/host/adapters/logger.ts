// Optional host logging. A profile may run without a logger, so every call is
// a no-op there instead of a crash.

import type { HostContext } from '../../shared/dsh'

export interface HostLogger {
  info(message: string): void
  error(message: string): void
}

/** Wrap `ctx.logger`; safe to call when the service is absent. */
export function hostLogger(ctx: HostContext): HostLogger {
  return {
    info(message) {
      if (typeof ctx.logger?.info === 'function') ctx.logger.info(message)
    },
    error(message) {
      if (typeof ctx.logger?.error === 'function') ctx.logger.error(message)
    },
  }
}
