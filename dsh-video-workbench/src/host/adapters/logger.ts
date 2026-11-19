// Optional host logging. A profile may run without a logger, so every call is
// a no-op there instead of a crash.

import os from 'node:os'
import path from 'node:path'

import type { HostContext } from '../../shared/dsh'

export interface HostLogger {
  info(message: string): void
  error(message: string): void
}

/**
 * Shorten a configured path for logs: paths under the home directory become
 * `~/…`; other absolute paths keep only the drive and the last two segments.
 * Logs should not spell out a user's full directory layout.
 */
export function redactPath(value: string): string {
  const resolved = path.resolve(value)
  const home = os.homedir()
  const relative = path.relative(home, resolved)
  const insideHome = relative !== '' && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  if (insideHome) return path.join('~', relative)
  const parts = resolved.split(/[\\/]+/u).filter((part) => part.length > 0)
  const tail = parts.slice(-2).join(path.sep)
  return tail === '' ? value : `…${path.sep}${tail}`
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
