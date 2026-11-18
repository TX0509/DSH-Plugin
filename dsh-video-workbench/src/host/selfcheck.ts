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

export interface SelfcheckCheck {
  name: SelfcheckName
  ok: boolean
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

function errorText(error: unknown): string {
  if (error instanceof ProbeError) return error.message
  return error instanceof Error ? error.message : String(error)
}

async function request(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } catch (error) {
    throw new ProbeError(`请求失败：${errorText(error)}`)
  } finally {
    clearTimeout(timer)
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
  if (origin === undefined) {
    return fail('routeMounted', 'Host 尚未提供监听地址（origin），无法探测路由')
  }
  const url = `${origin}${PING_PATH}`
  try {
    const anonymous = await request(fetchImpl, url, {}, timeoutMs)
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
  if (origin === undefined) {
    return fail('mediaProbe', '缺少 Host origin，无法探测媒体路由')
  }
  const url = `${origin}${MEDIA_PATH}?path=${encodeURIComponent(PROBE_MEDIA)}`
    + `&t=${encodeURIComponent(options.token)}`
  try {
    const response = await request(fetchImpl, url, { headers: { Range: 'bytes=0-99' } }, timeoutMs)
    const status = response.status
    const contentRange = response.headers.get('content-range') ?? ''
    await discard(response)
    if (status !== 206) {
      return fail(
        'mediaProbe',
        `Range 0-99 返回 ${status}，预期 206；请确认 ${PROBE_MEDIA} 存在于 mediaRoot`,
      )
    }
    return pass('mediaProbe', `Range 0-99 → 206${contentRange === '' ? '' : ` ${contentRange}`}`)
  } catch (error) {
    return fail('mediaProbe', errorText(error))
  }
}

function checkProjectsRootWritable(options: SelfcheckOptions): SelfcheckCheck {
  const projects = options.projects
  if (projects.state !== 'ready' || projects.root === undefined) {
    return fail(
      'projectsRootWritable',
      `projectsRoot ${projects.state}；请在插件配置里设置 projectsRoot 后重启 DSH`,
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
  if (projects.state !== 'ready' || projects.root === undefined) {
    return fail('projectsRoute', `projectsRoot ${projects.state}，项目路由未挂载`)
  }
  const listed = listProjects(projects.root)
  if (listed.projects.length === 0) {
    return pass('projectsRoute', 'projectsRoot 下暂无项目，跳过读取探测')
  }
  if (origin === undefined) {
    return fail('projectsRoute', '缺少 Host origin，无法探测项目路由')
  }
  const newest = listed.projects[0]
  const file = `${newest.id}/project.json`
  const url = `${origin}${PROJECTS_PATH}?path=${encodeURIComponent(file)}`
    + `&t=${encodeURIComponent(options.token)}`
  try {
    const response = await request(fetchImpl, url, {}, timeoutMs)
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
  ]

  return { ok: checks.every((check) => check.ok), checks }
}
