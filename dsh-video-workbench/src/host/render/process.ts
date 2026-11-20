// Child process utilities for renders: kill a whole tree, and remember jobs on
// disk so a crashed DSH can reap leftovers on the next start.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { writeFileAtomic } from '../atomic'

export interface JobRegistryEntry {
  id: string
  pid: number
  projectId: string
  startedAt: string
  /** One line for humans; never used for matching. */
  command: string
  /**
   * DSH process that spawned the render. A second live DSH (web + desktop, or
   * two windows) owns its own jobs; crash recovery must leave them alone.
   */
  ownerPid?: number
  /**
   * Absolute hyperframes CLI path the child runs. Recovery only kills a PID
   * whose command line still proves it is that render: after a crash the PID
   * may already belong to an unrelated process.
   */
  cliPath?: string
}

const REGISTRY_DIR = 'render-jobs'

function registryDir(dataDir: string): string {
  return path.join(dataDir, REGISTRY_DIR)
}

export function jobRegistryPath(dataDir: string, id: string): string {
  return path.join(registryDir(dataDir), `${id}.json`)
}

export function writeJobRegistry(dataDir: string, entry: JobRegistryEntry): string {
  const file = jobRegistryPath(dataDir, entry.id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writeFileAtomic(file, `${JSON.stringify(entry, null, 2)}\n`)
  return file
}

export function removeJobRegistry(dataDir: string, id: string): void {
  try {
    fs.rmSync(jobRegistryPath(dataDir, id), { force: true })
  } catch {
    // Leftovers are reaped on the next start anyway.
  }
}

/** Every readable registry entry; malformed files are reported as skipped. */
export function readJobRegistries(dataDir: string): { entries: JobRegistryEntry[]; corrupt: string[] } {
  const dir = registryDir(dataDir)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { entries: [], corrupt: [] }
  }
  const entries: JobRegistryEntry[] = []
  const corrupt: string[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = path.join(dir, name)
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<JobRegistryEntry>
      if (typeof raw.id !== 'string' || typeof raw.pid !== 'number' || !Number.isSafeInteger(raw.pid)) {
        corrupt.push(file)
        continue
      }
      entries.push({
        id: raw.id,
        pid: raw.pid,
        projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
        startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
        command: typeof raw.command === 'string' ? raw.command : '',
        ...(typeof raw.ownerPid === 'number' && Number.isSafeInteger(raw.ownerPid)
          ? { ownerPid: raw.ownerPid }
          : {}),
        ...(typeof raw.cliPath === 'string' && raw.cliPath !== '' ? { cliPath: raw.cliPath } : {}),
      })
    } catch {
      corrupt.push(file)
    }
  }
  return { entries, corrupt }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but is owned by someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Kill a render and everything it started.
 * Windows: `taskkill /T /F` (the tree includes each worker's Chrome).
 * POSIX: the child is spawned detached, so its process group id equals its pid.
 */
export async function killTree(
  pid: number,
  options: { platform?: NodeJS.Platform; spawnImpl?: typeof spawn; timeoutMs?: number } = {},
): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    const child = (options.spawnImpl ?? spawn)('taskkill', ['/T', '/F', '/PID', String(pid)], {
      windowsHide: true,
      stdio: 'ignore',
    })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Ignore: the result is best-effort.
        }
        resolve(false)
      }, options.timeoutMs ?? 10000)
      child.on('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve(code === 0)
      })
    })
  }
  try {
    process.kill(-pid, 'SIGKILL')
    return true
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
      return true
    } catch {
      return false
    }
  }
}

export interface ReapResult {
  killed: string[]
  removed: string[]
  skipped: string[]
}

/** How to read one process's command line; injectable so tests stay hermetic. */
export type CommandLineReader = (pid: number) => Promise<string | undefined>

/** Run a small probe program and return its trimmed stdout. */
function readCommandOutput(
  command: string,
  args: string[],
  spawnImpl: typeof spawn,
  timeoutMs = 5000,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawnImpl(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve(undefined)
      return
    }
    let out = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { out += chunk })
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // The probe failed and its result is already discarded.
      }
      resolve(undefined)
    }, timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const text = out.trim()
      resolve(text === '' ? undefined : text)
    })
  })
}

/**
 * Read one process's command line, or `undefined` when this platform cannot
 * report it. Used only to prove that a crashed render's PID still names that
 * render; an unknown answer must never justify a kill.
 */
export function processCommandLine(
  pid: number,
  options: { platform?: NodeJS.Platform; spawnImpl?: typeof spawn } = {},
): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(undefined)
  const platform = options.platform ?? process.platform
  const spawnImpl = options.spawnImpl ?? spawn
  if (platform === 'linux') {
    try {
      return Promise.resolve(fs.readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').split('\0').join(' ').trim())
    } catch {
      return Promise.resolve(undefined)
    }
  }
  if (platform === 'darwin') {
    return readCommandOutput('ps', ['-o', 'command=', '-p', String(pid)], spawnImpl)
  }
  if (platform === 'win32') {
    return readCommandOutput('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}").CommandLine`,
    ], spawnImpl)
  }
  return Promise.resolve(undefined)
}

const normalizeCommand = (value: string): string => value.toLowerCase().replaceAll('\\', '/')

/**
 * Whether a command line still belongs to the recorded render. Both the
 * hyperframes CLI and the project id must appear: `node.exe` alone is not
 * enough, because PID reuse often lands on another node process.
 */
export function isRenderCommandLine(commandLine: string, entry: JobRegistryEntry): boolean {
  const text = normalizeCommand(commandLine)
  if (!text.includes('hyperframes')) return false
  if (entry.projectId !== '' && !text.includes(entry.projectId.toLowerCase())) return false
  if (entry.cliPath !== undefined && !text.includes(normalizeCommand(entry.cliPath))) return false
  return true
}

export interface ReapOptions {
  platform?: NodeJS.Platform
  spawnImpl?: typeof spawn
  /** Defaults to {@link processCommandLine}. */
  commandLineFor?: CommandLineReader
  /** Defaults to {@link isPidAlive}. */
  isAlive?: (pid: number) => boolean
  /** Defaults to {@link killTree}. */
  kill?: (pid: number) => Promise<boolean>
}

/**
 * Startup orphan scan: a registry entry is retired, and its process killed only
 * when the PID still provably runs that render. A live different DSH instance
 * (`ownerPid`) keeps its own jobs and registry untouched.
 *
 * Safety rule: when the command line cannot be read or does not match, the
 * process is left alone. Killing an unrelated PID — possibly the DSH process
 * itself after PID reuse — would be far worse than leaving an orphan.
 */
export async function reapOrphans(
  dataDir: string,
  options: ReapOptions = {},
): Promise<ReapResult> {
  const { entries, corrupt } = readJobRegistries(dataDir)
  const result: ReapResult = { killed: [], removed: [...corrupt], skipped: [] }
  const alive = options.isAlive ?? isPidAlive
  const kill = options.kill ?? ((pid: number) => killTree(pid, options))
  const readCommandLine = options.commandLineFor ?? ((pid: number) => processCommandLine(pid, options))
  for (const entry of entries) {
    if (entry.ownerPid !== undefined && entry.ownerPid !== process.pid && alive(entry.ownerPid)) {
      // Another running DSH owns this render; its next start will reap it.
      result.skipped.push(entry.id)
      continue
    }
    if (entry.pid !== process.pid && alive(entry.pid)) {
      let verified = false
      try {
        const commandLine = await readCommandLine(entry.pid)
        verified = commandLine !== undefined && isRenderCommandLine(commandLine, entry)
      } catch {
        verified = false
      }
      if (verified) {
        const killed = await kill(entry.pid)
        if (killed) result.killed.push(entry.id)
        else result.skipped.push(entry.id)
      } else {
        result.skipped.push(entry.id)
      }
    }
    try {
      fs.rmSync(jobRegistryPath(dataDir, entry.id), { force: true })
      result.removed.push(entry.id)
    } catch {
      result.skipped.push(entry.id)
    }
  }
  return result
}
