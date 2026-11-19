import * as React from 'react'

import type { ClientSlotContext } from '../shared/dsh'
import {
  MEDIA_PATH,
  PROJECTS_CREATE_PATH,
  PROJECTS_LIST_PATH,
  PROJECTS_PATH,
  RENDER_PATH,
  RUNTIME_INSTALL_PATH,
  RUNTIME_PATH,
} from '../shared/routes'

import { hostUrl, installStyles, readToken } from './adapters/context'
import { PANEL_ID, registerEntry, registerPage } from './adapters/slots'

const h = React.createElement

/** The sample clip M1 ships for the media self-check. */
const SAMPLE_MEDIA = 'test.mp4'

const mediaUrl = (name: string): string => hostUrl(MEDIA_PATH, {
  path: name,
  t: readToken(),
})

const projectFileUrl = (relative: string): string => hostUrl(PROJECTS_PATH, {
  path: relative,
  t: readToken(),
})

const maskToken = (href: string): string => href.replace(/([?&]t=)[^&]*/u, '$1***')

const withToken = (pathname: string): string => hostUrl(pathname, { t: readToken() })

const CSS = [
  '.dshvw-page{display:flex;flex-direction:column;gap:18px;box-sizing:border-box;width:100%;height:100%;padding:24px;overflow:auto;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}',
  '.dshvw-inner{display:flex;flex-direction:column;gap:18px;width:100%;max-width:880px;margin:0 auto}',
  '.dshvw-title{margin:0;font-size:16px;font-weight:600}',
  '.dshvw-sub{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
  '.dshvw-section{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
  '.dshvw-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--dsw-alias-label-secondary)}',
  '.dshvw-row-label{color:var(--dsw-alias-label-primary);font-weight:500}',
  '.dshvw-btn{height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}',
  '.dshvw-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dshvw-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
  '.dshvw-btn:disabled{opacity:.5;cursor:default}',
  '.dshvw-btn-primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-on-brand)}',
  '.dshvw-btn-primary:hover{filter:brightness(1.05);background:var(--dsw-alias-brand-primary)}',
  '.dshvw-select{max-width:100%;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
  '.dshvw-bar{position:relative;flex:1;min-width:140px;height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}',
  '.dshvw-bar-fill{display:block;height:100%;background:var(--dsw-alias-brand-primary);transition:width .3s ease}',
  '.dshvw-video{display:block;width:auto;max-width:100%;max-height:min(52vh, 460px);margin:0 auto;border-radius:10px;background:var(--dsw-alias-bg-layer-3)}',
  '.dshvw-error{margin:0;padding:10px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:12px}',
  '.dshvw-meta{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
  '.dshvw-diag{margin:0;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:var(--dsh-code-font, monospace);font-size:11px;white-space:pre-wrap;word-break:break-all}',
  '.dshvw-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
].join('\n')

interface RuntimeView {
  state: 'ready' | 'missing' | 'installing'
  versions?: Record<string, string>
  browser?: { source: string } | null
  lastError?: string
}

interface ProjectSummary {
  id: string
  title: string
  scenes: number
  durationSec?: number
}

interface ProjectList {
  state: 'ready' | 'unset' | 'invalid'
  projects: ProjectSummary[]
  invalid: Array<{ id: string; errors: string[] }>
}

interface JobView {
  id: string
  status: string
  phase: string
  percent: number
  frames?: number
  totalFrames?: number
  output?: { version: number; file: string; durationSec?: number }
  error?: string
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  return await response.json() as T
}

const PHASE_LABEL: Record<string, string> = {
  preparing: '准备中',
  capturing: '渲染帧',
  encoding: '编码',
  assembling: '合成',
  done: '完成',
}

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '渲染中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  timedOut: '超时',
}

/**
 * Sidebar glyph: a clapperboard (制作) instead of a play triangle (播放).
 * Inherits `currentColor`, so it follows light/dark themes automatically.
 */
function WorkbenchIcon({ size = 18 }: { size?: number }): React.ReactElement {
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    'aria-hidden': true,
    focusable: false,
  }, [
    h('path', {
      key: 'body',
      d: 'M6.6 9.4h10.8a1.4 1.4 0 0 1 1.4 1.4v5.6a1.4 1.4 0 0 1-1.4 1.4H6.6a1.4 1.4 0 0 1-1.4-1.4v-5.6a1.4 1.4 0 0 1 1.4-1.4Z',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinejoin: 'round',
    }),
    h('path', {
      key: 'slate',
      d: 'M5.2 9.4 17.1 6.2l.6 2.2L5.8 11.6',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinejoin: 'round',
    }),
    h('path', {
      key: 'stripes',
      d: 'm8.3 8.6.8 2.2M11.9 7.7l.8 2.2M15.5 6.7l.8 2.2',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
    }),
  ])
}

/** Sidebar panel icon: the shell passes the row's icon edge. */
function PanelIcon({ size }: { size?: number }): React.ReactElement {
  return h(WorkbenchIcon, { size: typeof size === 'number' ? size : 18 })
}

/** The workbench page shown when the sidebar entry is selected. */
function WorkbenchPage(): React.ReactElement {
  const [runtime, setRuntime] = React.useState<RuntimeView | undefined>(undefined)
  const [projects, setProjects] = React.useState<ProjectList | undefined>(undefined)
  const [projectId, setProjectId] = React.useState('')
  const [job, setJob] = React.useState<JobView | undefined>(undefined)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [probe, setProbe] = React.useState<{ status: number } | undefined>(undefined)

  // Load runtime status, the project list and the media probe when the page mounts.
  React.useEffect(() => {
    let cancelled = false
    const token = readToken()
    if (token === '') {
      setError('未获取到访问令牌：请完全退出并重新打开 DSH 后重试。')
      return undefined
    }
    void (async () => {
      try {
        const [runtimeView, projectList] = await Promise.all([
          getJson<RuntimeView>(withToken(RUNTIME_PATH)),
          getJson<ProjectList>(withToken(PROJECTS_LIST_PATH)),
        ])
        if (cancelled) return
        setRuntime(runtimeView)
        setProjects(projectList)
        if (projectList.projects.length > 0) setProjectId(projectList.projects[0].id)
        try {
          const head = await fetch(mediaUrl(SAMPLE_MEDIA), { headers: { Range: 'bytes=0-99' } })
          if (!cancelled) setProbe({ status: head.status })
        } catch {
          if (!cancelled) setProbe({ status: 0 })
        }
      } catch (failure) {
        if (!cancelled) setError(`加载失败：${String(failure)}。请确认 DSH 已完全重启。`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Poll the running job once per second (M2: HTTP polling, decision A).
  React.useEffect(() => {
    if (job === undefined) return undefined
    if (job.status !== 'queued' && job.status !== 'running') return undefined
    let cancelled = false
    const timer = setInterval(() => {
      void (async () => {
        try {
          const next = await getJson<{ job: JobView }>(withToken(`${RENDER_PATH}/${job.id}`))
          if (!cancelled) setJob(next.job)
        } catch {
          // A single failed poll is not fatal; the next tick retries.
        }
      })()
    }, 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [job?.id, job?.status])

  const reloadProjects = async (selectId?: string): Promise<void> => {
    const list = await getJson<ProjectList>(withToken(PROJECTS_LIST_PATH))
    setProjects(list)
    if (selectId !== undefined) setProjectId(selectId)
  }

  const installRuntime = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const started = await getJson<RuntimeView>(withToken(RUNTIME_INSTALL_PATH), { method: 'POST' })
      setRuntime(started)
      const poll = setInterval(() => {
        void (async () => {
          try {
            const next = await getJson<RuntimeView>(withToken(RUNTIME_PATH))
            setRuntime(next)
            if (next.state !== 'installing') {
              clearInterval(poll)
              setBusy(false)
            }
          } catch {
            // Keep polling until the plugin answers again.
          }
        })()
      }, 2000)
    } catch (failure) {
      setBusy(false)
      setError(`安装请求失败：${String(failure)}`)
    }
  }

  const createDemoProject = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const created = await getJson<{ project: { id: string } }>(withToken(PROJECTS_CREATE_PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '示例项目' }),
      })
      setJob(undefined)
      await reloadProjects(created.project.id)
    } catch (failure) {
      setError(`新建示例项目失败：${String(failure)}`)
    } finally {
      setBusy(false)
    }
  }

  const startRender = async (): Promise<void> => {
    setError('')
    setJob(undefined)
    try {
      const started = await getJson<{ job: JobView }>(withToken(RENDER_PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId }),
      })
      setJob(started.job)
    } catch (failure) {
      setError(`无法开始渲染：${String(failure)}`)
    }
  }

  const cancelRender = async (): Promise<void> => {
    if (job === undefined) return
    try {
      const response = await getJson<{ job: JobView }>(withToken(`${RENDER_PATH}/${job.id}`), { method: 'DELETE' })
      setJob(response.job)
    } catch (failure) {
      setError(`取消失败：${String(failure)}`)
    }
  }

  const selected = projects?.projects.find((project) => project.id === projectId)
  const runtimeReady = runtime?.state === 'ready'
  const rendering = job !== undefined && (job.status === 'queued' || job.status === 'running')
  const finished = job !== undefined && job.status === 'succeeded' && job.output !== undefined
  const videoSrc = finished && job?.output !== undefined
    ? projectFileUrl(`${projectId}/renders/v${String(job.output.version)}.mp4`)
    : mediaUrl(SAMPLE_MEDIA)

  return h('div', { className: 'dshvw-page', role: 'region', 'aria-label': '视频工作台' },
    h('div', { className: 'dshvw-inner' }, [
      h('div', { key: 'head' }, [
        h('h2', { className: 'dshvw-title', key: 'h' }, '视频工作台'),
        h('p', { className: 'dshvw-sub', key: 'p' }, '渲染当前项目并预览成片'),
      ]),

      h('section', { className: 'dshvw-section', key: 'runtime' }, [
        h('div', { className: 'dshvw-row', key: 'row' }, [
          h('span', { key: 'label', className: 'dshvw-row-label' }, '渲染运行时'),
          h('span', { key: 'state' }, runtime === undefined
            ? '检测中…'
            : runtime.state === 'ready'
              ? `已就绪（hyperframes ${runtime.versions?.hyperframes ?? '?'}）`
              : runtime.state === 'installing'
                ? '正在安装…（首次约 2–10 分钟）'
                : `未安装${runtime.lastError === undefined ? '' : `（${runtime.lastError}）`}`),
          runtime?.browser == null ? null : h('span', { key: 'browser' }, `浏览器：${runtime.browser.source}`),
          runtime?.state === 'missing'
            ? h('button', {
              key: 'install',
              type: 'button',
              className: 'dshvw-btn',
              disabled: busy,
              onClick: () => { void installRuntime() },
            }, busy ? '安装中…' : '安装运行时')
            : null,
        ]),
      ]),

      h('section', { className: 'dshvw-section', key: 'projects' }, [
        h('div', { className: 'dshvw-row', key: 'row' }, [
          h('span', { key: 'label', className: 'dshvw-row-label' }, '项目'),
          projects === undefined
            ? h('span', { key: 'loading' }, '加载中…')
            : projects.state !== 'ready'
              ? h('span', { key: 'unset' }, '项目功能未启用（未配置 projectsRoot）')
              : projects.projects.length === 0
                ? h('span', { key: 'empty' }, '暂无项目，先新建一个')
                : h('select', {
                  key: 'select',
                  className: 'dshvw-select',
                  value: projectId,
                  onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
                    setProjectId(event.target.value)
                    // A finished job belongs to the previous project.
                    setJob(undefined)
                    setError('')
                  },
                }, projects.projects.map((project) => h('option', { key: project.id, value: project.id },
                  `${project.title}（${String(project.scenes)} 分镜${
                    typeof project.durationSec === 'number' ? ` · ${String(Number(project.durationSec.toFixed(2)))}s` : ''
                  }）`))),
          h('button', {
            key: 'render',
            type: 'button',
            className: 'dshvw-btn dshvw-btn-primary',
            disabled: !runtimeReady || rendering || projectId === '',
            onClick: () => { void startRender() },
          }, rendering ? '渲染中…' : '渲染'),
          rendering
            ? h('button', {
              key: 'cancel',
              type: 'button',
              className: 'dshvw-btn',
              onClick: () => { void cancelRender() },
            }, '取消')
            : null,
          projects?.state === 'ready'
            ? h('button', {
              key: 'create',
              type: 'button',
              className: 'dshvw-btn',
              disabled: busy || rendering,
              onClick: () => { void createDemoProject() },
              title: '创建 2 个分镜、合计 10 秒的示例项目',
            }, '新建 10 秒示例')
            : null,
        ]),
        job === undefined ? null : h('div', { className: 'dshvw-row', key: 'progress' }, [
          h('span', { key: 'status', className: 'dshvw-row-label' },
            `${STATUS_LABEL[job.status] ?? job.status}${job.phase === 'queued' ? '' : ` · ${PHASE_LABEL[job.phase] ?? job.phase}`}`),
          h('span', { key: 'bar', className: 'dshvw-bar' },
            h('span', { className: 'dshvw-bar-fill', style: { width: `${String(job.percent)}%` } })),
          h('span', { key: 'percent' }, job.frames === undefined
            ? `${String(job.percent)}%`
            : `${String(job.percent)}%（${String(job.frames)}/${String(job.totalFrames ?? '?')} 帧）`),
          job.error === undefined
            ? null
            : h('span', { key: 'error', role: 'alert' }, `错误：${job.error}`),
        ]),
      ]),

      error === ''
        ? null
        : h('p', { key: 'error', className: 'dshvw-error', role: 'alert' }, error),

      h('section', { className: 'dshvw-section', key: 'preview' }, [
        finished
          ? null
          : h('p', { className: 'dshvw-hint', key: 'hint' }, '尚未渲染：下面是示例片 test.mp4；渲染完成后这里会播放成片。'),
        h('video', {
          key: `video-${videoSrc}`,
          className: 'dshvw-video',
          src: videoSrc,
          controls: true,
          preload: 'metadata',
          onError: () => setError('视频加载失败：请确认文件存在且访问令牌有效。'),
        }),
        h('div', { className: 'dshvw-meta', key: 'meta' }, [
          h('span', { key: 'source' }, finished
            ? `成片：v${String(job?.output?.version)}（${String(selected?.title ?? projectId)}）`
            : '预览：示例片 test.mp4'),
          probe === undefined
            ? null
            : h('span', { key: 'probe' }, `媒体 206 探测：${String(probe.status)}`),
        ]),
      ]),

      h('pre', { className: 'dshvw-diag', key: 'diag' }, JSON.stringify({
        mediaUrl: maskToken(mediaUrl(SAMPLE_MEDIA)),
        runtime: runtime?.state ?? 'unknown',
        projects: projects?.projects.length ?? 0,
        job: job === undefined ? null : { id: job.id, status: job.status, percent: job.percent },
      }, null, 2)),
    ]))
}

/**
 * The plugin module DSH loads.
 *
 * `scripts/build.mjs` wraps this bundle in the DSH lazy-CJS loader call and its
 * factory returns this default export, so the module is registered exactly once
 * and `apply` is what DSH calls. Never call the loader from this file again:
 * a second registration for the same id was the key defect behind the v0.1.0
 * client data-corruption incident.
 *
 * The workbench is a **main panel** reached from the sidebar panel list (like
 * the Plugins page), not a composer button or a floating overlay: the shell
 * owns the row, its label, the selection state and the panel switch.
 */
export default {
  inject: ['slots'],
  apply(ctx: ClientSlotContext) {
    installStyles(ctx, CSS, 'video-workbench:styles')
    registerEntry(ctx, PANEL_ID, { label: () => '视频工作台' }, PanelIcon)
    registerPage(ctx, PANEL_ID, WorkbenchPage)
  },
  __internals: { hostUrl, readToken, PANEL_ID },
}
