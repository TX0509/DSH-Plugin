// Environment for render subprocesses.
//
// A render must not inherit the DSH/Electron process environment: ELECTRON_*,
// NODE_OPTIONS and npm/pnpm variables change child behaviour in ways that are
// hard to debug and can leak host specifics into the render. Build the child env
// from an explicit allowlist, then add the few HYPERFRAMES_* switches we own.

import path from 'node:path'

/**
 * Variables a child needs to run a Node program on Windows (and, harmlessly, on
 * other platforms). Everything else is dropped.
 */
const INHERITED_KEYS = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'SYSTEMDRIVE',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
] as const

const INHERITED = new Set<string>(INHERITED_KEYS)

export interface RenderEnvInput {
  /** Usually `process.env`. */
  baseEnv: Record<string, string | undefined>
  /** Directory holding the node binary the render will run with. */
  nodeBinDir: string
  /** Chrome executable; when set, hyperframes skips its own download. */
  browserPath?: string
  /** Extra variables merged last (tests and future cache-dir overrides). */
  extra?: Record<string, string>
}

/**
 * Build the explicit environment for a render subprocess.
 * Deterministic: same input → same output, no reads of the real process env.
 */
export function buildRenderEnv(input: RenderEnvInput): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.baseEnv)) {
    if (typeof value !== 'string' || value === '') continue
    if (!INHERITED.has(name.toUpperCase())) continue
    env[name] = value
  }

  // The managed Node must win over whatever PATH the host inherited.
  const pathKey = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'Path'
  const inheritedPath = env[pathKey] ?? ''
  env[pathKey] = inheritedPath === ''
    ? input.nodeBinDir
    : `${input.nodeBinDir}${path.delimiter}${inheritedPath}`

  // Keep hyperframes offline and quiet about telemetry/updates.
  env.HYPERFRAMES_NO_AUTO_INSTALL = '1'
  env.HYPERFRAMES_NO_TELEMETRY = '1'
  env.HYPERFRAMES_NO_UPDATE_CHECK = '1'
  if (typeof input.browserPath === 'string' && input.browserPath !== '') {
    env.HYPERFRAMES_BROWSER_PATH = input.browserPath
  }
  for (const [name, value] of Object.entries(input.extra ?? {})) env[name] = value
  return env
}
