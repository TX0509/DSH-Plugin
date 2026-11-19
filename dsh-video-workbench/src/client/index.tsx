import * as React from 'react'

import type { ClientSlotContext } from '../shared/dsh'
import {
  MEDIA_PATH,
  PING_PATH,
  PROJECTS_CREATE_PATH,
  PROJECTS_LIST_PATH,
  PROJECTS_PATH,
  RENDER_PATH,
  RUNTIME_INSTALL_PATH,
  RUNTIME_PATH,
} from '../shared/routes'

import { hostUrl, installStyles, readToken } from './adapters/context'
import { registerEntry, registerOverlay } from './adapters/slots'

const h = React.createElement

const OPEN_EVENT = 'dshvw:toggle'

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
  '.dshvw-trigger{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
  '.dshvw-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.dshvw-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
  '.dshvw-backdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:calc(var(--dsh-frame-top-clearance, 0px) + 16px) 16px 16px;background:color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent);pointer-events:auto}',
  '.dshvw-card{display:flex;flex-direction:column;gap:12px;width:min(760px, calc(100vw - 32px));max-height:calc(100vh - 48px);max-height:calc(100dvh - 48px);padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv3);overflow:auto}',
  '.dshvw-head{display:flex;align-items:center;gap:8px;justify-content:space-between}',
  '.dshvw-title{margin:0;font-size:14px;font-weight:600}',
  '.dshvw-sub{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
  '.dshvw-close{height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
  '.dshvw-close:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dshvw-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
  '.dshvw-close:disabled{opacity:.5;cursor:default}',
  '.dshvw-video{display:block;width:auto;max-width:100%;max-height:min(52vh, 460px);margin:0 auto;border-radius:8px;background:var(--dsw-alias-bg-layer-3)}',
  '.dshvw-error-row{display:flex;gap:8px;align-items:flex-start}',
  '.dshvw-error{flex:1;margin:0;padding:8px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:12px}',
  '.dshvw-meta{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
  '.dshvw-diag{margin:0;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:var(--dsh-code-font, monospace);font-size:11px;white-space:pre-wrap;word-break:break-all}',
  '.dshvw-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}',
  '.dshvw-row-label{color:var(--dsw-alias-label-primary)}',
  '.dshvw-bar{position:relative;flex:1;min-width:120px;height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}',
  '.dshvw-bar-fill{height:100%;background:var(--dsw-alias-brand-primary);transition:width .3s ease}',
  '.dshvw-select{max-width:320px;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
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

function Trigger(): React.ReactElement {
  return h('button', {
    type: 'button',
    className: 'dshvw-trigger',
    title: '视频工作台',
    'aria-label': '打开视频工作台',
    onClick: () => window.dispatchEvent(new CustomEvent(OPEN_EVENT)),
  }, h('span', { 'aria-hidden': true, style: { fontSize: 13, lineHeight: 1 } }, '▶'))
}

const FOCUSABLE = 'button, [href], input, select, textarea, video, [tabindex]:not([tabindex="-1"])'

function Panel(): React.ReactElement | null {
  const [open, setOpen] = React.useState(false)
  const [runtime, setRuntime] = React.useState<RuntimeView | undefined>(undefined)
  const [projects, setProjects] = React.useState<ProjectList | undefined>(undefined)
  const [projectId, setProjectId] = React.useState('')
  const [job, setJob] = React.useState<JobView | undefined>(undefined)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [probe, setProbe] = React.useState<{ status: number; contentRange: string | null } | undefined>(undefined)
  const closeRef = React.useRef<HTMLButtonElement | null>(null)
  const cardRef = React.useRef<HTMLElement | null>(null)
  const previousFocus = React.useRef<HTMLElement | null>(null)

  // Entering the error state unmounts the focused element (video or retry
  // button); move focus back inside the dialog first so it is never lost.
  const fail = (message: string): void => {
    closeRef.current?.focus()
    setError(message)
  }

  React.useEffect(() => {
    const toggle = (): void => setOpen((value) => !value)
    window.addEventListener(OPEN_EVENT, toggle)
    return () => window.removeEventListener(OPEN_EVENT, toggle)
  }, [])

  // Remember where focus came from, move it into the dialog, and restore it
  // when the dialog closes.
  React.useEffect(() => {
    if (!open) return undefined
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusTimer = setTimeout(() => closeRef.current?.focus(), 0)
    return () => clearTimeout(focusTimer)
  }, [open])

  React.useEffect(() => {
    if (open) return undefined
    const target = previousFocus.current
    if (target && document.contains(target)) target.focus()
    return undefined
  }, [open])

  // Capture phase: native media controls consume Escape during bubbling.
  React.useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const card = cardRef.current
      if (!card) return
      const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((element) => !element.hasAttribute('disabled'))
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      const inside = card.contains(active)
      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  // Load runtime status, project list and the media probe when the panel opens.
  React.useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    setError('')
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
        if (projectList.projects.length > 0) {
          setProjectId((current) => (current === '' ? projectList.projects[0].id : current))
        }
        try {
          const head = await fetch(mediaUrl(SAMPLE_MEDIA), { headers: { Range: 'bytes=0-99' } })
          if (!cancelled) setProbe({ status: head.status, contentRange: head.headers.get('content-range') })
        } catch {
          if (!cancelled) setProbe({ status: 0, contentRange: null })
        }
      } catch (failure) {
        if (!cancelled) fail(`加载失败：${String(failure)}。请确认 DSH 已完全重启。`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  // Poll the running job once per second (M2: HTTP polling, decision A).
  React.useEffect(() => {
    if (!open || job === undefined) return undefined
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
  }, [open, job?.id, job?.status])

  const reloadProjects = async (selectId?: string): Promise<void> => {
    const list = await getJson<ProjectList>(withToken(PROJECTS_LIST_PATH))
    setProjects(list)
    if (selectId !== undefined) setProjectId(selectId)
  }

  const createDemoProject = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const created = await getJson<{ project: { id: string; title: string } }>(
        withToken(PROJECTS_CREATE_PATH),
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '示例项目' }) },
      )
      setJob(undefined)
      await reloadProjects(created.project.id)
    } catch (failure) {
      fail(`新建示例项目失败：${String(failure)}`)
    } finally {
      setBusy(false)
    }
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
      fail(`安装请求失败：${String(failure)}`)
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
      fail(`无法开始渲染：${String(failure)}`)
    }
  }

  const cancelRender = async (): Promise<void> => {
    if (job === undefined) return
    try {
      const response = await getJson<{ job: JobView }>(withToken(`${RENDER_PATH}/${job.id}`), { method: 'DELETE' })
      setJob(response.job)
    } catch (failure) {
      fail(`取消失败：${String(failure)}`)
    }
  }

  if (!open) return null

  const selected = projects?.projects.find((project) => project.id === projectId)
  const runtimeReady = runtime?.state === 'ready'
  const rendering = job !== undefined && (job.status === 'queued' || job.status === 'running')
  const finished = job !== undefined && job.status === 'succeeded' && job.output !== undefined
  const videoSrc = finished && job?.output !== undefined
    ? projectFileUrl(`${projectId}/renders/v${String(job.output.version)}.mp4`)
    : mediaUrl(SAMPLE_MEDIA)

  return h('div', {
    className: 'dshvw-backdrop',
    role: 'presentation',
    onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) setOpen(false)
    },
  }, h('section', {
    className: 'dshvw-card',
    ref: cardRef,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': '视频工作台',
  }, [
    h('header', { className: 'dshvw-head', key: 'head' }, [
      h('div', { key: 'title' }, [
        h('h2', { className: 'dshvw-title', key: 'h' }, '视频工作台'),
        h('p', { className: 'dshvw-sub', key: 'p' }, '渲染当前项目并预览成片'),
      ]),
      h('button', {
        key: 'close',
        type: 'button',
        className: 'dshvw-close',
        ref: closeRef,
        onClick: () => setOpen(false),
      }, '关闭 (Esc)'),
    ]),

    h('div', { className: 'dshvw-row', key: 'runtime' }, [
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
          className: 'dshvw-close',
          disabled: busy,
          onClick: () => { void installRuntime() },
        }, busy ? '安装中…' : '安装运行时')
        : null,
    ]),

    h('div', { className: 'dshvw-row', key: 'projects' }, [
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
                // A finished job belongs to the previous project; never show its
                // clip under another project's name.
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
        className: 'dshvw-close',
        disabled: !runtimeReady || rendering || projectId === '',
        onClick: () => { void startRender() },
      }, rendering ? '渲染中…' : '渲染'),
      rendering
        ? h('button', {
          key: 'cancel',
          type: 'button',
          className: 'dshvw-close',
          onClick: () => { void cancelRender() },
        }, '取消')
        : null,
      projects?.state === 'ready'
        ? h('button', {
          key: 'create',
          type: 'button',
          className: 'dshvw-close',
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
        h('span', { className: 'dshvw-bar-fill', style: { width: `${String(job.percent)}%`, display: 'block' } })),
      h('span', { key: 'percent' }, job.frames === undefined
        ? `${String(job.percent)}%`
        : `${String(job.percent)}%（${String(job.frames)}/${String(job.totalFrames ?? '?')} 帧）`),
      job.error === undefined
        ? null
        : h('span', { key: 'error', role: 'alert' }, `错误：${job.error}`),
    ]),

    error === '' ? null : h('div', { className: 'dshvw-error-row', key: 'error' }, [
      h('p', { className: 'dshvw-error', role: 'alert', key: 'text' }, error),
    ]),

    h('video', {
      key: `video-${videoSrc}`,
      className: 'dshvw-video',
      src: videoSrc,
      controls: true,
      preload: 'metadata',
      onError: () => fail('视频加载失败：请确认文件存在且访问令牌有效。'),
    }),

    h('div', { className: 'dshvw-meta', key: 'meta' }, [
      h('span', { key: 'source' }, finished
        ? `成片：v${String(job?.output?.version)}（${String(selected?.title ?? projectId)}）`
        : '预览：示例片 test.mp4'),
      probe === undefined
        ? null
        : h('span', { key: 'probe' }, `媒体 206 探测：${String(probe.status)}`),
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
 * `__internals` exposes the pure helpers for the bundle test; DSH ignores it.
 */
export default {
  inject: ['slots'],
  apply(ctx: ClientSlotContext) {
    // One stylesheet for both entries, removed with the plugin run.
    installStyles(ctx, CSS, 'video-workbench:styles')
    registerEntry(ctx, 'video-workbench-trigger', Trigger)
    registerOverlay(ctx, 'video-workbench-panel', Panel)
  },
  __internals: { hostUrl, readToken },
}
