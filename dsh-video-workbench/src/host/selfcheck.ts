// video_selfcheck: the five M1 checks that need no rendering.
//
// Route checks go over real HTTP against the Host's own origin, so a route that
// was never registered fails here instead of being assumed to work.

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { MEDIA_PATH, PING_PATH, PROJECTS_PATH } from '../shared/routes'

import type { ProjectsConfig } from './projects/root'
import { listProjects } from './projects/store'

export type SelfcheckName =
  | 'routeMounted'
  | 'tokenRequired'
  | 'mediaProbe'
  | 'projectsRootWritable'
  | 'projectsRoute'
  | 'runtimeReady'
  | 'browserFound'
  | 'ffmpegReady'

/** What the render runtime looks like right now; supplied by `apply`. */
export interface RuntimeProbe {
  state: 'ready' | 'missing' | 'installing'
  cliExists: boolean
  ffmpegExists: boolean
  ffprobeExists: boolean
  browser?: { source: string }
}

export interface SelfcheckCheck {
  name: SelfcheckName
  ok: boolean
  /** True for a check that did not apply (feature not configured). */
  skipped?: boolean
  detail: string
}

export interface SelfcheckResult {
  ok: boolean
  checks: SelfcheckCheck[]
}

export interface SelfcheckOptions {
  /** Host listener origin; undefined before the port binds. */
  getOrigin(): string | undefined
  token: string
  requireToken: boolean
  mediaRoot: string
  projects: ProjectsConfig
  /** Project-relative media file the probe reads; defaults to `test.mp4`. */
  mediaProbePath?: string
  /** Render runtime status (M2 checks). */
  runtime?: RuntimeProbe
  /** Aborted when the plugin unloads: in-flight probes stop instead of running on. */
  signal?: AbortSignal
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** M0's sample clip; the media probe reads its first 100 bytes. */
const PROBE_MEDIA = 'test.mp4'
const DEFAULT_TIMEOUT_MS = 5000

class ProbeError extends Error {}

function fail(name: SelfcheckName, detail: string): SelfcheckCheck {
  return { name, ok: false, detail }
}

function pass(name: SelfcheckName, detail: string): SelfcheckCheck {
  return { name, ok: true, detail }
}

/** A check that does not apply to this configuration; not a failure. */
function skip(name: SelfcheckName, detail: string): SelfcheckCheck {
  return { name, ok: true, skipped: true, detail }
}

/** The plugin unloaded while this check was waiting; not a failure either. */
function cancelled(name: SelfcheckName): SelfcheckCheck {
  return { name, ok: false, detail: '已取消（插件正在卸载）' }
}

function errorText(error: unknown): string {
  if (error instanceof ProbeError) return error.message
  return error instanceof Error ? error.message : String(error)
}

async function request(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const forward = (): void => controller.abort()
  if (signal?.aborted === true) controller.abort()
  else signal?.addEventListener('abort', forward, { once: true })
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } catch (error) {
    throw new ProbeError(`请求失败：${errorText(error)}`)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await response.json()
    return typeof body === 'object' && body !== null ? body as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Close a response whose body the check does not need. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Nothing to clean up if the body was already consumed.
  }
}

interface Observed {
  /** `requireToken` reported by the authenticated ping, when it answered. */
  pingRequireToken?: boolean
}

async function checkRouteMounted(
  options: SelfcheckOptions,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  origin: string | undefined,
  observed: Observed,
): Promise<SelfcheckCheck> {
  if (options.signal?.aborted === true) return cancelled('routeMounted')
  if (origin === undefined) {
    return fail('routeMounted', 'Host 尚未提供监听地址（origin），无法探测路由')
  }
  const url = `${origin}${PING_PATH}`
  try {
    const anonymous = await request(fetchImpl, url, {}, timeoutMs, options.signal)
    const anonymousStatus = anonymous.status
    if (options.requireToken) {
      if (anonymousStatus !== 401) {
        await discard(anonymous)
        return fail('routeMounted', `未带 token 的 ping 返回 ${anonymousStatus}，预期 401`)
      }
      const body = await readJson(anonymous)
      if (body?.error !== 'unauthorized') {
        return fail('routeMounted', '未带 token 的 ping 不是本插件的 401 JSON（可能是网关响应）')
      }
    } else {
      await discard(anonymous)
      if (anonymousStatus !== 200) {
        return fail('routeMounted', `未要求 token 时 ping 返回 ${anonymousStatus}，预期 200`)
      }
    }

    const authenticated = await request(
      fetchImpl,
      `${url}?t=${encodeURIComponent(options.token)}`,
      {},
      timeoutMs,
      options.signal,
    )
    const authenticatedStatus = authenticated.status
    if (authenticatedStatus !== 200) {
      await discard(authenticated)
      return fail('routeMounted', `带 token 的 ping 返回 ${authenticatedStatus}，预期 200`)
    }
    const body = await readJson(authenticated)
    if (body?.ok !== true) {
      return fail('routeMounted', '带 token 的 ping 响应缺少 ok:true')
    }
    if (typeof body.requireToken === 'boolean') observed.pingRequireToken = body.requireToken
    return pass(
      'routeMounted',
      `GET ${PING_PATH}：匿名 ${anonymousStatus}，带 token 200`,
    )
  } catch (error) {
    return fail('routeMounted', errorText(error))
  }
}

function checkTokenRequired(options: SelfcheckOptions, observed: Observed): SelfcheckCheck {
  if (options.signal?.aborted === true) return cancelled('tokenRequired')
  if (observed.pingRequireToken === undefined) {
    return fail('tokenRequired', 'ping 未返回 requireToken，无法确认鉴权配置（路由探测可能失败）')
  }
  if (observed.pingRequireToken !== options.requireToken) {
    return fail(
      'tokenRequired',
      `配置 requireToken=${String(options.requireToken)}，但 ping 报告 ${String(observed.pingRequireToken)}`,
    )
  }
  return pass('tokenRequired', `requireToken=${String(options.requireToken)}（与运行中的配置一致）`)
}

async function checkMediaProbe(
  options: SelfcheckOptions,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  origin: string | undefined,
): Promise<SelfcheckCheck> {
  if (options.signal?.aborted === true) return cancelled('mediaProbe')
  if (origin === undefined) {
    return fail('mediaProbe', '缺少 Host origin，无法探测媒体路由')
  }
  const probeMedia = options.mediaProbePath ?? PROBE_MEDIA
  const url = `${origin}${MEDIA_PATH}?path=${encodeURIComponent(probeMedia)}`
    + `&t=${encodeURIComponent(options.token)}`
  try {
    const response = await request(
      fetchImpl,
      url,
      { headers: { Range: 'bytes=0-99' } },
      timeoutMs,
      options.signal,
    )
    const status = response.status
    const contentRange = response.headers.get('content-range') ?? ''
    await discard(response)
    if (status !== 206) {
      return fail(
        'mediaProbe',
        `Range 0-99 返回 ${status}，预期 206；请确认 ${probeMedia} 存在于 mediaRoot`
          + '（可用 mediaProbePath 指定其它样本）',
      )
    }
    return pass('mediaProbe', `Range 0-99 → 206${contentRange === '' ? '' : ` ${contentRange}`}`)
  } catch (error) {
    return fail('mediaProbe', errorText(error))
  }
}

function checkProjectsRootWritable(options: SelfcheckOptions): SelfcheckCheck {
  const projects = options.projects
  if (options.signal?.aborted === true) return cancelled('projectsRootWritable')
  if (projects.state === 'unset') {
    return skip('projectsRootWritable', '未配置 projectsRoot（项目功能关闭），跳过')
  }
  if (projects.state !== 'ready' || projects.root === undefined) {
    return fail(
      'projectsRootWritable',
      `projectsRoot ${projects.state}；请在插件配置里修正 projectsRoot 后重启 DSH`,
    )
  }
  const probe = path.join(projects.root, `.selfcheck-${randomBytes(6).toString('hex')}.tmp`)
  try {
    fs.writeFileSync(probe, 'ok', 'utf8')
    const readBack = fs.readFileSync(probe, 'utf8')
    fs.rmSync(probe, { force: true })
    if (readBack !== 'ok') return fail('projectsRootWritable', 'projectsRoot 写入后回读不一致')
    return pass('projectsRootWritable', 'projectsRoot 可写（写入并删除探测文件）')
  } catch (error) {
    try {
      fs.rmSync(probe, { force: true })
    } catch {
      // The write failure is the interesting one.
    }
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown'
    return fail('projectsRootWritable', `projectsRoot 不可写（${code}）`)
  }
}

async function checkProjectsRoute(
  options: SelfcheckOptions,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  origin: string | undefined,
): Promise<SelfcheckCheck> {
  const projects = options.projects
  if (options.signal?.aborted === true) return cancelled('projectsRoute')
  if (projects.state === 'unset') {
    return skip('projectsRoute', '未配置 projectsRoot（项目功能关闭），跳过')
  }
  if (projects.state !== 'ready' || projects.root === undefined) {
    return fail('projectsRoute', `projectsRoot ${projects.state}，项目路由未挂载`)
  }
  const listed = listProjects(projects.root)
  if (listed.projects.length === 0) {
    return skip('projectsRoute', 'projectsRoot 下暂无项目，跳过读取探测')
  }
  if (origin === undefined) {
    return fail('projectsRoute', '缺少 Host origin，无法探测项目路由')
  }
  const newest = listed.projects[0]
  const file = `${newest.id}/project.json`
  const url = `${origin}${PROJECTS_PATH}?path=${encodeURIComponent(file)}`
    + `&t=${encodeURIComponent(options.token)}`
  try {
    const response = await request(fetchImpl, url, {}, timeoutMs, options.signal)
    const status = response.status
    if (status !== 200) {
      await discard(response)
      return fail('projectsRoute', `读取 ${file} 返回 ${status}，预期 200`)
    }
    const body = await readJson(response)
    if (body?.id !== newest.id) {
      return fail('projectsRoute', '项目路由返回的 project.json 与目录名不一致')
    }
    return pass('projectsRoute', `读取 ${file} → 200`)
  } catch (error) {
    return fail('projectsRoute', errorText(error))
  }
}

function readOrigin(options: SelfcheckOptions): string | undefined {
  try {
    const origin = options.getOrigin()
    return typeof origin === 'string' && origin.length > 0 ? origin : undefined
  } catch {
    return undefined
  }
}

/** Render runtime installed and its CLI present (M2). */
function checkRuntimeReady(options: SelfcheckOptions): SelfcheckCheck {
  if (options.signal?.aborted === true) return cancelled('runtimeReady')
  const runtime = options.runtime
  if (runtime === undefined) return fail('runtimeReady', '未提供运行时状态')
  if (runtime.state === 'installing') return fail('runtimeReady', '渲染运行时正在安装，完成后再试')
  if (runtime.state !== 'ready' || !runtime.cliExists) {
    return fail('runtimeReady', '渲染运行时未安装（可在插件浮层点「安装运行时」或运行 scripts/install-runtime）')
  }
  return pass('runtimeReady', 'hyperframes 运行时已就绪')
}

/** A Chrome the renderer can drive (M2). */
function checkBrowserFound(options: SelfcheckOptions): SelfcheckCheck {
  if (options.signal?.aborted === true) return cancelled('browserFound')
  const browser = options.runtime?.browser
  if (browser === undefined) {
    return fail('browserFound', '未找到 Chrome：请安装 Chrome 或在配置里设置 chromePath')
  }
  return pass('browserFound', `已找到浏览器（来源：${browser.source}）`)
}

/** ffmpeg/ffprobe present inside the runtime; skipped until the runtime is ready. */
function checkFfmpegReady(options: SelfcheckOptions): SelfcheckCheck {
  if (options.signal?.aborted === true) return cancelled('ffmpegReady')
  const runtime = options.runtime
  if (runtime === undefined) return fail('ffmpegReady', '未提供运行时状态')
  if (runtime.state !== 'ready') return skip('ffmpegReady', '运行时未就绪，跳过')
  if (!runtime.ffmpegExists || !runtime.ffprobeExists) {
    return fail('ffmpegReady', '运行时里缺少 ffmpeg/ffprobe，请重新安装运行时')
  }
  return pass('ffmpegReady', 'ffmpeg / ffprobe 可执行')
}

/** Run all five checks; every check is attempted even when an earlier one fails. */
export async function runSelfcheck(options: SelfcheckOptions): Promise<SelfcheckResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const origin = readOrigin(options)
  const observed: Observed = {}

  const checks: SelfcheckCheck[] = [
    await checkRouteMounted(options, fetchImpl, timeoutMs, origin, observed),
    checkTokenRequired(options, observed),
    await checkMediaProbe(options, fetchImpl, timeoutMs, origin),
    checkProjectsRootWritable(options),
    await checkProjectsRoute(options, fetchImpl, timeoutMs, origin),
    checkRuntimeReady(options),
    checkBrowserFound(options),
    checkFfmpegReady(options),
  ]

  return { ok: checks.every((check) => check.ok), checks }
}
