// Render runtime supply: install `hyperframes` + ffmpeg/ffprobe into the plugin
// data dir, then verify the binaries really run.
//
// M0 findings that shape this module (docs/M0-FINDINGS.md §1):
// - pnpm skips postinstall for native packages unless each one is passed to
//   `--allow-build`; `onlyBuiltDependencies` did not work on pnpm 11.28.
// - the first install pass can still skip them, so the same command is run twice.
// - `hyperframes doctor` / `browser path` report success for paths that do not
//   exist, so verification executes the binaries instead of trusting them.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { writeFileAtomic } from '../atomic'

import {
  MIN_NODE_MAJOR,
  listRuntimeDependencyDirs,
  majorOf,
  nodeCandidates,
  parseVersion,
  pnpmScriptFor,
} from './locate'

/** Versions are pinned: the renderer must not follow DSH upgrades. */
export const RUNTIME_VERSIONS = {
  hyperframes: '0.6.33',
  'ffmpeg-static': '5.2.0',
  'ffprobe-static': '3.1.0',
} as const

/**
 * Packages whose install scripts must run. `hyperframes` plus the native
 * packages it depends on (esbuild/onnxruntime/sharp are only used by its
 * optional features, but missing builds make `hyperframes` fail at import).
 */
export const ALLOW_BUILD_PACKAGES = [
  'hyperframes',
  'esbuild',
  'ffmpeg-static',
  'ffprobe-static',
  'onnxruntime-node',
  'sharp',
] as const

export interface RuntimePaths {
  dir: string
  packageJson: string
  nodeModules: string
  suppliedFile: string
  lockFile: string
  logFile: string
  cliPath: string
}

export function runtimePaths(runtimeDir: string): RuntimePaths {
  const dir = path.resolve(runtimeDir)
  const nodeModules = path.join(dir, 'node_modules')
  return {
    dir,
    packageJson: path.join(dir, 'package.json'),
    nodeModules,
    suppliedFile: path.join(dir, 'supplied.json'),
    lockFile: path.join(dir, '.install.lock'),
    logFile: path.join(dir, 'install.log'),
    cliPath: path.join(nodeModules, 'hyperframes', 'dist', 'cli.js'),
  }
}

export interface SuppliedRuntime {
  schemaVersion: 1
  installedAt: string
  versions: { hyperframes: string; ffmpegStatic: string; ffprobeStatic: string }
  binaries: { cli: string; ffmpeg: string; ffprobe: string }
}

export type RuntimeState = 'ready' | 'missing' | 'installing'

/** The install result file, validated; undefined when missing or malformed. */
export function readSupplied(runtimeDir: string): SuppliedRuntime | undefined {
  const paths = runtimePaths(runtimeDir)
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(paths.suppliedFile, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Partial<SuppliedRuntime>
  if (value.schemaVersion !== 1 || typeof value.installedAt !== 'string') return undefined
  const versions = value.versions
  const binaries = value.binaries
  if (typeof versions !== 'object' || versions === null) return undefined
  if (typeof binaries !== 'object' || binaries === null) return undefined
  for (const field of ['hyperframes', 'ffmpegStatic', 'ffprobeStatic'] as const) {
    if (typeof versions[field] !== 'string') return undefined
  }
  for (const field of ['cli', 'ffmpeg', 'ffprobe'] as const) {
    if (typeof binaries[field] !== 'string') return undefined
  }
  return value as SuppliedRuntime
}

/**
 * `ready` needs both the result file and the CLI on disk; a stale result after a
 * manual delete must not be reported as ready.
 */
export function runtimeState(runtimeDir: string): RuntimeState {
  const paths = runtimePaths(runtimeDir)
  const supplied = readSupplied(runtimeDir)
  if (supplied !== undefined && fs.existsSync(paths.cliPath)) return 'ready'
  if (fs.existsSync(paths.lockFile)) return 'installing'
  return 'missing'
}

export interface ExecResult {
  status: number
  stdout: string
  stderr: string
}

export type Exec = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
) => Promise<ExecResult>

/** Default executor: real subprocess, output captured, never a shell string. */
export const defaultExec: Exec = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const timer = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
    ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
    : undefined
  child.on('error', (error) => {
    if (timer !== undefined) clearTimeout(timer)
    reject(error)
  })
  child.on('close', (code) => {
    if (timer !== undefined) clearTimeout(timer)
    resolve({ status: code ?? -1, stdout, stderr })
  })
})

/** The two identical `pnpm add` passes (M0: the first can skip postinstall). */
export function installCommands(nodePath: string, pnpmScriptPath: string): string[][] {
  const packages = Object.entries(RUNTIME_VERSIONS).map(([name, version]) => `${name}@${version}`)
  const allow = ALLOW_BUILD_PACKAGES.map((name) => `--allow-build=${name}`)
  return [
    [nodePath, pnpmScriptPath, 'add', ...packages, ...allow],
    [nodePath, pnpmScriptPath, 'add', ...packages, ...allow],
  ]
}

export interface InstallOptions {
  runtimeDir: string
  nodePath: string
  pnpmScriptPath: string
  /** Minimal child env (see runtime/env.ts). */
  env: Record<string, string>
  exec?: Exec
  now?: Date
  /** Resolves a package's binary path; injectable so tests need no install. */
  resolveBinary?: (packageName: string) => string | undefined
  timeoutMs?: number
}

export type InstallResult =
  | { ok: true; supplied: SuppliedRuntime; log: string }
  | { ok: false; error: string; log: string }

/** Resolve `ffmpeg-static` / `ffprobe-static` / the CLI from the runtime's own node_modules. */
export function resolveRuntimeBinaries(runtimeDir: string): {
  cli?: string
  ffmpeg?: string
  ffprobe?: string
} {
  const paths = runtimePaths(runtimeDir)
  const result: { cli?: string; ffmpeg?: string; ffprobe?: string } = {}
  if (fs.existsSync(paths.cliPath)) result.cli = paths.cliPath
  try {
    const runtimeRequire = createRequire(path.join(runtimeDir, 'package.json'))
    const ffmpeg = runtimeRequire('ffmpeg-static') as unknown
    if (typeof ffmpeg === 'string' && fs.existsSync(ffmpeg)) result.ffmpeg = ffmpeg
    const ffprobe = runtimeRequire('ffprobe-static') as unknown
    const probePath = (ffprobe as { path?: unknown }).path
    if (typeof probePath === 'string' && fs.existsSync(probePath)) result.ffprobe = probePath
  } catch {
    // A partially installed runtime: report only what resolved.
  }
  return result
}

/** Read one package version from the runtime's node_modules. */
export function installedVersion(runtimeDir: string, packageName: string): string | undefined {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(runtimeDir, 'node_modules', packageName, 'package.json'), 'utf8'),
    ) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Install (or reuse) the render runtime.
 * Single-flight: a live lock means another install is already running.
 */
export async function installRuntime(options: InstallOptions): Promise<InstallResult> {
  const exec = options.exec ?? defaultExec
  const paths = runtimePaths(options.runtimeDir)
  try {
    fs.mkdirSync(paths.dir, { recursive: true })
  } catch {
    // A read-only data dir must answer the install route, not reject inside the
    // DSH host process.
    return { ok: false, error: 'runtime-dir-unwritable', log: '' }
  }
  const log: string[] = []
  const append = (line: string): void => {
    log.push(line)
    try {
      fs.appendFileSync(paths.logFile, `${line}\n`, 'utf8')
    } catch {
      // The install result matters more than the log line.
    }
  }

  if (isLocked(paths.lockFile)) {
    return { ok: false, error: 'installing', log: fs.existsSync(paths.logFile) ? fs.readFileSync(paths.logFile, 'utf8') : '' }
  }
  try {
    fs.writeFileSync(paths.logFile, '', 'utf8')
  } catch {
    // Keep going: logs are best effort.
  }
  const lock = { pid: process.pid, startedAt: new Date().toISOString() }
  try {
    writeFileAtomic(paths.lockFile, `${JSON.stringify(lock, null, 2)}\n`)

    // 1. A predictable manifest: versions are the contract, not the lockfile state.
    const manifest = {
      name: 'dsh-video-workbench-runtime',
      private: true,
      version: '1.0.0',
      dependencies: RUNTIME_VERSIONS,
    }
    writeFileAtomic(paths.packageJson, `${JSON.stringify(manifest, null, 2)}\n`)

    // 2. Two identical passes (M0: build scripts can be skipped on the first).
    for (const args of installCommands(options.nodePath, options.pnpmScriptPath)) {
      append(`$ ${args.slice(1).join(' ')}`)
      const result = await exec(args[0], args.slice(1), {
        cwd: paths.dir,
        env: options.env,
        timeoutMs: options.timeoutMs ?? 15 * 60 * 1000,
      })
      append(result.stdout.trimEnd())
      if (result.stderr.trim() !== '') append(`[stderr] ${result.stderr.trimEnd()}`)
      if (result.status !== 0) {
        // pnpm exits 1 when it merely *ignores* install scripts it was not told
        // to run (transitive packages outside our allow list). The binaries we
        // depend on are verified below, so that exit code alone is not fatal.
        const combined = `${result.stdout}\n${result.stderr}`
        if (combined.includes('ERR_PNPM_IGNORED_BUILDS')) {
          append('（pnpm 报告有未放行的构建脚本；以随后的二进制校验为准）')
        } else {
          return { ok: false, error: `install-failed(${result.status})`, log: log.join('\n') }
        }
      }
    }

    // 3. Verify by executing, never by trusting a path printer.
    const versions = {
      hyperframes: installedVersion(paths.dir, 'hyperframes') ?? '',
      ffmpegStatic: installedVersion(paths.dir, 'ffmpeg-static') ?? '',
      ffprobeStatic: installedVersion(paths.dir, 'ffprobe-static') ?? '',
    }
    for (const [name, expected] of Object.entries(RUNTIME_VERSIONS)) {
      const installed = installedVersion(paths.dir, name)
      if (installed !== expected) {
        append(`版本不符：${name} 期望 ${expected}，实际 ${String(installed)}`)
        return { ok: false, error: 'version-mismatch', log: log.join('\n') }
      }
    }
    const binaries = options.resolveBinary === undefined
      ? resolveRuntimeBinaries(paths.dir)
      : {
        cli: options.resolveBinary('hyperframes'),
        ffmpeg: options.resolveBinary('ffmpeg-static'),
        ffprobe: options.resolveBinary('ffprobe-static'),
      }
    if (binaries.ffmpeg === undefined || !fs.existsSync(binaries.ffmpeg)) {
      append('校验失败：找不到可执行的 ffmpeg')
      return { ok: false, error: 'ffmpeg-missing', log: log.join('\n') }
    }
    if (binaries.ffprobe === undefined || !fs.existsSync(binaries.ffprobe)) {
      append('校验失败：找不到可执行的 ffprobe')
      return { ok: false, error: 'ffprobe-missing', log: log.join('\n') }
    }
    if (binaries.cli === undefined || !fs.existsSync(binaries.cli)) {
      append('校验失败：找不到 hyperframes CLI')
      return { ok: false, error: 'hyperframes-missing', log: log.join('\n') }
    }
    for (const [label, binary, args] of [
      ['ffmpeg', binaries.ffmpeg, ['-version']],
      ['ffprobe', binaries.ffprobe, ['-version']],
    ] as const) {
      const result = await exec(binary, [...args], { env: options.env, timeoutMs: 15000 })
      append(`${label} -version → ${result.status}`)
      if (result.status !== 0) {
        return { ok: false, error: `${label}-broken`, log: log.join('\n') }
      }
    }

    const supplied: SuppliedRuntime = {
      schemaVersion: 1,
      installedAt: (options.now ?? new Date()).toISOString(),
      versions,
      binaries: {
        cli: binaries.cli,
        ffmpeg: binaries.ffmpeg,
        ffprobe: binaries.ffprobe,
      },
    }
    writeFileAtomic(paths.suppliedFile, `${JSON.stringify(supplied, null, 2)}\n`)
    append('运行时就绪')
    return { ok: true, supplied, log: log.join('\n') }
  } catch (error) {
    append(`异常：${String(error)}`)
    return { ok: false, error: 'install-error', log: log.join('\n') }
  } finally {
    try {
      fs.rmSync(paths.lockFile, { force: true })
    } catch {
      // A stale lock only delays the next install by one probe.
    }
  }
}

/** A lock whose pid is gone is stale (crash / force-quit) and must not block. */
function isLocked(lockFile: string): boolean {
  let raw: string
  try {
    raw = fs.readFileSync(lockFile, 'utf8')
  } catch {
    return false
  }
  try {
    const lock = JSON.parse(raw) as { pid?: unknown }
    if (typeof lock.pid !== 'number' || !Number.isSafeInteger(lock.pid)) return false
    if (lock.pid === process.pid) return true
    process.kill(lock.pid, 0)
    return true
  } catch {
    return false
  }
}

export interface InstallTools {
  nodePath: string
  pnpmScriptPath: string
  nodeVersion: string
  env: Record<string, string>
}

/**
 * Resolve a node (≥22) plus the managed pnpm needed to install the runtime.
 * Probing executes `--version`, because a path that merely exists proves nothing.
 */
export function resolveInstallTools(input: {
  dshHome: string
  dshNodeExecutable?: string
  pathEnv?: string
  buildEnv: (nodeBinDir: string, extra?: Record<string, string>) => Record<string, string>
}): InstallTools | undefined {
  const candidates = nodeCandidates({
    runtimeDependencyDirs: listRuntimeDependencyDirs(input.dshHome),
    dshNodeExecutable: input.dshNodeExecutable,
    pathEnv: input.pathEnv,
  })
  for (const candidate of candidates) {
    const env = input.buildEnv(path.dirname(candidate.path), candidate.env)
    let stdout = ''
    let stderr = ''
    let status = -1
    try {
      const probe = spawnSync(candidate.path, ['--version'], {
        env,
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      })
      status = probe.status ?? -1
      stdout = probe.stdout ?? ''
      stderr = probe.stderr ?? ''
    } catch {
      continue
    }
    if (status !== 0) continue
    const version = parseVersion(`${stdout}\n${stderr}`)
    if (version === undefined) continue
    if ((majorOf(version) ?? 0) < MIN_NODE_MAJOR) continue
    const pnpmScriptPath = pnpmScriptFor(candidate.path)
    if (pnpmScriptPath === undefined) continue
    return { nodePath: candidate.path, pnpmScriptPath, nodeVersion: version, env }
  }
  return undefined
}
