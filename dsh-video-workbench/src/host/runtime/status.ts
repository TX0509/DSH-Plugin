// Runtime status as the UI and the self-check see it.
//
// Deliberately path-free: responses go to the page, and absolute install paths
// must not leak into the UI (logs keep the redacted form).

import { readSupplied, runtimeState } from './supply'
import type { RuntimeState, SuppliedRuntime } from './supply'

export interface RuntimeStatusView {
  /** `ready` = installed and verified; `missing` = needs install; `installing` = in flight. */
  state: RuntimeState
  /** Installed renderer versions once ready. */
  versions?: SuppliedRuntime['versions']
  /** Where the browser came from (`configured` / `program-files` / …), or null. */
  browser: { source: string } | null
  /** Last install failure code, cleared when a new install starts. */
  lastError?: string
}

export interface DescribeRuntimeInput {
  runtimeDir: string
  /** The selected Chrome candidate, if any. */
  browserSource?: string
  /** Set while an install is running in this process. */
  installing?: boolean
  lastError?: string
}

/** Compose the status the UI polls; no filesystem paths in the result. */
export function describeRuntime(input: DescribeRuntimeInput): RuntimeStatusView {
  const installed = readSupplied(input.runtimeDir)
  let state = runtimeState(input.runtimeDir)
  if (input.installing === true && state !== 'ready') state = 'installing'
  return {
    state,
    ...(installed === undefined ? {} : { versions: installed.versions }),
    browser: input.browserSource === undefined ? null : { source: input.browserSource },
    ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
  }
}
