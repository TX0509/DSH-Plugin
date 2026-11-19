// Locate the external programs a render needs (node, pnpm, Chrome, ffmpeg).
//
// The selection order is a documented contract (docs/M2-PLAN.md §5): node from
// the DSH managed runtime first, then `DSH_NODE_EXECUTABLE`, then PATH; Chrome
// from an explicit config path, then the usual Windows install locations.
// Probes are injected so every branch is testable without touching the machine.

import fs from 'node:fs'
import path from 'node:path'

/** hyperframes 0.6.33 declares `engines.node >= 22`. */
export const MIN_NODE_MAJOR = 22

export interface Candidate {
  path: string
  /** Where the candidate came from; safe to log and to show as a hint. */
  source: string
  /**
   * Extra environment this candidate needs when it is executed. The DSH
   * `DSH_NODE_EXECUTABLE` is the Electron binary: without `ELECTRON_RUN_AS_NODE=1`
   * it would launch the GUI app instead of running a script.
   */
  env?: Record<string, string>
}

export interface Rejection {
  path: string
  source: string
  reason: string
}

export interface Picked {
  chosen?: Candidate
  rejected: Rejection[]
}

export interface ProbeResult {
  ok: boolean
  /** Raw version output, e.g. `v24.19.0`. */
  version?: string
  error?: string
}

/** `v24.19.0` / `node v24.19.0` / `24.19.0` → `24.19.0`; anything else → undefined. */
export function parseVersion(text: string): string | undefined {
  const match = /(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/u.exec(text.trim())
  return match === null ? undefined : match[1]
}

/** `24.19.0` → 24. */
export function majorOf(version: string): number | undefined {
  const major = Number(version.split('.')[0])
  return Number.isSafeInteger(major) && major > 0 ? major : undefined
}

function nodeBinaryName(): string {
  return process.platform === 'win32' ? 'node.exe' : 'node'
}

/**
 * `<dshHome>/dsh-runtimes/<runtime>/dependencies` directories, sorted for a
 * deterministic probe order. Missing directory → empty list, never throws.
 */
export function listRuntimeDependencyDirs(dshHome: string): string[] {
  const root = path.join(dshHome, 'dsh-runtimes')
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs: string[] = []
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue
    const dependencies = path.join(root, entry.name, 'dependencies')
    if (fs.existsSync(dependencies)) dirs.push(dependencies)
  }
  return dirs
}

/** Node candidates in probe order (managed runtime → DSH node → PATH). */
export function nodeCandidates(input: {
  runtimeDependencyDirs?: string[]
  dshNodeExecutable?: string
  pathEnv?: string
}): Candidate[] {
  const candidates: Candidate[] = []
  for (const dependencies of input.runtimeDependencyDirs ?? []) {
    candidates.push({
      path: path.join(dependencies, 'node', 'bin', nodeBinaryName()),
      source: 'managed-runtime',
    })
  }
  if (typeof input.dshNodeExecutable === 'string' && input.dshNodeExecutable.trim() !== '') {
    candidates.push({
      path: input.dshNodeExecutable.trim(),
      source: 'dsh-node-executable',
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
  }
  for (const dir of (input.pathEnv ?? '').split(path.delimiter)) {
    const trimmed = dir.trim()
    if (trimmed === '') continue
    candidates.push({ path: path.join(trimmed, nodeBinaryName()), source: 'path' })
  }
  return dedupe(candidates)
}

/** First candidate that runs and reports node ≥ {@link MIN_NODE_MAJOR}. */
export function pickNode(candidates: Candidate[], probe: (candidate: Candidate) => ProbeResult): Picked {
  return pick(candidates, (candidate) => {
    const result = probe(candidate)
    if (!result.ok) return result.error ?? '无法执行'
    const version = typeof result.version === 'string' ? parseVersion(result.version) : undefined
    if (version === undefined) return `无法解析版本：${String(result.version)}`
    const major = majorOf(version)
    if (major === undefined) return `无法解析版本：${version}`
    if (major < MIN_NODE_MAJOR) return `node ${major} < ${MIN_NODE_MAJOR}`
    return undefined
  })
}

/** Case-insensitive environment lookup (Windows env names are case-insensitive). */
function readEnv(env: Record<string, string | undefined>, key: string): string | undefined {
  const direct = env[key]
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim()
  const wanted = key.toLowerCase()
  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase() === wanted && typeof value === 'string' && value.trim() !== '') {
      return value.trim()
    }
  }
  return undefined
}

/** Chrome candidates in probe order: explicit config first, then Windows locations. */
export function chromeCandidates(input: {
  configured?: string
  env?: Record<string, string | undefined>
}): Candidate[] {
  const env = input.env ?? {}
  const candidates: Candidate[] = []
  const configured = typeof input.configured === 'string' ? input.configured.trim() : ''
  if (configured !== '') candidates.push({ path: path.resolve(configured), source: 'configured' })

  const relative = path.join('Google', 'Chrome', 'Application', 'chrome.exe')
  const known: Array<[string, string]> = [
    ['ProgramFiles', 'program-files'],
    ['ProgramFiles(x86)', 'program-files-x86'],
    ['LOCALAPPDATA', 'local-appdata'],
  ]
  for (const [name, source] of known) {
    const root = readEnv(env, name)
    if (root !== undefined) candidates.push({ path: path.join(root, relative), source })
  }
  return dedupe(candidates)
}

/** First existing Chrome candidate; `exists` is injected so tests stay hermetic. */
export function pickChrome(candidates: Candidate[], exists: (candidatePath: string) => boolean): Picked {
  return pick(candidates, (candidate) => (exists(candidate.path) ? undefined : '文件不存在'))
}

/**
 * The managed pnpm script that ships next to the managed node:
 * `<dependencies>/node/bin/node` → `<dependencies>/pnpm/bin/pnpm.mjs`.
 * Returns undefined for node candidates that do not come from a managed runtime.
 */
export function pnpmScriptFor(nodePath: string): string | undefined {
  // <dependencies>/node/bin/<node> → <dependencies>
  const dependencies = path.resolve(nodePath, '..', '..', '..')
  const script = path.join(dependencies, 'pnpm', 'bin', 'pnpm.mjs')
  return fs.existsSync(script) ? script : undefined
}

/** Shared selection loop: first candidate without a rejection reason wins. */
function pick(candidates: Candidate[], reject: (candidate: Candidate) => string | undefined): Picked {
  const rejected: Rejection[] = []
  for (const candidate of candidates) {
    const reason = reject(candidate)
    if (reason === undefined) return { chosen: candidate, rejected }
    rejected.push({ path: candidate.path, source: candidate.source, reason })
  }
  return { rejected }
}

/** Drop exact duplicate paths, keeping the first (highest-priority) source. */
function dedupe(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>()
  const unique: Candidate[] = []
  for (const candidate of candidates) {
    const key = process.platform === 'win32' ? candidate.path.toLowerCase() : candidate.path
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(candidate)
  }
  return unique
}
