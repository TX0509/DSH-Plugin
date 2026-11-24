/*!
 * dsh-stock-images — client half.
 *
 * Renders the bundle's configuration card on its page in Plugins. The card
 * writes the three API keys into the DSH credential store through the Host
 * `remote.credentials` namespace; no secret ever becomes plugin configuration,
 * and no launched fetch happens here.
 *
 * Registration: `plugins.bundle.config` keyed by the package name. The page
 * draws its own title and crumb, so the card keeps only the section frame.
 */
window.__ModuleLoader__.load({
  id: 'dsh-stock-images',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState, useSyncExternalStore } = React

    const PACKAGE_NAME = 'dsh-stock-images'
    const LOCALE_NAMESPACE = 'dshStockImages'

    /** Providers that need an API key, in the order the card lists them. */
    const KEY_ROWS = [
      {
        id: 'pexels',
        name: 'Pexels',
        ref: 'PEXELS_API_KEY',
        applyUrl: 'https://www.pexels.com/api/',
        note: { zh: '即时下发；200 次/小时。发布时需展示 Pexels 链接并标注摄影师。', en: 'Issued instantly; 200 requests/hour. Credit the photographer and link to Pexels when publishing.' }
      },
      {
        id: 'pixabay',
        name: 'Pixabay',
        ref: 'PIXABAY_API_KEY',
        applyUrl: 'https://pixabay.com/api/docs/',
        note: { zh: '即时下发；100 次/分钟；默认 Key 最大返回 1280px 大图。', en: 'Issued instantly; 100 requests/minute; a default key caps images at 1280px.' }
      },
      {
        id: 'unsplash',
        name: 'Unsplash',
        ref: 'UNSPLASH_ACCESS_KEY',
        applyUrl: 'https://unsplash.com/oauth/applications',
        note: { zh: 'Demo 应用 50 次/小时；发布时需带摄影师署名与 download 回调。', en: 'Demo apps are limited to 50 requests/hour; publishing needs photographer credit and the download callback.' }
      }
    ]

    /** Providers that work without a key. */
    const KEYLESS_ROWS = [
      {
        id: 'openverse',
        name: 'Openverse',
        note: {
          zh: '免 Key；匿名 20 次/分钟、200 次/天。人物和新闻图命中率高，逐条带 CC 许可。',
          en: 'No key; anonymous limit 20/minute and 200/day. Good for people and news photos, each with a CC license.'
        }
      },
      {
        id: 'wikimedia',
        name: 'Wikimedia Commons',
        note: {
          zh: '免 Key；真人肖像首选，许可逐文件不同（CC0 / CC BY / CC BY-SA / 公有领域）。',
          en: 'No key; best for portraits of real people. The license differs per file (CC0 / CC BY / CC BY-SA / public domain).'
        }
      }
    ]

    /** UI dictionary; `zh` and `en` must carry exactly the same keys. */
    const DICT = {
      zh: {
        title: '配图素材源',
        intro: '会话里让我搜图时会调用这里的图库。填入 API Key 后对应图库立刻可用；Openverse 与 Wikimedia Commons 无需 Key，装好即可用。',
        keySources: '需要 API Key 的图库',
        keySourcesHint: 'Key 保存在 DSH 凭据库，不写入插件配置，也不会显示在会话里。',
        freeSources: '免 Key 图库',
        statusConfigured: '已配置',
        statusMissing: '未配置',
        statusLoading: '读取中',
        statusUnknown: '状态未知',
        statusNoKey: '无需 Key',
        sourceEnvironment: '来自环境变量',
        sourceStored: '已存储在凭据库',
        keyPlaceholder: '粘贴 API Key',
        save: '保存',
        saving: '保存中…',
        clear: '清除',
        clearing: '清除中…',
        applyHint: '申请 Key',
        inputLabel: '{name} API Key',
        saved: '已保存',
        cleared: '已清除',
        saveFailed: '保存失败：{message}',
        clearFailed: '清除失败：{message}',
        emptyKey: '请先粘贴 Key',
        unavailable: '当前无法访问 DSH 凭据服务，Key 输入已停用。',
        unavailableHint: '可以改用环境变量（PEXELS_API_KEY、PIXABAY_API_KEY、UNSPLASH_ACCESS_KEY），或写进 ~/.dsh/.credentials.yaml 的 refs 段。',
        usageTitle: '怎么用',
        usageBody: '在会话里直接说「帮我找三张黄仁勋的图，横版」，我会调用 stock_image_search 搜索、stock_image_download 存进工作区，再用 read_image 确认画面对不对。',
        toolsLabel: '工具',
        refresh: '刷新状态',
        refreshed: '状态已刷新',
        summary: '{configured} / {total} 个 Key 已配置，另有 2 个免 Key 图库可直接使用。',
        summaryShort: '配图素材源设置',
        invalidKeyHint: '已保存但校验失败时，搜索工具会返回具体错误。',
        licenseNote: '许可提示：Pexels、Pixabay、Unsplash 可商用；CC 图片按条目标注的许可使用并保留署名。',
        storedMasked: '已保存 {masked}'
      },
      en: {
        title: 'Image sources',
        intro: 'The image tools search these libraries. Add an API key and that library becomes available immediately; Openverse and Wikimedia Commons need no key at all.',
        keySources: 'Libraries that need an API key',
        keySourcesHint: 'Keys live in the DSH credential store — never in plugin configuration, and never shown in a conversation.',
        freeSources: 'Libraries without a key',
        statusConfigured: 'Configured',
        statusMissing: 'Not configured',
        statusLoading: 'Checking',
        statusUnknown: 'Unknown',
        statusNoKey: 'No key needed',
        sourceEnvironment: 'From the environment',
        sourceStored: 'Stored in the credential store',
        keyPlaceholder: 'Paste an API key',
        save: 'Save',
        saving: 'Saving…',
        clear: 'Clear',
        clearing: 'Clearing…',
        applyHint: 'Get a key',
        inputLabel: '{name} API key',
        saved: 'Saved',
        cleared: 'Cleared',
        saveFailed: 'Could not save: {message}',
        clearFailed: 'Could not clear: {message}',
        emptyKey: 'Paste a key first',
        unavailable: 'The DSH credential service is not reachable, so key editing is disabled.',
        unavailableHint: 'Set PEXELS_API_KEY, PIXABAY_API_KEY and UNSPLASH_ACCESS_KEY as environment variables, or add them under refs in ~/.dsh/.credentials.yaml.',
        usageTitle: 'How to use it',
        usageBody: 'Ask in a conversation, for example “find three landscape photos of Jensen Huang”; the agent calls stock_image_search, saves the chosen one with stock_image_download, then checks it with read_image.',
        toolsLabel: 'Tools',
        refresh: 'Refresh status',
        refreshed: 'Status refreshed',
        summary: '{configured} of {total} keys configured, plus 2 key-free libraries ready to use.',
        summaryShort: 'Image sources settings',
        invalidKeyHint: 'If a saved key is rejected, the search tool reports the exact provider error.',
        licenseNote: 'Licensing: Pexels, Pixabay and Unsplash allow commercial use; CC images follow the license shown per result and keep their attribution.',
        storedMasked: 'Saved {masked}'
      }
    }

    const CSS = `
.dsi-wrap { display: flex; flex-direction: column; gap: 16px; padding: 4px 0 8px; min-width: 0; }
.dsi-head { display: flex; flex-direction: column; gap: 4px; }
.dsi-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsi-desc { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dsi-section { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dsi-section-title { margin: 0; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dsi-section-hint { margin: 0; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dsi-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); min-width: 0; }
.dsi-row-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; width: 100%; min-width: 0; }
.dsi-name { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsi-link { font-size: 11px; color: var(--dsw-alias-state-business-primary); text-decoration: none; }
.dsi-link:hover { text-decoration: underline; }
.dsi-pill { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px; corner-shape: round; border: 1px solid var(--dsw-alias-border-l2); font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); white-space: nowrap; }
.dsi-pill-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.dsi-pill-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.dsi-pill-free { color: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-state-business-primary); }
.dsi-note { width: 100%; margin: 0; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dsi-form { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; width: 100%; min-width: 0; }
.dsi-label { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.dsi-input { flex: 1 1 160px; min-width: 0; height: 28px; padding: 0 8px; font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; }
.dsi-input::placeholder { color: var(--dsw-alias-label-tertiary); }
.dsi-input:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.dsi-btn { height: 28px; padding: 0 10px; font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; cursor: pointer; }
.dsi-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsi-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.dsi-btn:disabled { opacity: 0.5; cursor: default; }
.dsi-btn-strong { color: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-state-business-primary); }
.dsi-feedback { width: 100%; margin: 0; font-size: 11px; line-height: 1.5; }
.dsi-feedback-ok { color: var(--dsw-alias-state-success-primary); }
.dsi-feedback-error { color: var(--dsw-alias-state-error-primary); }
.dsi-notice { margin: 0; padding: 8px 10px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; }
.dsi-usage { display: flex; flex-direction: column; gap: 4px; }
.dsi-usage-body { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dsi-tools { margin: 0; font-size: 11px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.dsi-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
`

    /* --------------------------------------------------------------------- *
     * Language
     * --------------------------------------------------------------------- */

    let currentLang = 'zh'
    const langListeners = new Set()

    function normalizeLang(value) {
      const text = typeof value === 'string' ? value.toLowerCase() : ''
      if (text.startsWith('zh')) return 'zh'
      return text === '' ? '' : 'en'
    }

    function publishLang(next) {
      const normalized = normalizeLang(next)
      if (normalized === '' || normalized === currentLang) return
      currentLang = normalized
      for (const listener of langListeners) listener()
    }

    function detectLang() {
      try {
        return normalizeLang(document.documentElement.getAttribute('lang')) || normalizeLang(navigator.language) || 'en'
      } catch {
        return 'en'
      }
    }

    function subscribeLang(listener) {
      langListeners.add(listener)
      return function unsubscribe() {
        langListeners.delete(listener)
      }
    }

    function getLangSnapshot() {
      return currentLang
    }

    function useLang() {
      return useSyncExternalStore(subscribeLang, getLangSnapshot, function getServerSnapshot() {
        return 'en'
      })
    }

    /** Translate one key for the given language. */
    function translate(lang, key, values) {
      const dictionary = DICT[lang] ?? DICT.en
      const template = dictionary[key] ?? DICT.en[key] ?? key
      if (values === undefined) return template
      return template.replace(/\{(\w+)\}/g, function replace(match, name) {
        const value = values[name]
        return value === undefined ? match : String(value)
      })
    }

    /* --------------------------------------------------------------------- *
     * Credentials remote
     * --------------------------------------------------------------------- */

    /** Resolve the credential Remote, tolerating both the current and legacy shape. */
    function createCredentialsAccess(ctx) {
      function getRemote() {
        try {
          const modern = ctx.get('remote.credentials')
          if (modern !== undefined && modern !== null && typeof modern.describe === 'function' && typeof modern.set === 'function') {
            return modern
          }
        } catch {
          /* fall through */
        }
        try {
          const legacy = ctx.get('connection')?.api?.credentials
          if (legacy !== undefined && typeof legacy.describe === 'function' && typeof legacy.set === 'function') {
            return {
              async describe(refs) {
                const response = await legacy.describe({ refs })
                return response?.result?.ok
                  ? { ok: true, value: response.result.value?.credentials ?? {} }
                  : { ok: false, error: { message: 'credentials service refused the read' } }
              },
              async set(ref, value) {
                const response = await legacy.set({ ref, value })
                return response?.result?.ok ? { ok: true } : { ok: false, error: response?.result?.error }
              },
              async unset(ref) {
                if (typeof legacy.unset !== 'function') return { ok: false, error: { message: 'unset is unavailable' } }
                const response = await legacy.unset({ ref })
                return response?.result?.ok ? { ok: true } : { ok: false, error: response?.result?.error }
              }
            }
          }
        } catch {
          /* fall through */
        }
        return undefined
      }

      function messageOf(error) {
        if (error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message !== '') {
          return error.message
        }
        return 'unknown error'
      }

      return {
        available() {
          return getRemote() !== undefined
        },
        async describe(refs) {
          const remote = getRemote()
          if (remote === undefined) return { ok: false, value: {} }
          try {
            const response = await remote.describe(refs)
            if (response?.ok === false) return { ok: false, value: {} }
            const value = response?.value
            return { ok: true, value: value !== null && typeof value === 'object' ? value : {} }
          } catch (error) {
            return { ok: false, value: {}, error: { message: messageOf(error) } }
          }
        },
        async set(ref, value) {
          const remote = getRemote()
          if (remote === undefined) return { ok: false, error: { message: 'credentials service unavailable' } }
          try {
            const response = await remote.set(ref, value)
            return response?.ok === false
              ? { ok: false, error: { message: messageOf(response.error) } }
              : { ok: true }
          } catch (error) {
            return { ok: false, error: { message: messageOf(error) } }
          }
        },
        async unset(ref) {
          const remote = getRemote()
          if (remote === undefined || typeof remote.unset !== 'function') {
            return { ok: false, error: { message: 'clearing is unavailable' } }
          }
          try {
            const response = await remote.unset(ref)
            return response?.ok === false
              ? { ok: false, error: { message: messageOf(response.error) } }
              : { ok: true }
          } catch (error) {
            return { ok: false, error: { message: messageOf(error) } }
          }
        }
      }
    }

    /** Small status pill. */
    function Pill(props) {
      return h('span', { className: `dsi-pill ${props.tone === undefined ? '' : props.tone}` }, props.children)
    }

    /* --------------------------------------------------------------------- *
     * Components
     * --------------------------------------------------------------------- */

    /** One API-key row: status, secret input, save and clear. */
    function KeyRow(props) {
      const lang = useLang()
      const t = useCallback((key, values) => translate(lang, key, values), [lang])
      const { row, access, onChanged } = props
      const [state, setState] = useState({ phase: 'loading', configured: false, masked: '', source: '', writable: true })
      const [input, setInput] = useState('')
      const [busy, setBusy] = useState(null)
      const [feedback, setFeedback] = useState(null)

      const refresh = useCallback(async () => {
        const response = await access.describe([row.ref])
        const info = response.ok ? response.value?.[row.ref] : undefined
        setState({
          phase: 'ready',
          configured: info?.configured === true,
          masked: typeof info?.masked === 'string' ? info.masked : '',
          source: typeof info?.source === 'string' ? info.source : '',
          writable: info?.writable !== false
        })
      }, [access, row.ref])

      useEffect(() => {
        let active = true
        void refresh().then(function ignore() {
          if (!active) return
        })
        return function cleanup() {
          active = false
        }
      }, [refresh])

      const save = useCallback(async () => {
        const value = input.trim()
        if (value === '') {
          setFeedback({ tone: 'error', text: t('emptyKey') })
          return
        }
        setBusy('save')
        setFeedback(null)
        const response = await access.set(row.ref, value)
        setBusy(null)
        if (response.ok) {
          setInput('')
          setFeedback({ tone: 'ok', text: t('saved') })
          await refresh()
          onChanged?.()
        } else {
          setFeedback({ tone: 'error', text: t('saveFailed', { message: response.error?.message ?? 'unknown error' }) })
        }
      }, [access, input, onChanged, refresh, row.ref, t])

      const clear = useCallback(async () => {
        setBusy('clear')
        setFeedback(null)
        const response = await access.unset(row.ref)
        setBusy(null)
        if (response.ok) {
          setFeedback({ tone: 'ok', text: t('cleared') })
          await refresh()
          onChanged?.()
        } else {
          setFeedback({ tone: 'error', text: t('clearFailed', { message: response.error?.message ?? 'unknown error' }) })
        }
      }, [access, onChanged, refresh, row.ref, t])

      const status =
        state.phase === 'loading'
          ? { tone: '', label: t('statusLoading') }
          : state.configured
            ? { tone: 'dsi-pill-ok', label: t('statusConfigured') }
            : { tone: 'dsi-pill-warn', label: t('statusMissing') }

      // The credential provider reports where the value comes from with ids such
      // as `file` (stored), `env` / `project-env` / `user-env` (environment).
      const sourceHint = /env/.test(state.source)
        ? t('sourceEnvironment')
        : state.source === 'file' || state.source === 'stored'
          ? t('sourceStored')
          : ''

      const inputId = `dsi-key-${row.id}`
      const disabled = !access.available() || state.writable === false

      return h(
        'div',
        { className: 'dsi-row' },
        h(
          'div',
          { className: 'dsi-row-head' },
          h('span', { className: 'dsi-name' }, row.name),
          h(Pill, { tone: status.tone }, status.label),
          state.masked === '' ? null : h('span', { className: 'dsi-section-hint' }, state.masked),
          h(
            'a',
            { className: 'dsi-link', href: row.applyUrl, target: '_blank', rel: 'noreferrer noopener' },
            t('applyHint')
          ),
          sourceHint === '' ? null : h('span', { className: 'dsi-section-hint' }, sourceHint)
        ),
        h('p', { className: 'dsi-note' }, row.note[lang] ?? row.note.en),
        h(
          'div',
          { className: 'dsi-form' },
          h('label', { className: 'dsi-label', htmlFor: inputId }, t('inputLabel', { name: row.name })),
          h('input', {
            id: inputId,
            className: 'dsi-input',
            type: 'password',
            value: input,
            placeholder: t('keyPlaceholder'),
            autoComplete: 'off',
            spellCheck: false,
            disabled: disabled || busy !== null,
            onChange(event) {
              setInput(event.target.value)
            },
            onKeyDown(event) {
              if (event.key === 'Enter') {
                event.preventDefault()
                save()
              }
            }
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsi-btn dsi-btn-strong',
              disabled: disabled || busy !== null,
              onClick: save
            },
            busy === 'save' ? t('saving') : t('save')
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsi-btn',
              disabled: disabled || busy !== null || !state.configured,
              onClick: clear
            },
            busy === 'clear' ? t('clearing') : t('clear')
          )
        ),
        feedback === null
          ? null
          : h(
              'p',
              {
                className: `dsi-feedback ${feedback.tone === 'ok' ? 'dsi-feedback-ok' : 'dsi-feedback-error'}`,
                role: feedback.tone === 'error' ? 'alert' : 'status'
              },
              feedback.text
            )
      )
    }

    /** Read-only row for a provider that needs no key. */
    function KeylessRow(props) {
      const lang = useLang()
      const { row } = props
      return h(
        'div',
        { className: 'dsi-row' },
        h(
          'div',
          { className: 'dsi-row-head' },
          h('span', { className: 'dsi-name' }, row.name),
          h(Pill, { tone: 'dsi-pill-free' }, translate(lang, 'statusNoKey'))
        ),
        h('p', { className: 'dsi-note' }, row.note[lang] ?? row.note.en)
      )
    }

    /** The bundle's configuration card. */
    function SettingsCard(props) {
      const lang = useLang()
      const t = useCallback((key, values) => translate(lang, key, values), [lang])
      const { access } = props
      const [configuredCount, setConfiguredCount] = useState(0)

      const refreshCount = useCallback(async () => {
        const response = await access.describe(KEY_ROWS.map((row) => row.ref))
        if (!response.ok) return
        let count = 0
        for (const row of KEY_ROWS) {
          if (response.value?.[row.ref]?.configured === true) count += 1
        }
        setConfiguredCount(count)
      }, [access])

      useEffect(() => {
        refreshCount()
      }, [refreshCount])

      if (props.view === 'summary') {
        return h(
          'div',
          { className: 'dsi-summary' },
          h('span', { className: 'dsi-desc' }, t('summary', { configured: configuredCount, total: KEY_ROWS.length }))
        )
      }

      return h(
        'div',
        { className: 'dsi-wrap' },
        h(
          'div',
          { className: 'dsi-head' },
          h('h3', { className: 'dsi-title' }, t('title')),
          h('p', { className: 'dsi-desc' }, t('intro'))
        ),
        access.available()
          ? null
          : h(
              'div',
              { className: 'dsi-notice', role: 'status' },
              h('p', { style: { margin: 0 } }, t('unavailable')),
              h('p', { style: { margin: '4px 0 0' } }, t('unavailableHint'))
            ),
        h(
          'section',
          { className: 'dsi-section' },
          h('h4', { className: 'dsi-section-title' }, t('keySources')),
          h('p', { className: 'dsi-section-hint' }, t('keySourcesHint')),
          ...KEY_ROWS.map((row) => h(KeyRow, { key: row.id, row, access, onChanged: refreshCount }))
        ),
        h(
          'section',
          { className: 'dsi-section' },
          h('h4', { className: 'dsi-section-title' }, t('freeSources')),
          ...KEYLESS_ROWS.map((row) => h(KeylessRow, { key: row.id, row }))
        ),
        h(
          'section',
          { className: 'dsi-section dsi-usage' },
          h('h4', { className: 'dsi-section-title' }, t('usageTitle')),
          h('p', { className: 'dsi-usage-body' }, t('usageBody')),
          h('p', { className: 'dsi-tools' }, `${t('toolsLabel')}: stock_image_search · stock_image_download · stock_image_sources`),
          h('p', { className: 'dsi-section-hint' }, t('licenseNote')),
          h('p', { className: 'dsi-section-hint' }, t('invalidKeyHint'))
        )
      )
    }

    /* --------------------------------------------------------------------- *
     * Plugin entry
     * --------------------------------------------------------------------- */

    function apply(ctx) {
      currentLang = detectLang()
      const access = createCredentialsAccess(ctx)

      // Follow the DSH locale service when it is present.
      ctx.inject(['locale'], function withLocale(scope) {
        const locale = scope.get('locale')
        if (locale === undefined || locale === null) return function noop() {}
        let disposeDictionary
        try {
          // Hold the dictionary's disposer through ctx.effect so disabling the
          // plugin does not leave the namespace registered.
          disposeDictionary = scope.effect(
            () => locale.register(LOCALE_NAMESPACE, { zh: DICT.zh, en: DICT.en }),
            'dsh-stock-images: locale dictionary'
          )
        } catch {
          /* the dictionary is only used for the host `t` seat; the card has its own copy */
        }
        function readActive() {
          try {
            const snapshot = locale.getSnapshot?.()
            const active = snapshot?.active ?? snapshot?.locale ?? snapshot?.language
            if (typeof active === 'string') publishLang(active)
          } catch {
            /* keep the detected language */
          }
        }
        readActive()
        let unsubscribe
        try {
          if (typeof locale.subscribe === 'function') unsubscribe = locale.subscribe(readActive)
        } catch {
          unsubscribe = undefined
        }
        return function cleanupLocale() {
          if (typeof unsubscribe === 'function') unsubscribe()
          if (typeof disposeDictionary === 'function') disposeDictionary()
        }
      })

      // Fallback for a composition whose locale service does not publish changes.
      ctx.effect(function watchDocumentLanguage() {
        if (typeof MutationObserver !== 'function') return function noop() {}
        const observer = new MutationObserver(function onLangChange() {
          publishLang(detectLang())
        })
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
        return function cleanupObserver() {
          observer.disconnect()
        }
      }, 'dsh-stock-images: document language')

      // Card styles, owned by the plugin and removed on unload.
      ctx.effect(function installStyles() {
        const style = document.createElement('style')
        style.dataset.plugin = PACKAGE_NAME
        style.textContent = CSS
        document.head.appendChild(style)
        return function removeStyles() {
          style.remove()
        }
      }, 'dsh-stock-images: styles')

      // Register the configuration card on the bundle's page in Plugins.
      ctx.slots.inject('plugins.bundle.config', function registerCard() {
        return ctx.slots.register(
          {
            name: 'plugins.bundle.config',
            key: PACKAGE_NAME,
            inject: function props() {
              return { access }
            }
          },
          SettingsCard
        )
      })
    }

    return {
      apply,
      inject: ['slots'],
      __internals: {
        DICT,
        KEY_ROWS,
        KEYLESS_ROWS,
        translate,
        normalizeLang,
        detectLang,
        createCredentialsAccess,
        SettingsCard,
        KeyRow,
        KeylessRow
      }
    }
  }
})
