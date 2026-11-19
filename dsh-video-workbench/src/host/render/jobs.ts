// Render job manager: one render at a time, progress, timeout, cancel, and
// atomic output publication.
//
// The manager owns all side effects; progress parsing and naming stay in their
// own pure modules so they can be tested without spawning hyperframes.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { writeFileAtomic } from '../atomic'
import { readProject } from '../projects/store'
import { createProgressParser } from './progress'
import type { ProgressUpdate, RenderPhase } from './progress'
import { buildRenderArgs } from './args'
import {
  expiredRenders,
  exportFileName,
  nextRenderVersion,
  renderFileName,
  tempRenderPath,
} from './outputs'
import { killTree, removeJobRegistry, writeJobRegistry } from './process'
import { COMPOSITION_FILE, scaffoldCompositionHtml } from './scaffold'
import { readSupplied } from '../runtime/supply'

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timedOut'

export interface RenderOutput {
  version: number
  file: string
  bytes: number
  durationSec?: number
  width?: number
  height?: number
}

export interface RenderJobView {
  id: string
  projectId: string
  status: JobStatus
  phase: RenderPhase | 'queued'
  percent: number
  frames?: number
  totalFrames?: number
  warnings: string[]
  createdAt: string
  startedAt?: string
  finishedAt?: string
  output?: RenderOutput
  error?: string
}

export interface OutputProbe {
  durationSec: number
  width: number
  height: number
}

export interface RenderCommandInput {
  nodePath: string
  cliPath: string
  projectDir: string
  compositionPath: string
  outputPath: string
  fps: number
  aspect: '9:16' | '16:9'
  workers: number
  quality: 'draft' | 'standard' | 'high'
}

export interface CommandSpec {
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
}

export interface JobManagerOptions {
  runtimeDir: string
  projectsRoot: string
  dataDir: string
  exportDir?: string
  timeoutMs: number
  workers: number
  quality: 'draft' | 'standard' | 'high'
  keepRenders: number
  logger: { info(message: string): void; error(message: string): void }
  /** Node binary that runs the CLI (default `process.execPath`). */
  nodePath?: string
  /** Minimal child env (default `process.env`, which is only acceptable for tests). */
  renderEnv?: Record<string, string>
  now?: () => Date
  /** Build the child command; tests point this at a fake CLI. */
  commandFor?: (input: RenderCommandInput) => CommandSpec
  /** ffprobe the finished file; tests inject a stub. */
  probeOutput?: (file: string) => Promise<OutputProbe | undefined>
  /** Called on every state change (the UI polls `get`, this is for logs). */
  onChange?: (job: RenderJobView) => void
}

export interface JobManager {
  start(projectId: string): { ok: true; job: RenderJobView } | { ok: false; error: string }
  get(id: string): RenderJobView | undefined
  cancel(id: string): { ok: true; job: RenderJobView } | { ok: false; error: string }
  list(): RenderJobView[]
  /** Longest-running current or queued job, for the ping/status route. */
  active(): RenderJobView | undefined
  dispose(): Promise<void>
}

/** Parse `ffprobe -of json` output into the values the index records. */
export function parseFfprobeJson(text: string): OutputProbe | undefined {
  try {
    const raw = JSON.parse(text) as {
      streams?: Array<{ width?: unknown; height?: unknown }>
      format?: { duration?: unknown }
    }
    const stream = raw.streams?.[0]
    const durationSec = Number(raw.format?.duration)
    const width = Number(stream?.width)
    const height = Number(stream?.height)
    if (!Number.isFinite(durationSec) || !Number.isFinite(width) || !Number.isFinite(height)) return undefined
    return { durationSec, width, height }
  } catch {
    return undefined
  }
}

/** Default probe: run the runtime's own ffprobe on the finished file. */
function probeWithFfprobe(ffprobePath: string, file: string): Promise<OutputProbe | undefined> {
  return new Promise((resolve) => {
    const child = spawn(ffprobePath, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-show_entries', 'format=duration',
      '-of', 'json',
      file,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { out += chunk })
    child.on('error', () => resolve(undefined))
    child.on('close', (code) => resolve(code === 0 ? parseFfprobeJson(out) : undefined))
  })
}
const VIEW_TTL_MS = 10 * 60 * 1000
const MAX_QUEUE = 1
const INDEX_FILE = 'index.json'
const MAX_INDEX_ENTRIES = 50

export function createJobManager(options: JobManagerOptions): JobManager {
  const now = options.now ?? (() => new Date())
  const jobs = new Map<string, { view: RenderJobView; child?: ChildProcess; timer?: NodeJS.Timeout; cancelled?: boolean }>()
  const queue: string[] = []
  let running: string | undefined
  let disposed = false

  const emit = (view: RenderJobView): void => {
    try {
      options.onChange?.(view)
    } catch {
      // Observers must not break the job.
    }
  }

  const update = (id: string, patch: Partial<RenderJobView>): RenderJobView | undefined => {
    const entry = jobs.get(id)
    if (entry === undefined) return undefined
    Object.assign(entry.view, patch)
    emit(entry.view)
    return entry.view
  }

  const prune = (): void => {
    const cutoff = now().getTime() - VIEW_TTL_MS
    for (const [id, entry] of jobs) {
      if (entry.view.status === 'running' || entry.view.status === 'queued') continue
      const finished = entry.view.finishedAt === undefined ? Number.NaN : Date.parse(entry.view.finishedAt)
      if (Number.isFinite(finished) && finished < cutoff) jobs.delete(id)
    }
  }

  const rendersDirOf = (projectId: string): string => path.join(options.projectsRoot, projectId, 'renders')

  const writeIndex = (projectId: string, output: RenderOutput, title: string, fps: number): void => {
    const file = path.join(rendersDirOf(projectId), INDEX_FILE)
    let entries: unknown[] = []
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (Array.isArray(raw)) entries = raw
    } catch {
      // No index yet.
    }
    const record = {
      version: output.version,
      file: renderFileName(output.version),
      bytes: output.bytes,
      durationSec: output.durationSec,
      width: output.width,
      height: output.height,
      fps,
      title,
      createdAt: now().toISOString(),
    }
    const next = [record, ...entries].slice(0, MAX_INDEX_ENTRIES)
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`)
  }

  const applyRetention = (projectId: string): void => {
    const dir = rendersDirOf(projectId)
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const name of expiredRenders(names, options.keepRenders)) {
      try {
        fs.rmSync(path.join(dir, name), { force: true })
      } catch (error) {
        options.logger.error(`[video-workbench] 清理旧成片失败 ${name}: ${(error as Error).message}`)
      }
    }
  }

  const copyExport = (projectId: string, title: string, output: RenderOutput): void => {
    if (options.exportDir === undefined) return
    try {
      fs.mkdirSync(options.exportDir, { recursive: true })
      const existing = fs.readdirSync(options.exportDir)
      const name = exportFileName(projectId, title, output.version, existing)
      fs.copyFileSync(output.file, path.join(options.exportDir, name))
      options.logger.info(`[video-workbench] 已导出 ${name}`)
    } catch (error) {
      // Export is a convenience: a failure never invalidates the render.
      options.logger.error(`[video-workbench] 导出成片失败: ${(error as Error).message}`)
    }
  }

  const cleanupTemp = (file: string): void => {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      // Best effort.
    }
  }

  const finishFailure = (id: string, error: string): void => {
    update(id, { status: error === 'timedOut' ? 'timedOut' : error === 'cancelled' ? 'cancelled' : 'failed', error, finishedAt: now().toISOString() })
    const entry = jobs.get(id)
    if (entry !== undefined) {
      entry.timer !== undefined && clearTimeout(entry.timer)
      removeJobRegistry(options.dataDir, id)
    }
    running = undefined
    void runNext()
  }

  const finalize = async (id: string, tempFile: string, version: number, projectId: string, title: string, fps: number): Promise<void> => {
    const entry = jobs.get(id)
    if (entry === undefined || entry.cancelled === true) {
      cleanupTemp(tempFile)
      finishFailure(id, 'cancelled')
      return
    }
    let bytes = 0
    try {
      bytes = fs.statSync(tempFile).size
    } catch {
      finishFailure(id, 'render-failed')
      return
    }
    if (bytes <= 0) {
      cleanupTemp(tempFile)
      finishFailure(id, 'render-failed')
      return
    }
    const suppliedForProbe = readSupplied(options.runtimeDir)
    const probe = options.probeOutput !== undefined
      ? await options.probeOutput(tempFile)
      : suppliedForProbe === undefined
        ? undefined
        : await probeWithFfprobe(suppliedForProbe.binaries.ffprobe, tempFile)
    if (probe !== undefined && (!(probe.durationSec > 0) || probe.width <= 0 || probe.height <= 0)) {
      cleanupTemp(tempFile)
      finishFailure(id, 'output-invalid')
      return
    }
    const target = path.join(rendersDirOf(projectId), renderFileName(version))
    try {
      fs.renameSync(tempFile, target)
    } catch {
      cleanupTemp(tempFile)
      finishFailure(id, 'output-publish-failed')
      return
    }
    const output: RenderOutput = {
      version,
      file: target,
      bytes,
      ...(probe === undefined ? {} : { durationSec: probe.durationSec, width: probe.width, height: probe.height }),
    }
    try {
      writeIndex(projectId, output, title, fps)
    } catch (error) {
      options.logger.error(`[video-workbench] 写 renders/index.json 失败: ${(error as Error).message}`)
    }
    applyRetention(projectId)
    copyExport(projectId, title, output)
    update(id, {
      status: 'succeeded',
      phase: 'done',
      percent: 100,
      finishedAt: now().toISOString(),
      output,
    })
    removeJobRegistry(options.dataDir, id)
    running = undefined
    void runNext()
  }

  const runJob = (id: string): void => {
    const entry = jobs.get(id)
    if (entry === undefined) return
    const view = entry.view
    const project = readProject(options.projectsRoot, view.projectId)
    if (!project.ok) {
      finishFailure(id, 'project-invalid')
      return
    }
    const projectDir = path.join(options.projectsRoot, view.projectId)
    const compositionPath = path.join(projectDir, COMPOSITION_FILE)
    if (!fs.existsSync(compositionPath)) {
      // M2: a fresh project has no composition yet; write the offline scaffold so
      // the UI can render immediately. M3/M4 replace it with a richer template.
      try {
        fs.mkdirSync(path.dirname(compositionPath), { recursive: true })
        fs.writeFileSync(compositionPath, scaffoldCompositionHtml({
          title: project.project.title,
          aspect: project.project.aspect,
          scenes: project.project.scenes,
        }), 'utf8')
      } catch {
        finishFailure(id, 'composition-missing')
        return
      }
    }
    const rendersDir = rendersDirOf(view.projectId)
    fs.mkdirSync(rendersDir, { recursive: true })
    let version = 1
    try {
      version = nextRenderVersion(fs.readdirSync(rendersDir))
    } catch {
      version = 1
    }
    const tempFile = tempRenderPath(rendersDir, version, randomBytes(4).toString('hex'))

    const supplied = readSupplied(options.runtimeDir)
    const nodePath = options.nodePath ?? process.execPath
    const cliPath = supplied?.binaries.cli ?? path.join(options.runtimeDir, 'node_modules', 'hyperframes', 'dist', 'cli.js')
    const commandInput: RenderCommandInput = {
      nodePath,
      cliPath,
      projectDir,
      compositionPath,
      outputPath: tempFile,
      fps: project.project.fps,
      aspect: project.project.aspect,
      workers: options.workers,
      quality: options.quality,
    }
    let spec: CommandSpec
    try {
      spec = options.commandFor === undefined
        ? {
          command: nodePath,
          args: buildRenderArgs(commandInput).slice(1),
          env: options.renderEnv ?? process.env as Record<string, string>,
          cwd: projectDir,
        }
        : options.commandFor(commandInput)
    } catch (error) {
      finishFailure(id, (error as Error).message)
      return
    }

    let child: ChildProcess
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      finishFailure(id, 'spawn-failed')
      return
    }
    entry.child = child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    const parser = createProgressParser()
    const consume = (chunk: string): void => {
      for (const update of parser.feed(chunk)) {
        const current = jobs.get(id)
        if (current === undefined) return
        applyUpdate(id, update)
      }
    }
    const applyUpdate = (jobId: string, change: ProgressUpdate): void => {
      const patch: Partial<RenderJobView> = { phase: change.phase, percent: change.percent }
      if (change.frames !== undefined) patch.frames = change.frames
      if (change.totalFrames !== undefined) patch.totalFrames = change.totalFrames
      if (change.warning !== undefined) {
        const entryNow = jobs.get(jobId)
        patch.warnings = [...(entryNow?.view.warnings ?? []), change.warning].slice(-20)
      }
      update(jobId, patch)
    }
    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)

    const pid = child.pid
    if (pid !== undefined) {
      try {
        writeJobRegistry(options.dataDir, {
          id,
          pid,
          projectId: view.projectId,
          startedAt: now().toISOString(),
          command: path.basename(spec.command),
        })
      } catch {
        // Registry is for crash recovery only.
      }
    }
    entry.timer = setTimeout(() => {
      entry.cancelled = true
      if (pid !== undefined) void killTree(pid)
      finishFailure(id, 'timedOut')
    }, options.timeoutMs)
    if (entry.timer.unref !== undefined) entry.timer.unref()

    update(id, { status: 'running', phase: 'preparing', percent: 5, startedAt: now().toISOString() })

    child.on('error', () => {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      finishFailure(id, 'spawn-failed')
    })
    child.on('close', (code) => {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      if (entry.cancelled === true) {
        cleanupTemp(tempFile)
        finishFailure(id, 'cancelled')
        return
      }
      if (code !== 0) {
        cleanupTemp(tempFile)
        finishFailure(id, 'render-failed')
        return
      }
      void finalize(id, tempFile, version, view.projectId, project.project.title, project.project.fps)
    })
  }

  const runNext = (): void => {
    if (disposed) return
    if (running !== undefined) return
    const next = queue.shift()
    if (next === undefined) return
    running = next
    runJob(next)
  }

  return {
    start(projectId) {
      prune()
      if (disposed) return { ok: false, error: 'disposed' }
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(projectId)) return { ok: false, error: 'invalid-project' }
      if (running !== undefined && queue.length >= MAX_QUEUE) return { ok: false, error: 'busy' }
      const id = `r-${now().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`
      const view: RenderJobView = {
        id,
        projectId,
        status: 'queued',
        phase: 'queued',
        percent: 0,
        warnings: [],
        createdAt: now().toISOString(),
      }
      jobs.set(id, { view })
      queue.push(id)
      emit(view)
      void runNext()
      return { ok: true, job: view }
    },
    get(id) {
      prune()
      return jobs.get(id)?.view
    },
    cancel(id) {
      const entry = jobs.get(id)
      if (entry === undefined) return { ok: false, error: 'not-found' }
      const view = entry.view
      if (view.status === 'succeeded' || view.status === 'failed'
        || view.status === 'cancelled' || view.status === 'timedOut') {
        return { ok: false, error: 'finished' }
      }
      if (view.status === 'queued') {
        const index = queue.indexOf(id)
        if (index >= 0) queue.splice(index, 1)
        update(id, { status: 'cancelled', error: 'cancelled', finishedAt: now().toISOString() })
        return { ok: true, job: jobs.get(id)!.view }
      }
      entry.cancelled = true
      const pid = entry.child?.pid
      if (pid !== undefined) void killTree(pid)
      return { ok: true, job: view }
    },
    list() {
      prune()
      return [...jobs.values()].map((entry) => entry.view)
    },
    active() {
      return running === undefined ? undefined : jobs.get(running)?.view
    },
    async dispose() {
      disposed = true
      for (const entry of jobs.values()) {
        if (entry.timer !== undefined) clearTimeout(entry.timer)
        const pid = entry.child?.pid
        if (pid !== undefined) {
          entry.cancelled = true
          await killTree(pid)
        }
      }
      queue.length = 0
      running = undefined
    },
  }
}
