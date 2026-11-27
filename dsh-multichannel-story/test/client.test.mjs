/**
 * 浏览器半边（client.js）的单元测试：用假的 window / React / slots 验证
 * 模块形态、双语完整性、偏好存储、两个视图、页签与预设的键盘交互，
 * 以及三个 slot 的注册。
 *
 * 不渲染真实 DOM，也不联网——真实观感仍需在有浏览器控制的环境里看。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_FILE = join(PLUGIN_DIR, 'client.js')

// ---------------------------------------------------------------- 假环境

const storage = new Map()
const fakeElement = () => ({ dataset: {}, textContent: '', remove() {} })
const fakeDocument = () => ({ head: { appendChild() {} }, createElement: fakeElement })

/**
 * 渲染上下文：为 hook 提供「同一组件两次渲染之间保持状态」的能力。
 * 单测里直接调用组件函数（renderCtx 为 null）时，hook 退化成无状态版本。
 */
let renderCtx = null

const react = {
  // 真实 React 会把 children 放进 props；这里同步一份，函数组件才能取到 children。
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children },
    children,
  }),
  useState(initial) {
    const ctx = renderCtx
    const initialValue = () => (typeof initial === 'function' ? initial() : initial)
    if (ctx === null) return [initialValue(), () => {}]
    const index = ctx.cursor++
    ctx.slots[index] ??= { value: initialValue() }
    const slot = ctx.slots[index]
    return [slot.value, (next) => {
      slot.value = typeof next === 'function' ? next(slot.value) : next
      ctx.rerender()
    }]
  },
  useEffect(fn) {
    // 只在首次挂载时收集（等价于 deps: []）。
    if (renderCtx !== null && renderCtx.mountEffects !== null) renderCtx.mountEffects.push(fn)
  },
  useRef(value) {
    const ctx = renderCtx
    if (ctx === null) return { current: value }
    const index = ctx.cursor++
    ctx.slots[index] ??= { ref: { current: value } }
    return ctx.slots[index].ref
  },
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useId: () => (renderCtx === null ? 'test' : renderCtx.id),
}

/**
 * 挂载一个组件：首次渲染 + 运行动效。返回的 ctx 每次 setState 都会同步重渲染，
 * 这样「点一下 → 看更新后的树」在测试里成立。
 */
function mount(component, props, options = {}) {
  const ctx = {
    id: options.id ?? 'test',
    slots: [],
    cursor: 0,
    mountEffects: [],
    tree: null,
    rerender() {
      ctx.cursor = 0
      renderCtx = ctx
      try {
        ctx.tree = component(props)
      } finally {
        renderCtx = null
      }
    },
  }
  ctx.rerender()
  const effects = ctx.mountEffects
  ctx.mountEffects = null
  for (const effect of effects) {
    const cleanup = effect()
    if (typeof cleanup === 'function') ctx.cleanup = cleanup
  }
  return ctx
}

let loaded
globalThis.window = {
  __ModuleLoader__: {
    load: (spec) => {
      loaded = spec
    },
  },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => {
      storage.set(key, String(value))
    },
  },
}
globalThis.document = fakeDocument()
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })

await import(pathToFileURL(CLIENT_FILE).href)

const fakeRequire = (name) => {
  if (name === 'react') return react
  throw new Error(`unexpected require: ${name}`)
}

const module = loaded.factory(fakeRequire)
const internals = module.__internals

function fakeContext(options = {}) {
  const injections = []
  const serviceInjections = []
  const registers = []
  const effects = []
  const cleanups = []
  const started = []
  const selected = []
  return {
    injections,
    serviceInjections,
    registers,
    effects,
    cleanups,
    started,
    selected,
    ctx: {
      inject: (services, callback) => {
        serviceInjections.push(services.join(','))
        const scope = {
          locale: {
            getSnapshot: () => ({ active: options.active ?? 'zh' }),
            on: () => () => {},
            ...(options.resolveText === undefined ? {} : { resolveText: options.resolveText }),
          },
        }
        if (services.includes('betterSidebar')) {
          if (options.betterSidebar === undefined) return () => {}
          scope.betterSidebar = options.betterSidebar
        }
        callback(scope)
        return () => {}
      },
      effect: (fn, label) => {
        effects.push(label)
        const cleanup = fn()
        cleanups.push(typeof cleanup === 'function' ? cleanup : () => {})
        return typeof cleanup === 'function' ? cleanup : () => {}
      },
      slots: {
        inject: (key, callback) => {
          injections.push({ key, callback })
          return () => {}
        },
        register: (definition, component) => {
          const entry = { definition, component, disposed: false }
          registers.push(entry)
          return () => {
            entry.disposed = true
          }
        },
      },
      uiWorkspace: {
        startSession: (...args) => {
          started.push(args)
          if (options.startThrows === true) throw new Error('boom')
          if (options.startSession !== undefined) return options.startSession(...args)
          return Promise.resolve()
        },
      },
      layout: { selectPanel: (id) => selected.push(id) },
    },
  }
}

/** 遍历假 React 树：展开函数组件，收集所有元素。 */
function flatten(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  if (typeof node.type === 'function') {
    flatten(node.type(node.props), out)
    return out
  }
  out.push(node)
  for (const child of node.children ?? []) flatten(child, out)
  return out
}

const texts = (node) => flatten(node).flatMap((element) => (element.children ?? []).filter((child) => typeof child === 'string'))
const byClass = (tree, className) => flatten(tree).find((element) => element.props.className === className)
const byClassAll = (tree, className) => flatten(tree).filter((element) => element.props.className === className)
const byRole = (tree, role) => flatten(tree).filter((element) => element.props.role === role)

function renderPanel(fake) {
  const i18n = internals.createI18n(fake.ctx)
  const panel = internals.makePanel({ ctx: fake.ctx, store: internals.createStore(true), i18n })
  return panel()
}

/** 挂载「带状态」的真实 Panel：busy / 错误 / 真实 onEntryChange 都能验。 */
function mountPanel(fake, options = {}) {
  const i18n = internals.createI18n(fake.ctx)
  const store = options.store ?? internals.createStore(true)
  const Panel = internals.makePanel({ ctx: fake.ctx, store, i18n, host: options.host })
  const mounted = mount(Panel, {}, { id: options.id ?? 'test' })
  mounted.store = store
  return mounted
}

// ---------------------------------------------------------------- 模块形态与文案

test('模块以包名注册到 __ModuleLoader__，并导出 apply / inject', () => {
  assert.equal(loaded.id, 'dsh-multichannel-story')
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['slots', 'uiWorkspace'])
  // 写入草稿的是自然语言指令，不是斜杠命令：追加到已有草稿后面时斜杠会失去命令语义。
  assert.equal(typeof internals.START_PREFIX.zh, 'string')
  assert.equal(typeof internals.START_PREFIX.en, 'string')
  assert.ok(!internals.START_PREFIX.zh.trimStart().startsWith('/'), '草稿指令不能以 / 开头')
  assert.ok(!internals.START_PREFIX.en.trimStart().startsWith('/'), '草稿指令不能以 / 开头')
  assert.ok(internals.START_PREFIX.zh.includes('multichannel-story'))
  assert.ok(internals.START_PREFIX.en.includes('multichannel-story'))
})

test('每个文案叶子都有中英文，数组条目数一致', () => {
  const walk = (value, path) => {
    if (typeof value === 'string') return
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) walk(item, `${path}[${index}]`)
      return
    }
    if (value !== null && typeof value === 'object') {
      // 文案叶子是 {zh, en}；放行的键会让界面出现空白。
      if (typeof value.zh === 'string' || typeof value.en === 'string') {
        assert.ok(typeof value.zh === 'string' && value.zh !== '', `${path} 缺中文`)
        assert.ok(typeof value.en === 'string' && value.en !== '', `${path} 缺英文`)
        return
      }
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`)
    }
  }
  walk(internals.COPY, 'COPY')
  for (const preset of internals.PRESETS) walk(preset, `PRESET:${preset.id}`)
  assert.equal(internals.COPY.steps, undefined, '流程步骤已从界面移除')
  assert.equal(internals.COPY.tips, undefined, '开跑前检查已从界面移除')
  assert.equal(internals.PRESETS.length, 3)
})

test('中文文案里不留繁体，预设提示词都以技能名开头', () => {
  assert.ok(!JSON.stringify(internals.COPY).includes('環境'), '简体文案里不应出现繁体「環境」')
  for (const preset of internals.PRESETS) {
    for (const leaf of [preset.title, preset.desc, preset.tag, preset.prompt]) {
      assert.ok(typeof leaf.zh === 'string' && leaf.zh !== '', `${preset.id} 的中文缺失`)
    }
  }
  const text = (leaf) => leaf.zh
  for (const preset of internals.PRESETS) {
    const prompt = internals.promptFor(preset.id, text)
    assert.ok(prompt.startsWith(internals.START_PREFIX.zh), '写入的指令要点名技能')
    assert.ok(prompt.includes('multichannel-story'))
    // 回归：斜杠命令只在整段草稿以 / 开头时生效；startSession 会复用已有草稿的空白会话，
    // 追加进去的文本不在开头，所以写入内容必须不是斜杠命令。
    assert.ok(!prompt.startsWith('/'), '写入草稿的指令不能是斜杠命令')
  }
  assert.equal(internals.promptFor('nope', text), internals.promptFor('deck', text), '未知预设回退第一档')
})

test('非中英界面回退英文，不把中文塞给英文用户', () => {
  const { ctx } = fakeContext({ active: 'fr' })
  const i18n = internals.createI18n(ctx)
  assert.equal(i18n.text({ zh: '中文', en: 'English' }), 'English')
  assert.equal(i18n.text({ zh: '中文' }), '中文', '只有中文时仍要显示出来')
  assert.equal(i18n.text('纯字符串'), '纯字符串')
  assert.equal(i18n.text(undefined), '')
})

test('宿主提供 resolveText 时以它为准（回退链由宿主决定）', () => {
  const { ctx } = fakeContext({ resolveText: (leaf) => `resolved:${leaf.en}` })
  const i18n = internals.createI18n(ctx)
  assert.equal(i18n.text({ zh: '中文', en: 'English' }), 'resolved:English')
})

test('resolveText 返回空串或 undefined 时走本地兜底，不显示空白', () => {
  for (const empty of ['', undefined, null]) {
    const { ctx } = fakeContext({ resolveText: () => empty })
    const i18n = internals.createI18n(ctx)
    assert.equal(i18n.text({ zh: '中文', en: 'English' }), '中文', `resolveText 返回 ${String(empty)} 时应回退`)
  }
})

test('locale 是 zh-CN / zh-Hans 时仍命中 zh 文案', () => {
  for (const active of ['zh-CN', 'zh-hans']) {
    const { ctx } = fakeContext({ active })
    const i18n = internals.createI18n(ctx)
    assert.equal(i18n.text({ zh: '中文', en: 'English' }), '中文', `${active} 应命中 zh`)
  }
})

// ---------------------------------------------------------------- 偏好存储

test('偏好默认显示；写入 off 后为隐藏，重写 on 恢复', () => {
  storage.clear()
  assert.equal(internals.readPreference(), true)
  internals.writePreference(false)
  assert.equal(storage.get(internals.PREF_KEY), 'off')
  assert.equal(internals.readPreference(), false)
  internals.writePreference(true)
  assert.equal(internals.readPreference(), true)
})

test('localStorage 不可用时读取失败退回默认显示，不抛错', () => {
  const saved = globalThis.window.localStorage
  globalThis.window.localStorage = {
    getItem() {
      throw new Error('denied')
    },
    setItem() {
      throw new Error('denied')
    },
  }
  try {
    assert.equal(internals.readPreference(), true)
  } finally {
    globalThis.window.localStorage = saved
  }
})

test('store 订阅/取消订阅与去重', () => {
  const store = internals.createStore(true)
  const seen = []
  const off = store.subscribe(() => seen.push(store.get()))
  store.set(false)
  store.set(false)
  store.set(true)
  off()
  store.set(false)
  assert.deepEqual(seen, [false, true])
})

// ---------------------------------------------------------------- 开始页

test('开始页：标题、三档预设、主按钮只写「开始」', () => {
  const { ctx } = fakeContext()
  const i18n = internals.createI18n(ctx)
  const tree = internals.StartPage({
    preset: 'video',
    onPreset: () => {},
    onStart: () => {},
    error: '',
    busy: false,
    status: 'idle',
    baseId: 'test',
    i18n,
  })
  const all = texts(tree)
  for (const expected of [
    internals.COPY.title.zh,
    internals.PRESETS[1].title.zh,
  ]) {
    assert.ok(all.includes(expected), `开始页应有「${expected}」，实际：${all.join(' | ')}`)
  }
  // 回归：导语、kicker、小节标题、CTA 旁注、右侧检查/流程、提示词预览都从页面移除了。
  for (const className of ['mcs-kicker', 'mcs-cta-consequence', 'mcs-lede', 'mcs-cols', 'mcs-col-side', 'mcs-list', 'mcs-details', 'mcs-prompt-details']) {
    assert.equal(byClass(tree, className), undefined, `不应再渲染 .${className}`)
  }
  for (const removed of [
    internals.COPY.lede, internals.COPY.kicker, internals.COPY.pickHint, internals.COPY.ctaHint,
    internals.COPY.tipsTitle, internals.COPY.customHint, internals.COPY.flowSummary,
    internals.COPY.promptSummary, internals.COPY.promptLabel,
    // 按钮不再拼「开始：<档位>」，只留「开始」。
    internals.COPY.ctaPrefix,
  ]) {
    assert.equal(removed, undefined, '被移除的文案键不该残留')
  }

  const radios = byRole(tree, 'radio')
  assert.equal(radios.length, 3, '三档预设都要可点')
  assert.equal(radios.filter((radio) => radio.props['aria-checked'] === true).length, 1)
  assert.equal(byRole(tree, 'radiogroup').length, 1)
  // 读屏名只读标题，说明走 describedby；不能把整段介绍塞进按钮名。
  assert.equal(radios[1].props['aria-labelledby'], 'test-preset-video-title')
  assert.equal(radios[1].props['aria-describedby'], 'test-preset-video-desc')

  const cta = byClass(tree, 'mcs-cta')
  assert.ok(cta !== undefined, '应有一个主按钮')
  // 按钮可见文字只有「开始」：做哪一档已由上面的单选组表达，不在按钮里重复一遍说明。
  assert.deepEqual(
    (cta.children ?? []).filter((child) => typeof child === 'string'),
    [internals.COPY.start.zh],
    '主按钮只写「开始」',
  )
  // 视觉上不重复，读屏名仍要带上当前档位，免得按下去不知道会用哪一档。
  assert.equal(cta.props['aria-label'], `${internals.COPY.start.zh}：${internals.PRESETS[1].title.zh}`)
  // 主按钮不再挂旁注；无障碍名仍由预设分组承担。
  assert.equal(cta.props['aria-describedby'], undefined)
  assert.equal(byRole(tree, 'radiogroup')[0].props['aria-label'], internals.COPY.pickTitle.zh)

  // 状态播报必须是「常驻节点」：先空着在树里，成功时只改文字，读屏才播报。
  const status = byClass(tree, 'mcs-status')
  assert.ok(status !== undefined, '空闲时状态节点也应存在')
  assert.equal(status.props.role, 'status')
  assert.equal(status.props['aria-live'], 'polite')
  assert.ok(!texts(status).includes(internals.COPY.ctaDone.zh), '空闲时不该已有完成文案')
})

test('开始页只剩一列：没有右侧检查/流程，也没有提示词预览', () => {
  const { ctx } = fakeContext()
  const i18n = internals.createI18n(ctx)
  const tree = internals.StartPage({ preset: 'deck', onPreset: () => {}, onStart: () => {}, error: '', busy: false, status: 'idle', baseId: 'test', i18n })
  assert.equal(flatten(tree).filter((element) => element.type === 'details').length, 0, '页面上不再有可折叠块')
  assert.equal(byClassAll(tree, 'mcs-step').length, 0)
  assert.equal(byRole(tree, 'list').length, 0, '不再有检查项列表')
  const page = byClass(tree, 'mcs-page')
  assert.ok(!page.props.className.includes('mcs-page-wide'), '单列页面不再用宽版布局')
})

test('开始页：打开会话期间按钮禁用并显示进行中，成功后给出反馈', () => {
  const { ctx } = fakeContext()
  const i18n = internals.createI18n(ctx)
  const base = { preset: 'deck', onPreset: () => {}, onStart: () => {}, error: '', baseId: 'test', i18n }

  const busyTree = internals.StartPage({ ...base, busy: true, status: 'idle' })
  const busyCta = byClass(busyTree, 'mcs-cta')
  assert.equal(busyCta.props.disabled, true, '忙碌时要禁用，避免连点开两个会话')
  assert.ok(texts(busyTree).includes(internals.COPY.ctaBusy.zh), '忙碌时按钮文案要变')

  const doneTree = internals.StartPage({ ...base, busy: false, status: 'done' })
  const status = byClass(doneTree, 'mcs-status')
  assert.equal(status.props.role, 'status')
  assert.ok(texts(doneTree).includes(internals.COPY.ctaDone.zh))
  assert.equal(byClass(doneTree, 'mcs-cta').props.disabled, false)
})

test('开始页：出错时给出可重试的提示', () => {
  const { ctx } = fakeContext()
  const i18n = internals.createI18n(ctx)
  let retried = 0
  const tree = internals.StartPage({
    preset: 'deck',
    onPreset: () => {},
    onStart: () => {},
    error: '打开新会话失败：boom',
    onRetry: () => {
      retried += 1
    },
    busy: false,
    status: 'idle',
    baseId: 'test',
    i18n,
  })
  const error = byClass(tree, 'mcs-error')
  assert.equal(error.props.role, 'alert')
  const retry = flatten(error).find((element) => element.type === 'button')
  assert.equal((retry.children ?? [])[0], internals.COPY.retry.zh)
  assert.equal(retry.props.className, 'mcs-retry', '重试要有可点的按钮样式，不是 12px 纯文字')
  retry.props.onClick()
  assert.equal(retried, 1)
})

test('预设可切换：点击回调送出对应的 id', () => {
  const { ctx } = fakeContext()
  const i18n = internals.createI18n(ctx)
  const picked = []
  const tree = internals.StartPage({
    preset: 'deck',
    onPreset: (id) => picked.push(id),
    onStart: () => {},
    error: '',
    busy: false,
    status: 'idle',
    baseId: 'test',
    i18n,
  })
  for (const radio of byRole(tree, 'radio')) radio.props.onClick()
  assert.deepEqual(picked, ['deck', 'video', 'page'])
})

test('预设支持方向键换档（roving tabindex）', () => {
  const { ctx } = fakeContext()
  const i18n = internals.createI18n(ctx)
  const picked = []
  const tree = internals.StartPage({
    preset: 'deck',
    onPreset: (id) => picked.push(id),
    onStart: () => {},
    error: '',
    busy: false,
    status: 'idle',
    baseId: 'test',
    i18n,
  })
  const group = byRole(tree, 'radiogroup')[0]
  // 说明文字已从界面移除，分组只剩无障碍名（不再有 describedby）。
  assert.equal(group.props['aria-describedby'], undefined)
  assert.equal(group.props['aria-label'], internals.COPY.pickTitle.zh)
  group.props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })
  group.props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} })
  assert.deepEqual(picked, ['video', 'page'], '右/左方向键应在三档间循环')
})

// ---------------------------------------------------------------- 设置页

test('设置页：分组标题 + 一个开关，不再用页面大标题', () => {
  const { ctx } = fakeContext()
  const i18n = internals.createI18n(ctx)
  const store = internals.createStore(true)
  const view = internals.SettingsPage({ store, i18n, onEntryChange: () => {}, baseId: 'test' })
  const all = texts(view)
  for (const expected of [internals.COPY.settingsTitle.zh, internals.COPY.toggle.zh]) {
    assert.ok(all.includes(expected), `设置页应有「${expected}」`)
  }
  // 「入口与偏好」只是其中一个分组标题：设置以后还会多出别的分组，
  // 用 h2.mcs-section-title（15px）而不是开始页那种 30px 的页面大标题。
  assert.equal(byClass(view, 'mcs-title'), undefined, '设置页不该再用 .mcs-title 大标题')
  const heading = byClass(view, 'mcs-section-title')
  assert.ok(heading !== undefined, '设置页应有分组标题')
  assert.equal(heading.type, 'h2')
  assert.equal(heading.props.id, 'test-entry-title')
  assert.deepEqual(texts(heading), [internals.COPY.settingsTitle.zh])
  const section = byClass(view, 'mcs-section')
  assert.equal(section.props['aria-labelledby'], 'test-entry-title', '分组要用自己的标题做名字')
  // 回归：导语、开关说明、存储说明都移除了，不再渲染；开关的可访问名仍来自可见文字。
  for (const className of ['mcs-lede', 'mcs-note', 'mcs-caption']) {
    assert.equal(byClass(view, className), undefined, `设置页不应再渲染 .${className}`)
  }
  for (const removed of [internals.COPY.settingsLede, internals.COPY.toggleNote, internals.COPY.storageNote]) {
    assert.equal(removed, undefined, '被移除的文案键不该残留')
  }
  const switches = byRole(view, 'switch')
  assert.equal(switches.length, 1)
  assert.equal(switches[0].props['aria-checked'], 'true')
  assert.equal(switches[0].props['aria-labelledby'], 'test-toggle', '开关要用可见文字做名字')
  assert.equal(switches[0].props['aria-describedby'], undefined)
})

test('分组标题的字号小于页面大标题（设置页会继续加分组）', () => {
  const source = readFileSync(CLIENT_FILE, 'utf8')
  const size = (selector) => {
    const match = source.match(new RegExp(`\\${selector} \\{[^}]*font-size: ([\\d.]+)px`, 'u'))
    assert.ok(match !== null, `${selector} 应有 font-size`)
    return Number(match[1])
  }
  assert.ok(size('.mcs-section-title') <= 16, '分组标题不该用大字号')
  assert.ok(size('.mcs-section-title') < size('.mcs-title'), '分组标题要比页面大标题小一档')
  // 页面第一个元素就是分组时不留 24px 顶部间距，否则标题会掉到内容中间。
  assert.match(source, /\.mcs-page > \.mcs-section:first-child \{ margin-top: 0; \}/u)
})

test('插件详情页的配置卡片包含开关与说明', () => {
  const { ctx } = fakeContext()
  const i18n = internals.createI18n(ctx)
  const card = internals.makeConfigCard({ store: internals.createStore(true), i18n })()
  const all = texts(card)
  assert.ok(all.includes(internals.COPY.configTitle.zh))
  assert.ok(all.includes(internals.COPY.configNote.zh))
  assert.equal(byRole(card, 'switch').length, 1)
})

// ---------------------------------------------------------------- 页签与面板

test('页签：role=tablist/tab，当前页 aria-selected，方向键与 Home/End 可切换', () => {
  const items = [
    { id: 'start', label: '开始' },
    { id: 'settings', label: '设置' },
  ]
  const seen = []
  const tree = internals.Tabs({ view: 'start', onView: (id) => seen.push(id), items, label: '视图', baseId: 'test' })
  assert.equal(tree.props.role, 'tablist')
  const tabs = byRole(tree, 'tab')
  assert.equal(tabs.length, 2)
  assert.equal(tabs[0].props['aria-selected'], true)
  assert.equal(tabs[0].props.tabIndex, 0)
  assert.equal(tabs[1].props.tabIndex, -1)
  assert.equal(tabs[0].props['aria-controls'], 'test-start-panel')

  tree.props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })
  tree.props.onKeyDown({ key: 'End', preventDefault() {} })
  tree.props.onKeyDown({ key: 'Home', preventDefault() {} })
  assert.deepEqual(seen, ['settings', 'settings', 'start'])
})

test('面板：两个 tabpanel 各自带 aria-labelledby，非当前页藏起来', () => {
  const fake = fakeContext()
  const tree = renderPanel(fake)
  const panels = byRole(tree, 'tabpanel')
  assert.equal(panels.length, 2)
  assert.equal(panels[0].props.hidden, false)
  assert.equal(panels[1].props.hidden, true)
  assert.equal(panels[0].props['aria-labelledby'], 'test-start-tab')
  assert.equal(panels[1].props['aria-labelledby'], 'test-settings-tab')
})

test('主按钮写入草稿：追加而不是覆盖已有草稿', () => {
  const fake = fakeContext()
  const tree = renderPanel(fake)
  const cta = byClass(tree, 'mcs-cta')
  cta.props.onClick()
  assert.equal(fake.started.length, 1)
  const [workspaceId, options] = fake.started[0]
  assert.equal(workspaceId, undefined)
  assert.equal(options.prompt, internals.promptFor('deck', internals.createI18n(fake.ctx).text))
  assert.equal(options.whenDraftExists, 'append', '已有草稿时应追加，不能悄悄覆盖')
})

test('开新会话抛错时不把异常抛给宿主', () => {
  const fake = fakeContext({ startThrows: true })
  const tree = renderPanel(fake)
  assert.doesNotThrow(() => byClass(tree, 'mcs-cta').props.onClick())
})

test('主区面板关掉入口：写偏好并回到会话面板', () => {
  internals.writePreference(true)
  const fake = fakeContext()
  const mounted = mountPanel(fake, { host: 'main' })
  byRole(mounted.tree, 'tab')[1].props.onClick()
  const toggle = byRole(mounted.tree, 'switch')[0]
  assert.ok(toggle !== undefined, '设置页应有开关')
  toggle.props.onClick()
  assert.equal(mounted.store.get(), false)
  assert.equal(internals.readPreference(), false)
  assert.deepEqual(fake.selected, ['conversation'])
  internals.writePreference(true)
})

test('侧栏标签页里关掉入口：只写偏好，不把主区切走', () => {
  internals.writePreference(true)
  const fake = fakeContext()
  const mounted = mountPanel(fake, { host: 'tab', id: 'tab' })
  byRole(mounted.tree, 'tab')[1].props.onClick()
  byRole(mounted.tree, 'switch')[0].props.onClick()
  assert.equal(mounted.store.get(), false)
  assert.equal(internals.readPreference(), false)
  assert.deepEqual(fake.selected, [], '侧栏标签页不该替用户切换主区面板')
  internals.writePreference(true)
})

// ---------------------------------------------------------------- 注册

test('apply 注入三个必需 slot 并安装样式', () => {
  const { ctx, injections, registers, effects } = fakeContext()
  module.apply(ctx)

  assert.ok(effects.includes('dsh-multichannel-story: styles'), '样式应由 effect 安装并清理')
  assert.deepEqual(injections.map((entry) => entry.key), ['main', 'sidebar.panellist', 'plugins.bundle.config'])

  for (const injection of injections) injection.callback()
  const names = registers.map((entry) => entry.definition.name).sort()
  assert.deepEqual(names, ['main', 'plugins.bundle.config', 'sidebar.panellist'])

  const sidebar = registers.find((entry) => entry.definition.name === 'sidebar.panellist')
  assert.equal(sidebar.definition.id, 'multichannel-story')
  assert.equal(sidebar.definition.order, 7)
  assert.equal(sidebar.definition.label(), '内容工作台')
  assert.equal(typeof sidebar.component, 'function')

  assert.equal(registers.find((entry) => entry.definition.name === 'main').definition.key, 'multichannel-story')
  assert.equal(registers.find((entry) => entry.definition.name === 'plugins.bundle.config').definition.key, 'dsh-multichannel-story')
})

test('偏好为隐藏时只跳过侧栏入口', () => {
  internals.writePreference(false)
  try {
    const { ctx, injections, registers } = fakeContext()
    module.apply(ctx)
    for (const injection of injections) injection.callback()
    const names = registers.map((entry) => entry.definition.name)
    assert.ok(!names.includes('sidebar.panellist'))
    assert.ok(names.includes('main'))
    assert.ok(names.includes('plugins.bundle.config'), '入口隐藏后仍要靠配置卡片重新打开')
  } finally {
    internals.writePreference(true)
  }
})

// ---------------------------------------------------------------- 焦点 / 状态 / 双实例

test('页签方向键把焦点移到目标页签', () => {
  const focused = []
  const items = [
    { id: 'start', label: '开始' },
    { id: 'settings', label: '设置' },
  ]
  const tree = internals.Tabs({ view: 'start', onView: () => {}, items, label: '视图', baseId: 'test' })
  byRole(tree, 'tab').forEach((tab, index) => {
    tab.props.ref({ focus: () => focused.push(index) })
  })
  tree.props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })
  assert.deepEqual(focused, [1], '方向键后焦点应落在新页签上')
})

test('预设方向键把焦点移到目标单选行', () => {
  const { ctx } = fakeContext()
  const i18n = internals.createI18n(ctx)
  const tree = internals.StartPage({
    preset: 'deck',
    onPreset: () => {},
    onStart: () => {},
    error: '',
    busy: false,
    status: 'idle',
    baseId: 'test',
    i18n,
  })
  const focused = []
  // 一次 flatten 取齐元素：flatten 会重新调用函数组件，分两次取会拿到不同实例的 refs。
  const elements = flatten(tree)
  const group = elements.find((element) => element.props.role === 'radiogroup')
  const radios = elements.filter((element) => element.props.role === 'radio')
  radios.forEach((radio, index) => {
    radio.props.ref({ focus: () => focused.push(index) })
  })
  group.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} })
  assert.deepEqual(focused, [1])
})

test('better-sidebar 已装：注册标签页，并在插件卸载时注销', () => {
  const tabs = []
  const disposed = []
  const service = {
    registerTab: (descriptor) => {
      tabs.push(descriptor)
      return () => disposed.push(descriptor.id)
    },
  }
  const fake = fakeContext({ betterSidebar: service })
  module.apply(fake.ctx)
  for (const injection of fake.injections) injection.callback()

  assert.ok(fake.serviceInjections.includes('betterSidebar'), '应作为可选服务注入')
  assert.equal(tabs.length, 1)
  const tab = tabs[0]
  assert.equal(tab.id, 'dsh-multichannel-story:panel')
  assert.equal(tab.single, true)
  assert.equal(tab.order, 60)
  assert.equal(tab.title(), '内容工作台')
  assert.equal(tab.description(), internals.COPY.tabDescription.zh)
  assert.equal(typeof tab.component, 'function')
  // 主面板与标签页是两个实例：关入口时只有主面板会切走。
  const main = fake.registers.find((entry) => entry.definition.name === 'main')
  assert.notEqual(tab.component, main.component)

  const index = fake.effects.indexOf('dsh-multichannel-story: better-sidebar tab')
  assert.ok(index >= 0, '注册要挂在 effect 上，插件卸载时才会被回收')
  fake.cleanups[index]()
  assert.deepEqual(disposed, ['dsh-multichannel-story:panel'])
})

test('没装 better-sidebar 时安静跳过', () => {
  const fake = fakeContext()
  assert.doesNotThrow(() => module.apply(fake.ctx))
  assert.ok(fake.serviceInjections.includes('betterSidebar'))
  assert.equal(fake.effects.filter((label) => label.includes('better-sidebar')).length, 0)
})

test('打开期间按钮禁用并显示进行中；完成后给出状态', async () => {
  let resolveStart
  const fake = fakeContext({
    startSession: () => new Promise((resolve) => {
      resolveStart = resolve
    }),
  })
  const mounted = mountPanel(fake)
  byClass(mounted.tree, 'mcs-cta').props.onClick()

  assert.equal(byClass(mounted.tree, 'mcs-cta').props.disabled, true, '忙碌时要禁用，避免连点')
  assert.ok(texts(mounted.tree).includes(internals.COPY.ctaBusy.zh))

  resolveStart()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(byClass(mounted.tree, 'mcs-cta').props.disabled, false)
  assert.ok(texts(mounted.tree).includes(internals.COPY.ctaDone.zh), '完成后要给出状态')
})

test('打开失败：解除忙碌、给出错误与可点的重试', async () => {
  let rejectStart
  const fake = fakeContext({
    startSession: () => new Promise((_resolve, reject) => {
      rejectStart = reject
    }),
  })
  const mounted = mountPanel(fake)
  byClass(mounted.tree, 'mcs-cta').props.onClick()
  rejectStart(new Error('nope'))
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(byClass(mounted.tree, 'mcs-cta').props.disabled, false, '失败后要能再点')
  assert.match(texts(mounted.tree).join(' '), /nope/u)
  const retry = byClass(mounted.tree, 'mcs-retry')
  assert.ok(retry !== undefined)
  retry.props.onClick()
  assert.equal(fake.started.length, 2, '重试应重新发起')
})

test('主面板与侧栏标签页同时挂载时 id 不冲突', () => {
  const fake = fakeContext()
  const i18n = internals.createI18n(fake.ctx)
  const store = internals.createStore(true)
  const Main = internals.makePanel({ ctx: fake.ctx, store, i18n, host: 'main' })
  const Tab = internals.makePanel({ ctx: fake.ctx, store, i18n, host: 'tab' })
  const a = mount(Main, {}, { id: 'a' })
  const b = mount(Tab, {}, { id: 'b' })

  const idsOf = (tree) => new Set(flatten(tree).map((element) => element.props.id).filter(Boolean))
  const idsA = idsOf(a.tree)
  const idsB = idsOf(b.tree)
  assert.ok(idsA.size > 0 && idsB.size > 0)
  for (const id of idsA) assert.ok(!idsB.has(id), `双实例 id 冲突：${id}`)
  for (const [tree, ids] of [[a.tree, idsA], [b.tree, idsB]]) {
    for (const element of flatten(tree)) {
      const label = element.props['aria-labelledby']
      if (label === undefined) continue
      assert.ok(ids.has(label), `aria-labelledby 指向了不存在的 ${label}`)
    }
  }
})

test('client.js 只用主题 token，不写死颜色', () => {
  const source = readFileSync(CLIENT_FILE, 'utf8')
  assert.ok(source.includes('--dsw-alias-'), '应使用 --dsw-alias-* 主题 token')
  assert.ok(source.includes('--dsw-radius-') && source.includes('--dsw-elevation-'), '应使用宿主圆角与阴影 token')
  const literals = source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
  assert.deepEqual(literals, [], `不应出现字面色值：${literals.join(', ')}`)
})

test('桌面窗口 chrome 安全区：主区面板用 --dsh-frame-* 留出顶部/左侧空间', () => {
  const source = readFileSync(CLIENT_FILE, 'utf8')
  // macOS 的红绿灯/隐藏标题栏不占布局，入口型页面必须自己补顶部留白，
  // 否则品牌行与页签会压在 chrome 下面（DESIGN.md §2.3 / §4.3）。
  assert.ok(source.includes("html[data-platform=\"darwin\"] .mcs-host-main .mcs-topbar"), 'darwin 下主区面板要补顶部安全区')
  assert.ok(source.includes('var(--dsh-frame-top-clearance, 0px)'), '应使用框架发布的顶部 clearance 变量（带兜底）')
  assert.ok(source.includes('var(--dsh-frame-leading-clearance, 0px)'), '左上角控制区要避让 leading clearance')
  // Windows 的 frame 已经用 padding 让出标题栏高度，再补一次会多一截空白：只对 darwin 生效。
  assert.ok(!/html\[data-windows-titlebar\][^{]*\{[^}]*frame-top-clearance/u.test(source), 'Windows 不应重复补顶部留白')

  const fake = fakeContext()
  const rootOf = (host) => flatten(internals.makePanel({ ctx: fake.ctx, store: internals.createStore(true), i18n: internals.createI18n(fake.ctx), host })())
    .find((element) => typeof element.props.className === 'string' && element.props.className.startsWith('mcs-root'))
  assert.ok(rootOf('main').props.className.includes('mcs-host-main'), '主区面板要带 mcs-host-main')
  assert.ok(rootOf('tab').props.className.includes('mcs-host-tab'), '侧栏标签页不能被当成主区（不该补窗口留白）')
})

test('空闲状态节点不画装饰圆点（:empty 的伪元素也要隐藏）', () => {
  const source = readFileSync(CLIENT_FILE, 'utf8')
  // 常驻 live region 只用来播报；空闲时不该留下一个没有文字的小圆点。
  assert.match(source, /\.mcs-status:empty::before \{ display: none; \}/u)
})

test('按钮重置不能压过组件样式（回归：主按钮曾因此只剩文字）', () => {
  const source = readFileSync(CLIENT_FILE, 'utf8')
  assert.ok(source.includes(':where(button)'), '按钮重置要用 :where() 保持零优先级')
  assert.ok(!/\.mcs-root button\s*\{/u.test(source), '不能用元素选择器写按钮重置，否则 (0,1,1) 会盖掉 .mcs-cta 等单类规则')
  // 主按钮必须真有底色与反相字色，不能落回 transparent/currentColor。
  assert.match(source, /\.mcs-cta \{[^}]*background: var\(--primary\)/u)
  assert.match(source, /\.mcs-cta \{[^}]*color: var\(--on-primary\)/u)
})
