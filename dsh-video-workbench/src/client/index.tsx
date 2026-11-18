import * as React from 'react'

import type { ClientSlotContext } from '../shared/dsh'

import { hostUrl, installStyles, readToken } from './adapters/context'
import { loadClientModule } from './adapters/loader'
import { registerEntry, registerOverlay } from './adapters/slots'

const h = React.createElement

const PLUGIN_ID = 'dsh-video-workbench'
const OPEN_EVENT = 'dshvw:toggle'

const mediaUrl = (name: string): string => hostUrl('api/video-workbench/media', {
  path: name,
  t: readToken(),
})

const maskToken = (href: string): string => href.replace(/([?&]t=)[^&]*/u, '$1***')

const CSS = [
  '.dshvw-trigger{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
  '.dshvw-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.dshvw-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
  '.dshvw-backdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:calc(var(--dsh-frame-top-clearance, 0px) + 16px) 16px 16px;background:color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent);pointer-events:auto}',
  '.dshvw-card{display:flex;flex-direction:column;gap:12px;width:min(760px, calc(100vw - 32px));max-height:calc(100vh - 48px);padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv3);overflow:auto}',
  '.dshvw-head{display:flex;align-items:center;gap:8px;justify-content:space-between}',
  '.dshvw-title{margin:0;font-size:14px;font-weight:600}',
  '.dshvw-sub{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
  '.dshvw-close{height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
  '.dshvw-close:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dshvw-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
  '.dshvw-video{width:100%;height:auto;border-radius:8px;background:var(--dsw-alias-bg-layer-3)}',
  '.dshvw-error-row{display:flex;gap:8px;align-items:flex-start}',
  '.dshvw-error{flex:1;margin:0;padding:8px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:12px}',
  '.dshvw-meta{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
  '.dshvw-diag{margin:0;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:var(--dsh-code-font, monospace);font-size:11px;white-space:pre-wrap;word-break:break-all}',
].join('\n')

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
  const [diag, setDiag] = React.useState('检测中…')
  const [time, setTime] = React.useState(0)
  const [duration, setDuration] = React.useState(0)
  const [error, setError] = React.useState('')
  const [attempt, setAttempt] = React.useState(0)
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

  React.useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    setDiag('检测中…')
    setError('')
    setTime(0)
    setDuration(0)
    const run = async (): Promise<void> => {
      const token = readToken()
      if (token === '') {
        if (!cancelled) {
          setDiag(JSON.stringify({ tokenPresent: false }, null, 2))
          setError('未获取到访问令牌：请完全退出并重新打开 DSH 后重试。')
        }
        return
      }
      try {
        const pingResponse = await fetch(hostUrl('api/video-workbench/ping', { t: token }))
        const ping: unknown = await pingResponse.json()
        const probe = await fetch(mediaUrl('test.mp4'), { headers: { Range: 'bytes=0-99' } })
        if (cancelled) return
        setDiag(JSON.stringify({
          origin: window.location.origin,
          baseURI: document.baseURI,
          mediaUrl: maskToken(mediaUrl('test.mp4')),
          tokenPresent: true,
          ping,
          media: {
            status: probe.status,
            contentType: probe.headers.get('content-type'),
            contentRange: probe.headers.get('content-range'),
          },
        }, null, 2))
        if (probe.status !== 206) {
          fail(`媒体请求返回 ${String(probe.status)}，请检查文件是否存在。`)
        }
      } catch (failure) {
        if (!cancelled) {
          setDiag(JSON.stringify({ tokenPresent: true, error: String(failure) }, null, 2))
          fail('请求失败：请确认文件存在且 DSH 已重启。')
        }
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [open, attempt])

  const retry = (): void => {
    closeRef.current?.focus()
    setError('')
    setAttempt((value) => value + 1)
  }

  if (!open) return null

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
        h('h2', { className: 'dshvw-title', key: 'h' }, '视频工作台 · M0'),
        h('p', { className: 'dshvw-sub', key: 'p' }, '验证 dsh-app 下的路由、鉴权与 Range 播放'),
      ]),
      h('button', {
        key: 'close',
        type: 'button',
        className: 'dshvw-close',
        ref: closeRef,
        onClick: () => setOpen(false),
      }, '关闭 (Esc)'),
    ]),
    error === '' ? null : h('div', { className: 'dshvw-error-row', key: 'error' }, [
      h('p', { className: 'dshvw-error', role: 'alert', key: 'text' }, error),
      h('button', {
        key: 'retry',
        type: 'button',
        className: 'dshvw-close',
        onClick: retry,
      }, '重试'),
    ]),
    error === '' ? h('video', {
      key: `video-${attempt}`,
      className: 'dshvw-video',
      src: mediaUrl('test.mp4'),
      controls: true,
      preload: 'metadata',
      onLoadedMetadata: (event: React.SyntheticEvent<HTMLVideoElement>) =>
        setDuration(event.currentTarget.duration || 0),
      onTimeUpdate: (event: React.SyntheticEvent<HTMLVideoElement>) =>
        setTime(event.currentTarget.currentTime || 0),
      onError: () => fail('视频加载失败：请确认文件存在且访问令牌有效。'),
    }) : null,
    h('div', { className: 'dshvw-meta', key: 'meta' }, error === ''
      ? [
        h('span', { key: 't' }, `当前 ${time.toFixed(2)}s`),
        h('span', { key: 'd' }, `时长 ${duration.toFixed(2)}s`),
      ]
      : [h('span', { key: 'unavailable' }, '媒体不可用')]),
    h('pre', { className: 'dshvw-diag', key: 'diag' }, diag),
  ]))
}

loadClientModule({
  id: PLUGIN_ID,
  factory() {
    return {
      inject: ['slots'],
      apply(ctx: ClientSlotContext) {
        // One stylesheet for both entries, removed with the plugin run.
        installStyles(ctx, CSS, 'video-workbench:styles')
        registerEntry(ctx, 'video-workbench-trigger', Trigger)
        registerOverlay(ctx, 'video-workbench-panel', Panel)
      },
    }
  },
})
