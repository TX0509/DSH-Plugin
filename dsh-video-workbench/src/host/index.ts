import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { HostContext, IndexInjection } from '../shared/dsh'
import {
  MEDIA_PATH,
  PING_PATH,
  PROJECTS_LIST_PATH,
  PROJECTS_PATH,
  RENDER_PATH,
  RUNTIME_INSTALL_PATH,
  RUNTIME_PATH,
  SELFCHECK_PATH,
  TOKEN_GLOBAL,
  TOKEN_HEADER,
} from '../shared/routes'

import { hostLogger, redactPath } from './adapters/logger'
import { defer } from './adapters/lifecycle'
import { withWebServer } from './adapters/web-server'
import { readToken, sendJson } from './http'
import { tokenEquals as tokenEqualsImpl } from './index-internal'
import { contains, isFilesystemRoot, safeResolve } from './paths'
import type { ProjectsConfig, ProjectsState } from './projects/root'
import { resolveProjectsRoot } from './projects/root'
import { buildRenderEnv } from './runtime/env'
import { chromeCandidates, pickChrome } from './runtime/locate'
import { createProjectsListHandler } from './projects/routes'
import { createRenderHandler } from './render/routes'
import { createJobManager } from './render/jobs'
import type { RenderQuality } from './render/args'
import { reapOrphans } from './render/process'
import { createRuntimeInstallHandler, createRuntimeStateHandler } from './runtime/routes'
import { describeRuntime } from './runtime/status'
import type { RuntimeStatusView } from './runtime/status'
import { installRuntime, readSupplied, resolveInstallTools, runtimeState } from './runtime/supply'
import type { RuntimeProbe } from './selfcheck'
import { runSelfcheck } from './selfcheck'
import { readSelfcheckReport, writeSelfcheckReport } from './selfcheck-report'

// Re-exported for tests and for the routes that share this wire contract.
export {
  MEDIA_PATH,
  PING_PATH,
  PROJECTS_LIST_PATH,
  PROJECTS_PATH,
  RENDER_PATH,
  RUNTIME_INSTALL_PATH,
  RUNTIME_PATH,
  SELFCHECK_PATH,
  TOKEN_GLOBAL,
} from '../shared/routes'
export { contains, isFilesystemRoot, safeResolve } from './paths'
export { redactPath } from './adapters/logger'
export { resolveProjectsRoot } from './projects/root'
export { migrateProject } from './projects/migrate'
export { ASPECTS, FPS_VALUES, SCHEMA_VERSION, validateProject } from './projects/schema'
export {
  PROJECT_FILE,
  PROJECT_SUBDIRS,
  createProject,
  defaultScene,
  ensureProjectRoot,
  listProjects,
  persistProject,
  readProject,
  slugFor,
  writeProject,
} from './projects/store'
export { runSelfcheck } from './selfcheck'
export { SELFCHECK_REPORT, readSelfcheckReport, writeSelfcheckReport } from './selfcheck-report'
// M2 render pipeline: pure helpers (probing, child env, argv). The side-effecting
// parts (install, jobs, routes) are wired in later steps.
export {
  MIN_NODE_MAJOR,
  chromeCandidates,
  listRuntimeDependencyDirs,
  majorOf,
  nodeCandidates,
  parseVersion,
  pickChrome,
  pickNode,
} from './runtime/locate'
export { buildRenderEnv } from './runtime/env'
export { createJobManager, parseFfprobeJson } from './render/jobs'
export { COMPOSITION_FILE, SIZE_BY_ASPECT, scaffoldCompositionHtml } from './render/scaffold'
export { createRenderHandler } from './render/routes'
export { createProgressParser, parseProgressLine, stripAnsi } from './render/progress'
export {
  expiredRenders,
  exportFileName,
  nextRenderVersion,
  renderFileName,
  renderVersionOf,
  safeTitle,
  tempRenderPath,
} from './render/outputs'
export {
  isPidAlive,
  jobRegistryPath,
  killTree,
  readJobRegistries,
  reapOrphans,
  removeJobRegistry,
  writeJobRegistry,
} from './render/process'
export {
  ALLOW_BUILD_PACKAGES,
  RUNTIME_VERSIONS,
  installCommands,
  installRuntime,
  readSupplied,
  resolveInstallTools,
  runtimePaths,
  runtimeState,
} from './runtime/supply'
export { describeRuntime } from './runtime/status'
export { createRuntimeInstallHandler, createRuntimeStateHandler } from './runtime/routes'
export { RENDER_QUALITIES, RESOLUTION_BY_ASPECT, buildRenderArgs } from './render/args'

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
}

export interface PluginConfig {
  mediaRoot?: string
  /**
   * Required for project features. When unset the plugin still mounts the
   * media route (M0 behaviour) but project features stay disabled, so nothing
   * is ever written to an unexpected drive.
   */
  projectsRoot?: string
  /** Optional renders copy target; never served by a route. */
  exportDir?: string
  /** Plugin data dir for caches and the self-check report. */
  dataDir?: string
  /**
   * Run `video_selfcheck` shortly after startup and write the report to
   * `dataDir/selfcheck.json` (default true).
   */
  selfcheckOnStartup?: boolean
  /** Delay before the startup self-check, in ms (default 3000). */
  selfcheckDelayMs?: number
  /** Media file the probe reads, relative to mediaRoot (default `test.mp4`). */
  selfcheckMediaPath?: string
  requireToken?: boolean
  /** Render runtime install directory (default `$DSH_HOME/cache/dsh-video-workbench/runtime`). */
  runtimeDir?: string
  /** Chrome executable; overrides the probing chain. */
  chromePath?: string
  /** Single render timeout in ms (default 600000). */
  renderTimeoutMs?: number
  /** hyperframes workers (default 2). */
  renderWorkers?: number
  /** `draft` / `standard` / `high` (default standard). */
  renderQuality?: string
  /** Newest renders kept per project (default 5). */
  keepRenders?: number
}

/** `ready` = usable; `unset` = not configured; `invalid` = configured but unusable. */
interface RouteContext {
  root: string
  token: string
  requireToken: boolean
}

interface HandlerOptions {
  root: string
  token: string
  requireToken?: boolean
}

interface PingOptions extends HandlerOptions {
  projects?: ProjectsState
}

interface SelfcheckRouteOptions {
  getOrigin(): string | undefined
  token: string
  requireToken: boolean
  mediaRoot: string
  projects: ProjectsConfig
  /** Same sample the startup self-check probes; must not drift from it. */
  mediaProbePath?: string
  /** Runtime state is read per request so an install finishes visibly. */
  runtime(): RuntimeProbe
}

type RangeBounds = { start: number; end: number }
/**
 * `undefined` — no Range header; `'unrecognized'` — a Range we do not handle
 * (unknown unit, multiple ranges, malformed syntax) and therefore ignore;
 * `'unsatisfiable'` — a single valid `bytes` range that cannot be served (416).
 */
type ParsedRange = RangeBounds | 'unrecognized' | 'unsatisfiable' | undefined

function dshHome(): string {
  return typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
}

export function defaultMediaRoot(): string {
  return path.join(dshHome(), 'cache', 'dsh-video-workbench', 'media')
}

/** Plugin data dir: caches, logs and the self-check report. */
export function defaultDataDir(): string {
  return path.join(dshHome(), 'cache', 'dsh-video-workbench')
}

/**
 * Parse one `Range: bytes=` header.
 *
 * Only a single `bytes` range is served. Anything else is *ignored* (the caller
 * answers 200 with the whole file), because RFC 9110 §14.2 lets a server ignore
 * a Range it does not support; 416 is reserved for a valid range that cannot be
 * satisfied (RFC 9110 §15.5.17). The unit is case-insensitive per RFC 9110 §2.
 */
export function parseRange(header: string | undefined, size: number): ParsedRange {
  if (typeof header !== 'string') return undefined
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(header.trim())
  // Unknown unit, multiple ranges, or malformed syntax: ignore the header.
  if (match === null) return 'unrecognized'
  const rawStart = match[1]
  const rawEnd = match[2]
  if (rawStart === '' && rawEnd === '') return 'unrecognized'
  let start: number
  let end: number
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'unrecognized'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 'unrecognized'
  }
  if (start > end || start >= size || end < 0) return 'unsatisfiable'
  return { start, end: Math.min(end, size - 1) }
}

export function tokenEquals(supplied: string | undefined, expected: string): boolean {
  return tokenEqualsImpl(supplied, expected)
}

/** `If-None-Match` may carry a weak prefix or a list; compare each member. */
export function matchesEtag(header: string | undefined, etag: string): boolean {
  if (typeof header !== 'string') return false
  const value = header.trim()
  if (value === '*') return true
  if (value.length === 0) return false
  return value.split(',').some((part) => {
    const member = part.trim()
    return member === etag || member === `W/${etag}`
  })
}

function statFile(candidate: string): fs.Stats | undefined {
  try {
    return fs.statSync(candidate)
  } catch {
    return undefined
  }
}

/** Resolve symlinks and prove the real file still lives under the real root. */
function realFileInside(root: string, candidate: string): string | undefined {
  let real: string
  let rootReal: string
  try {
    real = fs.realpathSync(candidate)
    // Resolved per request: the root may be created after the plugin loads, or
    // reach the filesystem through a junction.
    rootReal = fs.realpathSync(root)
  } catch {
    return undefined
  }
  return contains(rootReal, real) ? real : undefined
}

function serveMedia(request: IncomingMessage, response: ServerResponse, context: RouteContext): void {
  if (context.requireToken && !tokenEquals(readToken(request), context.token)) {
    sendJson(response, 401, { error: 'unauthorized' })
    return
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' })
    response.end()
    return
  }

  const url = new URL(request.url ?? '/', 'http://placeholder.invalid')
  const relative = url.searchParams.get('path') ?? ''
  const absolute = safeResolve(context.root, relative)
  if (absolute === undefined) {
    sendJson(response, 400, { error: 'invalid-path' })
    return
  }

  const real = realFileInside(context.root, absolute)
  if (real === undefined) {
    sendJson(response, 404, { error: 'not-found' })
    return
  }

  const stat = statFile(real)
  if (stat === undefined) {
    sendJson(response, 404, { error: 'not-found' })
    return
  }
  if (!stat.isFile()) {
    sendJson(response, 404, { error: 'not-a-file' })
    return
  }

  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}-${Math.floor(stat.ctimeMs).toString(16)}"`
  const base: Record<string, string> = {
    'content-type': MIME[path.extname(real).toLowerCase()] ?? 'application/octet-stream',
    // Media and project files are writable by the agent; never let the browser
    // re-interpret an unknown extension as something executable.
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
    etag,
    'last-modified': stat.mtime.toUTCString(),
  }

  // If-None-Match is evaluated before Range: a matching validator answers 304
  // even when the request also carries a Range header (RFC 7232 §6).
  if (matchesEtag(request.headers['if-none-match'], etag)) {
    response.writeHead(304, {
      etag,
      'cache-control': base['cache-control'],
      'last-modified': base['last-modified'],
      'accept-ranges': base['accept-ranges'],
    })
    response.end()
    return
  }

  const requested = request.headers['if-range']
  const parsed: ParsedRange = requested === undefined || requested === etag
    ? parseRange(request.headers.range, stat.size)
    : undefined
  // A Range we do not handle is ignored (200 with the whole file); only a valid
  // single range that cannot be satisfied gets 416.
  const range: RangeBounds | undefined = typeof parsed === 'object' ? parsed : undefined

  if (parsed === 'unsatisfiable') {
    response.writeHead(416, { ...base, 'content-range': `bytes */${stat.size}` })
    response.end()
    return
  }

  const start = range === undefined ? 0 : range.start
  const end = range === undefined ? Math.max(0, stat.size - 1) : range.end
  const length = stat.size === 0 ? 0 : end - start + 1
  const headers: Record<string, string> = { ...base, 'content-length': String(length) }
  if (range !== undefined) headers['content-range'] = `bytes ${start}-${end}/${stat.size}`
  response.writeHead(range === undefined ? 200 : 206, headers)

  if (request.method === 'HEAD' || length === 0) {
    response.end()
    return
  }

  const stream = fs.createReadStream(real, { start, end })
  stream.on('error', () => response.destroy())
  response.on('close', () => stream.destroy())
  stream.pipe(response)
}

/** Shared request context for the route handlers. */
function createContext(options: HandlerOptions): RouteContext {
  return {
    root: path.resolve(options.root),
    token: options.token,
    requireToken: options.requireToken !== false,
  }
}

/**
 * Build a read-only file route handler (Range + ETag).
 * Exported so tests can drive it over real HTTP; used by `/media` and
 * `/projects` alike, the only difference is the root directory.
 */
export function createFileHandler(options: HandlerOptions): (request: IncomingMessage, response: ServerResponse) => void {
  const context = createContext(options)
  return (request, response) => serveMedia(request, response, context)
}

/** Build the health route handler. */
export function createPingHandler(options: PingOptions): (request: IncomingMessage, response: ServerResponse) => void {
  const context = createContext(options)
  return (request, response) => {
    if (context.requireToken && !tokenEquals(readToken(request), context.token)) {
      sendJson(response, 401, { error: 'unauthorized' })
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' })
      response.end()
      return
    }
    sendJson(response, 200, {
      ok: true,
      mediaRootExists: fs.existsSync(context.root),
      requireToken: context.requireToken,
      projects: options.projects ?? 'unset',
    })
  }
}

/**
 * Index-injection row carrying the media token.
 * Owner filtering happens in the web-server adapter, not here.
 */
function createIndexInjector(token: string): (table: IndexInjection[]) => void {
  return (table) => {
    table.push({ kind: 'global', name: TOKEN_GLOBAL, value: { token } })
  }
}

/**
 * `video_selfcheck` over HTTP: same token as the other routes, and the checks
 * inside run against the Host's own origin so route mounting is really tested.
 * The run is aborted when the caller disconnects.
 */
function createSelfcheckHandler(options: SelfcheckRouteOptions): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (options.requireToken && !tokenEquals(readToken(request), options.token)) {
      sendJson(response, 401, { error: 'unauthorized' })
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' })
      response.end()
      return
    }
    const controller = new AbortController()
    // Only a disconnect before the response is written means "give up"; a close
    // after `end()` is the normal completion of a kept-alive connection.
    const abort = (): void => {
      if (!response.writableEnded) controller.abort()
    }
    response.once('close', abort)
    void runSelfcheck({ ...options, runtime: options.runtime(), signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return
        sendJson(response, 200, result)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        // Details stay in the local log; the caller only needs to know it broke.
        sendJson(response, 500, { ok: false, error: 'selfcheck-failed' })
      })
      .finally(() => {
        response.off('close', abort)
      })
  }
}

export function apply(ctx: HostContext, config: PluginConfig = {}): void {
  const logger = hostLogger(ctx)
  const configured = typeof config.mediaRoot === 'string' && config.mediaRoot.trim().length > 0
    ? config.mediaRoot.trim()
    : defaultMediaRoot()
  let mediaRoot = path.resolve(configured)
  if (isFilesystemRoot(mediaRoot)) {
    const fallback = path.resolve(defaultMediaRoot())
    logger.error(`[video-workbench] mediaRoot "${redactPath(mediaRoot)}" is a filesystem root; falling back to ${redactPath(fallback)}`)
    mediaRoot = fallback
  }
  const exportDir = typeof config.exportDir === 'string' && config.exportDir.trim().length > 0
    ? path.resolve(config.exportDir.trim())
    : undefined
  let dataDir = typeof config.dataDir === 'string' && config.dataDir.trim().length > 0
    ? path.resolve(config.dataDir.trim())
    : defaultDataDir()
  if (isFilesystemRoot(dataDir)) {
    const fallback = path.resolve(defaultDataDir())
    logger.error(`[video-workbench] dataDir "${redactPath(dataDir)}" is a filesystem root; falling back to ${redactPath(fallback)}`)
    dataDir = fallback
  }
  const selfcheckMediaPath = typeof config.selfcheckMediaPath === 'string'
    && config.selfcheckMediaPath.trim().length > 0
    ? config.selfcheckMediaPath.trim()
    : undefined
  const runtimeDir = typeof config.runtimeDir === 'string' && config.runtimeDir.trim().length > 0
    ? path.resolve(config.runtimeDir.trim())
    : path.join(dataDir, 'runtime')
  const chromePick = pickChrome(
    chromeCandidates({ configured: config.chromePath, env: process.env }),
    (candidatePath) => {
      try {
        return fs.statSync(candidatePath).isFile()
      } catch {
        return false
      }
    },
  )
  const browserSource = chromePick.chosen?.source
  if (browserSource === undefined) {
    logger.error('[video-workbench] 未找到 Chrome：渲染功能需要 Chrome，或配置 chromePath')
  }
  const requireToken = config.requireToken !== false
  const renderTimeoutMs = typeof config.renderTimeoutMs === 'number'
    && Number.isFinite(config.renderTimeoutMs) && config.renderTimeoutMs >= 1000
    ? Math.floor(config.renderTimeoutMs)
    : 10 * 60 * 1000
  const renderWorkers = typeof config.renderWorkers === 'number'
    && Number.isInteger(config.renderWorkers) && config.renderWorkers >= 1 && config.renderWorkers <= 8
    ? config.renderWorkers
    : 2
  const renderQuality: RenderQuality = config.renderQuality === 'draft' || config.renderQuality === 'high'
    ? config.renderQuality
    : 'standard'
  const keepRenders = typeof config.keepRenders === 'number'
    && Number.isInteger(config.keepRenders) && config.keepRenders >= 1
    ? config.keepRenders
    : 5
  const token = randomBytes(24).toString('base64url')

  withWebServer(ctx, (server) => {
    // Resolve (and create) the project root only once the plugin is actually
    // active, so a profile without a web server does not create directories.
    const projects = resolveProjectsRoot(config.projectsRoot)
    if (projects.state === 'invalid') {
      logger.error(`[video-workbench] ${String(projects.detail)}`
        + `${typeof config.projectsRoot === 'string' ? ` (${redactPath(config.projectsRoot)})` : ''}`)
    }

    // The page receives the token as a global during index injection; the
    // adapter serves only authenticated owner pages.
    server.onIndexInject(createIndexInjector(token))

    // --- M2: render runtime state, install trigger and self-check probe ------
    let installing = false
    let installError: string | undefined
    const runtimeProbe = (): RuntimeProbe => {
      const supplied = readSupplied(runtimeDir)
      return {
        state: runtimeState(runtimeDir),
        cliExists: supplied !== undefined && fs.existsSync(supplied.binaries.cli),
        ffmpegExists: supplied !== undefined && fs.existsSync(supplied.binaries.ffmpeg),
        ffprobeExists: supplied !== undefined && fs.existsSync(supplied.binaries.ffprobe),
        ...(browserSource === undefined ? {} : { browser: { source: browserSource } }),
      }
    }
    const runtimeStatus = (): RuntimeStatusView => describeRuntime({
      runtimeDir,
      ...(browserSource === undefined ? {} : { browserSource }),
      installing,
      ...(installError === undefined ? {} : { lastError: installError }),
    })
    const startInstall = (): void => {
      if (installing) return
      const tools = resolveInstallTools({
        dshHome: dshHome(),
        dshNodeExecutable: process.env.DSH_NODE_EXECUTABLE,
        pathEnv: process.env.PATH,
        buildEnv: (nodeBinDir, extra) => buildRenderEnv({
          baseEnv: process.env,
          nodeBinDir,
          ...(extra === undefined ? {} : { extra }),
        }),
      })
      if (tools === undefined) {
        installError = 'node-not-found'
        logger.error('[video-workbench] 安装运行时失败：找不到 node ≥22 或托管 pnpm')
        return
      }
      installing = true
      installError = undefined
      logger.info(`[video-workbench] 开始安装渲染运行时（node ${tools.nodeVersion}）`)
      void installRuntime({
        runtimeDir,
        nodePath: tools.nodePath,
        pnpmScriptPath: tools.pnpmScriptPath,
        env: tools.env,
      }).then((result) => {
        if (result.ok) {
          logger.info(`[video-workbench] 运行时就绪：hyperframes ${result.supplied.versions.hyperframes}`)
        } else {
          installError = result.error
          logger.error(`[video-workbench] 安装运行时失败：${result.error}（日志 ${redactPath(path.join(runtimeDir, 'install.log'))}）`)
        }
      }).finally(() => {
        installing = false
      })
    }
    const runtimeRoutes = { token, requireToken, status: runtimeStatus, startInstall }
    server.registerRoute({
      kind: 'exact',
      path: RUNTIME_PATH,
      handler: createRuntimeStateHandler(runtimeRoutes),
    }, 'video-workbench:runtime')
    server.registerRoute({
      kind: 'exact',
      path: RUNTIME_INSTALL_PATH,
      handler: createRuntimeInstallHandler(runtimeRoutes),
    }, 'video-workbench:runtime-install')

    // --- M2: render jobs (only when a project root exists) -------------------
    if (projects.root !== undefined) {
      // The renderer runs on a real Node (≥22), not on the Electron binary, and
      // with an explicit minimal env; both come from the same resolver the
      // install uses.
      const tools = resolveInstallTools({
        dshHome: dshHome(),
        dshNodeExecutable: process.env.DSH_NODE_EXECUTABLE,
        pathEnv: process.env.PATH,
        buildEnv: (nodeBinDir, extra) => buildRenderEnv({
          baseEnv: process.env,
          nodeBinDir,
          // hyperframes does not find the system Chrome on Windows; without this
          // it tries to download a headless shell instead of rendering offline.
          ...(chromePick.chosen === undefined ? {} : { browserPath: chromePick.chosen.path }),
          ...(extra === undefined ? {} : { extra }),
        }),
      })
      const jobs = createJobManager({
        runtimeDir,
        projectsRoot: projects.root,
        dataDir,
        ...(exportDir === undefined ? {} : { exportDir }),
        timeoutMs: renderTimeoutMs,
        workers: renderWorkers,
        quality: renderQuality,
        keepRenders,
        logger,
        ...(tools === undefined ? {} : { nodePath: tools.nodePath, renderEnv: tools.env }),
        onChange: () => {},
      })
      // A crashed DSH may leave a render (and its Chrome trees) behind.
      void reapOrphans(dataDir).then((reaped) => {
        if (reaped.killed.length > 0) {
          logger.info(`[video-workbench] 清理了 ${reaped.killed.length} 个上次遗留的渲染进程`)
        }
      }).catch(() => {
        // Orphan cleanup is best effort.
      })
      server.registerRoute({
        kind: 'prefix',
        path: RENDER_PATH,
        handler: createRenderHandler({
          token,
          requireToken,
          start: (projectId) => jobs.start(projectId),
          get: (id) => jobs.get(id),
          cancel: (id) => jobs.cancel(id),
        }),
      }, 'video-workbench:render')
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          void jobs.dispose()
        }, 'video-workbench:render-jobs')
      }
    }

    server.registerRoute({
      kind: 'exact',
      path: PING_PATH,
      handler: createPingHandler({
        root: mediaRoot,
        token,
        requireToken,
        projects: projects.state,
      }),
    }, 'video-workbench:ping')

    server.registerRoute({
      kind: 'prefix',
      path: MEDIA_PATH,
      handler: createFileHandler({ root: mediaRoot, token, requireToken }),
    }, 'video-workbench:media')

    // Project files are only reachable when `projectsRoot` is usable; the
    // media route keeps working either way.
    if (projects.root !== undefined) {
      server.registerRoute({
        kind: 'prefix',
        path: PROJECTS_PATH,
        handler: createFileHandler({ root: projects.root, token, requireToken }),
      }, 'video-workbench:projects')
    }

    // The render UI needs the newest-first project list; the route is always
    // mounted so the page can explain why the project feature is off.
    server.registerRoute({
      kind: 'exact',
      path: PROJECTS_LIST_PATH,
      handler: createProjectsListHandler({ token, requireToken, projects }),
    }, 'video-workbench:projects-list')

    // The checks inside need `getOrigin()`, which only answers after the
    // listener binds, so it is resolved per request.
    server.registerRoute({
      kind: 'exact',
      path: SELFCHECK_PATH,
      handler: createSelfcheckHandler({
        getOrigin: () => server.origin(),
        token,
        requireToken,
        mediaRoot,
        projects,
        mediaProbePath: selfcheckMediaPath,
        runtime: runtimeProbe,
      }),
    }, 'video-workbench:selfcheck')

    // Leave a report on disk so M1 acceptance is checkable after a restart
    // without DevTools or the token; `selfcheckOnStartup: false` disables it.
    if (config.selfcheckOnStartup !== false) {
      const delayMs = typeof config.selfcheckDelayMs === 'number'
        && Number.isFinite(config.selfcheckDelayMs) && config.selfcheckDelayMs >= 0
        ? config.selfcheckDelayMs
        : 3000
      // Aborted on unload so a run that already started cannot write a report
      // or log after the plugin is gone.
      const controller = new AbortController()
      defer(ctx, delayMs, 'video-workbench:selfcheck', () => {
        void runSelfcheck({
          getOrigin: () => server.origin(),
          token,
          requireToken,
          mediaRoot,
          projects,
          mediaProbePath: selfcheckMediaPath,
          runtime: runtimeProbe(),
          signal: controller.signal,
        }).then((result) => {
          if (controller.signal.aborted) return
          try {
            writeSelfcheckReport(dataDir, result)
          } catch (error) {
            // fs error messages embed the absolute target path; log the code plus
            // the (redacted) directory instead of the raw message.
            const code = (error as NodeJS.ErrnoException).code ?? 'unknown'
            logger.error(`[video-workbench] 无法写入 selfcheck 报告: ${code}（${redactPath(dataDir)}）`)
          }
          const failed = result.checks.filter((check) => !check.ok)
          const skipped = result.checks.filter((check) => check.skipped === true)
          const skippedNote = skipped.length === 0
            ? ''
            : `（${skipped.length} 项跳过：${skipped.map((check) => check.name).join('、')}）`
          if (failed.length === 0) {
            logger.info(`[video-workbench] selfcheck: ${result.checks.length - skipped.length} 项通过${skippedNote}`)
          } else {
            logger.error(`[video-workbench] selfcheck ${result.checks.length - failed.length}/${result.checks.length} 通过：`
              + failed.map((check) => `${check.name}（${check.detail}）`).join('；'))
          }
        }).catch((error: unknown) => {
          if (controller.signal.aborted) return
          // Unexpected failure: name + message only (they carry the origin, not a
          // user directory). The stack would be noise in the profile log.
          const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
          logger.error(`[video-workbench] selfcheck 异常: ${text}`)
        })
      }, () => controller.abort())
    }

    logger.info(`[video-workbench] projects: ${projects.state}`
      + `${projects.root === undefined ? '' : ` (${redactPath(projects.root)})`}`
      + `${exportDir === undefined ? '' : `, export: ${redactPath(exportDir)}`}`)
  })

  logger.info(`[video-workbench] media root: ${redactPath(mediaRoot)} (token required: ${requireToken})`)
  logger.info(`[video-workbench] data dir: ${redactPath(dataDir)}`)
}
