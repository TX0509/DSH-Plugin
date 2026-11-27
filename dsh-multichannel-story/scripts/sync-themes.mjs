#!/usr/bin/env node
/**
 * 把「歸藏设计」插件的 themes.json 同步进本插件。
 *
 * 生成三处（都在 `mcs:themes` 标记之间，标记外的内容一个字都不动）：
 *   1. client.js 的 STYLES 表（风格名、配色名、纸色 / 强调色、该风格的默认主题）
 *   2. assets/multichannel-story/SKILL.md 第 1 步的选项清单
 *   3. assets/multichannel-story/references/page.md 的主题表与兜底说明
 * 写完再跑一次 `sync-assets.mjs --manifest-only`，让 MANIFEST 跟上。
 *
 * 用法：
 *   node scripts/sync-themes.mjs                 自动找已安装的 dsh-guizang-design 并写入
 *   node scripts/sync-themes.mjs --check         只比对，有漂移就以 1 退出（可挂 CI / 发版前）
 *   node scripts/sync-themes.mjs --source <dir>  指定 dsh-guizang-design 目录（GZ_ROOT 亦可）
 *   node scripts/sync-themes.mjs --package <dir> 指定本插件目录（默认脚本所在包）
 *
 * 为什么不运行期自动跟随：主题只影响选择器显示的名字与色卡，真正渲染永远读上游
 * themes.json；运行期再拉一次只会多一条跨插件路径依赖和异步失败态。发版前跑一次
 * `--check` 就足够，漂移也会被 test/sync-themes.test.mjs 的生成器用例挡住。
 */
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** 渲染器（render.mjs）与 mcs 只支持这两种骨架；上游新增第三种时这里会给出提示。 */
const KNOWN_STYLES = ['magazine', 'swiss']

/** 骨架本身的说明（themes.json 只有 id 和配色，没有这些文案）。 */
const STYLE_META = {
  magazine: {
    name: { zh: '杂志风', en: 'Magazine' },
    hint: { zh: '衬线标题、纸色底、交叉线纹理', en: 'Serif headings, paper ground, hairline texture' },
  },
  swiss: {
    name: { zh: '瑞士风', en: 'Swiss' },
    hint: { zh: '无衬线细体、冷灰底、直角与网格', en: 'Thin sans, cool grey ground, square corners, grid' },
  },
}

/**
 * 每套主题「适合什么内容」——这是本插件自己的判断，themes.json 里没有。
 * 上游新增主题时这里先留空（生成成「—」并提示补一句），不要拿机器话糊上去。
 */
const THEME_NOTES = {
  'magazine/ink-classic': '通用分享、商业发布（page skill 自身默认）',
  'magazine/indigo-porcelain': '科技/研究/数据、工程师文化',
  'magazine/forest-ink': '自然/可持续/文化/非虚构',
  'magazine/kraft-paper': '怀旧/人文/历史/独立杂志',
  'magazine/dune': '艺术/设计/时尚/画廊手册',
  'magazine/midnight-ink': '深色主题：夜读、电影感、大片照片',
  'swiss/ikb': '通用、AI/科技产品、设计领域',
  'swiss/lemon': '年轻/运动/零售/Y2K',
  'swiss/lemon-green': '生态/健康/Z 世代品牌',
  'swiss/safety-orange': '工业/警示/汽车/发布会重点页',
}

const TARGETS = {
  client: join('client.js'),
  skill: join('assets', 'multichannel-story', 'SKILL.md'),
  page: join('assets', 'multichannel-story', 'references', 'page.md'),
}

const BEGIN = 'mcs:themes:begin'
const END = 'mcs:themes:end'

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2)
const flags = new Set()
const values = new Map()
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--check' || arg === '--require-source' || arg === '--help') {
    flags.add(arg)
  } else if (arg === '--source' || arg === '--package') {
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) fatal(`${arg} 缺目录参数`)
    values.set(arg, next)
    i += 1
  } else {
    fatal(`未知参数：${arg}`)
  }
}
if (flags.has('--help')) {
  process.stdout.write('用法：node scripts/sync-themes.mjs [--check] [--require-source] [--source <dsh-guizang-design 目录>] [--package <本插件目录>]\n'
    + '  --check           只比对，不写文件；有漂移以 1 退出\n'
    + '  --require-source  没找到已安装的上游时按失败退出（默认在 --check 下只提示并跳过）\n'
    + '  --source          默认取 $GZ_ROOT 或 $DSH_HOME/profiles/{desktop,web,...}/node_modules/dsh-guizang-design\n'
    + '  --package         默认是脚本所在的插件包\n')
  process.exit(0)
}

/** 参数/输入错误：写清原因并以 2 退出（和 mcs 的约定一致）。 */
function fatal(message) {
  process.stderr.write(`sync-themes：${message}\n`)
  process.exit(2)
}

const packageDir = resolve(values.get('--package') ?? PACKAGE_DIR)

// ---------------------------------------------------------------- 定位上游

/** 与 mcs.mjs 一致：`DSH_HOME` 优先，否则用 node:os 的 homedir()（Windows 上没有 HOME）。 */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

const THEMES_REL = join('skills', 'guizang-page-skill', 'assets', 'themes.json')

/** profile 的查找顺序：先 desktop / web（最常用），再其余按名字排，保证同一台机器上结果稳定。 */
const PROFILE_PRIORITY = ['desktop', 'web', 'open-design', 'acp']

function profileOrder(name) {
  const index = PROFILE_PRIORITY.indexOf(name)
  return index === -1 ? PROFILE_PRIORITY.length : index
}

/** 列出探测过的位置，报错时能直接看出该往哪指（不要伪造一个 cwd 路径）。 */
function describeSearched() {
  const lines = [`  $GZ_ROOT：${process.env.GZ_ROOT ?? '(未设置)'}`]
  const profiles = join(dshHome(), 'profiles')
  lines.push(`  ${profiles}/<profile>/node_modules/dsh-guizang-design（顺序：${PROFILE_PRIORITY.join(' → ')}）`)
  return `${lines.join('\n')}\n`
}

/** 找到就返回 { dir, label }：label 用来说明是 GZ_ROOT、某个 profile 还是 --source。 */
function findInstalledGuizang() {
  const explicit = process.env.GZ_ROOT
  if (explicit !== undefined && explicit !== '' && existsSync(join(explicit, THEMES_REL))) {
    return { dir: resolve(explicit), label: 'GZ_ROOT' }
  }
  const profiles = join(dshHome(), 'profiles')
  if (!existsSync(profiles)) return undefined
  let entries = []
  try {
    entries = readdirSync(profiles, { withFileTypes: true })
  } catch {
    return undefined
  }
  // profile 目录可能是符号链接（换机器 / 迁移后常见），mcs 也接受，这里保持一致。
  const dirs = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort((a, b) => profileOrder(a) - profileOrder(b) || a.localeCompare(b))
  for (const name of dirs) {
    const candidate = join(profiles, name, 'node_modules', 'dsh-guizang-design')
    if (existsSync(join(candidate, THEMES_REL))) {
      return { dir: resolve(candidate), label: `profile ${name}` }
    }
  }
  return undefined
}

const explicitSource = values.get('--source')
const source = explicitSource === undefined
  ? findInstalledGuizang()
  : { dir: resolve(explicitSource), label: '--source' }

if (source === undefined) {
  const detail = `没有找到已安装的 dsh-guizang-design。\n${describeSearched()}  用 --source / GZ_ROOT 指一下插件目录。\n`
  // --check 的常见用法是挂在 CI / 发版前：没装上游不算漂移，默认放行并说清楚；
  // 想强制要求装好再检查就加 --require-source。
  if (flags.has('--check') && !flags.has('--require-source')) {
    process.stdout.write(`跳过：${detail}`)
    process.exit(0)
  }
  fatal(detail.trimEnd())
}

const sourceDir = source.dir
const themesFile = join(sourceDir, THEMES_REL)

/** 上游插件版本（有就带上）：多 profile 装不同版本时，摘要能说清用的是哪一份。 */
function sourceVersion(dir) {
  try {
    const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
    return typeof version === 'string' && version !== '' ? `v${version}` : ''
  } catch {
    return ''
  }
}
if (!existsSync(themesFile)) {
  fatal(`找不到 ${themesFile}（来源：${source.label}）\n  确认 ${sourceDir} 是 dsh-guizang-design 的插件目录`)
}

let themes
try {
  themes = JSON.parse(readFileSync(themesFile, 'utf8'))
} catch (cause) {
  fatal(`${themesFile} 不是合法 JSON：${cause.message}`)
}

// ---------------------------------------------------------------- 校验上游

const families = Object.keys(themes).filter((key) => key !== '$comment')
if (families.length === 0) fatal(`${themesFile} 里没有任何风格`)

const warnings = []
const catalog = []
for (const family of families) {
  if (!KNOWN_STYLES.includes(family)) {
    // 上游加了第三种骨架：本插件的渲染链路（--style）还不认，先跳过但要说出来。
    warnings.push(`上游新增风格 family「${family}」，mcs / render.mjs 还不支持，已跳过（本插件需先适配）`)
    continue
  }
  const entry = themes[family]
  const colors = Array.isArray(entry?.colors) ? entry.colors : []
  if (colors.length === 0) fatal(`themes.json 的 ${family} 没有 colors`)
  const items = []
  for (const color of colors) {
    const id = color?.id
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(id)) fatal(`${family} 里有非法主题 id：${String(id)}`)
    if (typeof color.paper !== 'string' || !/^#[0-9a-fA-F]{6}$/u.test(color.paper)) fatal(`${family}/${id} 的 paper 不是 6 位 hex`)
    if (typeof color.accent !== 'string' || !/^#[0-9a-fA-F]{6}$/u.test(color.accent)) fatal(`${family}/${id} 的 accent 不是 6 位 hex`)
    if (typeof color.name !== 'string' || color.name === '') fatal(`${family}/${id} 缺中文名`)
    const note = THEME_NOTES[`${family}/${id}`]
    if (note === undefined) {
      warnings.push(`新主题 ${family}/${id} 还没有「适合什么内容」的说明，去 scripts/sync-themes.mjs 的 THEME_NOTES 补一句`)
    }
    items.push({
      id,
      name: { zh: color.name, en: typeof color.en === 'string' && color.en !== '' ? color.en : color.name },
      paper: color.paper,
      accent: color.accent,
      note: note ?? '—',
    })
  }
  const ids = items.map((item) => item.id)
  if (new Set(ids).size !== ids.length) fatal(`${family} 里有重复的主题 id`)
  const defaultTheme = ids.includes(entry.default) ? entry.default : ids[0]
  if (!ids.includes(entry.default)) {
    warnings.push(`${family} 的默认主题「${String(entry.default)}」不在 colors 里，已改用 ${ids[0]}`)
  }
  catalog.push({ id: family, ...STYLE_META[family], defaultTheme, themes: items })
}

if (catalog.length === 0) fatal('上游没有任何本插件支持的风格（只认 magazine / swiss）')

// ---------------------------------------------------------------- 生成

/** 与文件本身的书写风格一致：单引号，转义反斜杠与单引号（中文与空格不用转）。 */
const q = (value) => `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`

/** client.js：STYLES 表。 */
function renderClientBlock() {
  const lines = [
    `    // <${BEGIN}>`,
    '    /**',
    '     * 风格与配色：由 scripts/sync-themes.mjs 从「歸藏设计」插件的 themes.json 生成，不要手改。',
    '     * 这里只放选择器要显示的东西（名称 + 纸色 + 强调色），真正渲染仍由那个插件的',
    '     * render.mjs 按 `--style / --theme` 决定；纸色与强调色只用来画色卡，不写进任何样式规则。',
    '     */',
    '    const STYLES = [',
  ]
  for (const style of catalog) {
    lines.push('      {')
    lines.push(`        id: ${q(style.id)},`)
    lines.push(`        name: { zh: ${q(style.name.zh)}, en: ${q(style.name.en)} },`)
    lines.push(`        hint: { zh: ${q(style.hint.zh)}, en: ${q(style.hint.en)} },`)
    lines.push(`        defaultTheme: ${q(style.defaultTheme)},`)
    lines.push('        themes: [')
    for (const theme of style.themes) {
      lines.push(`          { id: ${q(theme.id)}, name: { zh: ${q(theme.name.zh)}, en: ${q(theme.name.en)} }, paper: ${q(theme.paper)}, accent: ${q(theme.accent)} },`)
    }
    lines.push('        ],')
    lines.push('      },')
  }
  lines.push('    ]')
  lines.push(`    // <${END}>`)
  return lines.join('\n')
}

/** SKILL.md：第 1 步的选项清单（行首 3 空格，落在编号列表项里）。 */
function renderSkillBlock() {
  const lines = [`   <!-- ${BEGIN} -->`]
  for (const style of catalog) {
    const themes = style.themes.map((theme) => `\`${theme.id}\` ${theme.name.zh}`).join(' / ')
    lines.push(`   - ${style.name.zh} \`${style.id}\`：${themes}`)
  }
  lines.push(`   <!-- ${END} -->`)
  return lines.join('\n')
}

/** page.md：主题表 + 兜底说明（每个风格的第一行写风格名，其余行留空对齐）。 */
function renderPageBlock() {
  const lines = [`<!-- ${BEGIN} -->`]
  for (const style of catalog) {
    style.themes.forEach((theme, index) => {
      // 只在第一行写风格名，其余行留空对齐（和手写表格同一版式：`| |` 而不是 `|  |`）。
      const head = index === 0 ? ` ${style.name.zh} \`${style.id}\` ` : ' '
      lines.push(`|${head}| \`${theme.id}\` | ${theme.name.zh} | ${theme.note} |`)
    })
  }
  const fallbacks = catalog.map((style) => `${style.name.zh} → \`${style.defaultTheme}\``).join('，')
  lines.push('')
  lines.push(`   没给 \`--theme\` 时由 render.mjs 用该风格的默认主题（${fallbacks}）。`)
  lines.push(`<!-- ${END} -->`)
  return lines.join('\n')
}

/** 用生成块替换两个标记之间的内容（含标记本身）；标记缺失时抛错，不要猜位置。 */
function replaceBlock(source, block, file) {
  const begin = source.indexOf(BEGIN)
  const end = source.indexOf(END)
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`${file} 里找不到 ${BEGIN} / ${END} 标记`)
  }
  // 往前找到该标记所在行的行首、往后找到该标记行的行尾，整行替换。
  const lineStart = source.lastIndexOf('\n', begin) + 1
  const lineEnd = source.indexOf('\n', end)
  const after = lineEnd === -1 ? source.length : lineEnd
  return `${source.slice(0, lineStart)}${block}${source.slice(after)}`
}

const outputs = []
for (const [key, rel] of Object.entries(TARGETS)) {
  const file = join(packageDir, rel)
  if (!existsSync(file)) fatal(`找不到目标文件 ${file}`)
  const source = readFileSync(file, 'utf8')
  const block = key === 'client' ? renderClientBlock() : key === 'skill' ? renderSkillBlock() : renderPageBlock()
  let next
  try {
    next = replaceBlock(source, block, rel)
  } catch (cause) {
    fatal(cause.message)
  }
  outputs.push({ rel, file, changed: next !== source, next })
}

// ---------------------------------------------------------------- 写 / 比对

for (const warning of warnings) process.stderr.write(`提示：${warning}\n`)

const drift = outputs.filter((output) => output.changed)
const sourceLabel = [source.label, sourceVersion(sourceDir)].filter((part) => part !== '').join('，')
const summary = `来源：${sourceDir}（${sourceLabel}）\n  风格：${catalog.map((style) => `${style.name.zh} ${style.themes.length} 套`).join('，')}`

if (flags.has('--check')) {
  if (drift.length === 0) {
    process.stdout.write(`已同步，无需改动。\n${summary}\n`)
    process.exit(0)
  }
  process.stdout.write(`与 ${themesFile} 不一致：\n  ${drift.map((output) => output.rel).join('\n  ')}\n${summary}\n`
    + '  跑 node scripts/sync-themes.mjs 同步（会自动重算 MANIFEST）。\n')
  process.exit(1)
}

/** 同目录临时文件 + rename：写入中途失败不会把目标文件截断成半个。 */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
  } catch (cause) {
    rmSync(tmp, { force: true })
    throw cause
  }
}

for (const output of drift) {
  try {
    writeAtomic(output.file, output.next)
  } catch (cause) {
    process.stderr.write(`写入 ${output.rel} 失败：${cause.message}\n`)
    process.exit(1)
  }
}
process.stdout.write(drift.length === 0
  ? `已是最新，未改动。\n${summary}\n`
  : `已写入：\n  ${drift.map((output) => output.rel).join('\n  ')}\n${summary}\n`)

// 文档改了就要重算清单，否则 `node --test` 的「副本与 MANIFEST 一致」会失败。
if (drift.length > 0 && existsSync(join(packageDir, 'scripts', 'sync-assets.mjs'))) {
  const result = spawnSync(process.execPath, [join(packageDir, 'scripts', 'sync-assets.mjs'), '--manifest-only'], {
    cwd: packageDir,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) {
    process.stderr.write(`MANIFEST 重算失败（退出码 ${String(result.status)}）：\n${result.stdout ?? ''}${result.stderr ?? ''}`)
    process.exit(1)
  }
  process.stdout.write('  已重算 assets/multichannel-story/MANIFEST.json\n')
}
