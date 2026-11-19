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

/**
 * Startup orphan scan: every registry entry whose process is gone (or alive but
 * not ours to keep) is killed and deleted. The current process is never killed.
 */
export async function reapOrphans(
  dataDir: string,
  options: { platform?: NodeJS.Platform; spawnImpl?: typeof spawn } = {},
): Promise<ReapResult> {
  const { entries, corrupt } = readJobRegistries(dataDir)
  const result: ReapResult = { killed: [], removed: [...corrupt], skipped: [] }
  for (const entry of entries) {
    const file = jobRegistryPath(dataDir, entry.id)
    if (entry.pid !== process.pid && isPidAlive(entry.pid)) {
      const killed = await killTree(entry.pid, options)
      if (killed) result.killed.push(entry.id)
      else result.skipped.push(entry.id)
    }
    try {
      fs.rmSync(file, { force: true })
      result.removed.push(entry.id)
    } catch {
      result.skipped.push(entry.id)
    }
  }
  return result
}
