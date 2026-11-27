// 交付前静态检查：显示元数据、图标、详情文档、资源副本清单，以及仓库约定里的硬性项。
//
// 用法：node scripts/check-package.cjs <package dir>（默认当前目录）
// 退出码 1 表示有 FAIL，可直接接进 `npm test` / CI。
const fs = require('node:fs')
const path = require('node:path')
const { hashFile } = require('./asset-hash.cjs')

const { splitThemes } = require(path.join(__dirname, 'theme-block.cjs'))
const { auditPlatform } = require(path.join(__dirname, 'platform-audit.cjs'))

const pkg = path.resolve(process.argv[2] ?? '.')
let problems = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) problems += 1
}

const read = (relative) => fs.readFileSync(path.join(pkg, relative), 'utf8')

// ---------------------------------------------------------------- 清单
const manifest = JSON.parse(read('package.json'))
check('package name', manifest.name === 'dsh-multichannel-story', manifest.name)
check('bundle patch declared', manifest.dsh?.bundle?.patch === './cordis.patch.yml')
check('patch file exists', fs.existsSync(path.join(pkg, 'cordis.patch.yml')))
check('client half declared', manifest.dsh?.client?.platform === 'web')
check('client half export', manifest.exports?.['./client'] === './client.js')
check('client file exists', fs.existsSync(path.join(pkg, 'client.js')))
check('engines.node', typeof manifest.engines?.node === 'string', manifest.engines?.node)
check('engines.dsh', typeof manifest.engines?.dsh === 'string', manifest.engines?.dsh)
check('exports icon', manifest.exports?.['./icon'] === './icon.svg')
check('exports locale glob', manifest.exports?.['./locale/*.json'] === './locale/*.json')
for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'assets', 'docs', 'scripts', 'test', 'README.md', 'INSTALL.md', 'LICENSE']) {
  check(`files[] lists ${file}`, (manifest.files ?? []).includes(file))
}
// files[] 里列了但磁盘上不存在的条目，会让 npm pack / 安装后少文件。
const missingEntries = (manifest.files ?? [])
  .filter((entry) => !entry.includes('*'))
  .filter((entry) => !fs.existsSync(path.join(pkg, entry)))
check('files[] entries exist', missingEntries.length === 0, missingEntries.join(', '))

// ---------------------------------------------------------------- 客户端半区约定
if (fs.existsSync(path.join(pkg, 'client.js'))) {
  const client = read('client.js')
  check('client registers with __ModuleLoader__', client.includes('window.__ModuleLoader__.load('))
  check('client registers sidebar entry', client.includes("'sidebar.panellist'"))
  check('client registers main panel', client.includes("'main'"))
  check('client registers bundle config card', client.includes("'plugins.bundle.config'"))
  check('client uses theme tokens', client.includes('--dsw-alias-'))
  check('client uses host radii and elevation', client.includes('--dsw-radius-') && client.includes('--dsw-elevation-'))
  check('client switches are accessible', client.includes('role: \'switch\'') && client.includes("'aria-checked'"))
  check('client respects reduced motion', client.includes('prefers-reduced-motion'))
  check('client adapts to narrow width', client.includes('@media (max-width'))
  // 唯一的例外是 STYLES 色卡数据：内容主题的纸色/强调色，用来画预览色块，不参与界面样式。
  // 切片逻辑与 test/client.test.mjs 共用 scripts/theme-block.cjs（按 mcs:themes 标记，不靠行号/变量名）。
  const split = splitThemes(client)
  const clientColorLiterals = split.outside.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
  check('client has no literal colors (palette swatches excepted)', clientColorLiterals.length === 0, clientColorLiterals.join(', '))
  check('client palette block is marked (mcs:themes:begin/end)', split.ok)
  check('client palette block carries swatches', (split.palette.match(/#[0-9a-fA-F]{6}/g) ?? []).length >= 2)
  check('client avoids packaging its own React', !/require\(['"]react-dom/.test(client))
  check('client avoids internal client packages', !client.includes('@deepseek-ai/dsh-client-'))
}

// ---------------------------------------------------------------- README 截图
// 1) 引用的本地图片必须存在且落在包内；2) 扩展名必须与文件魔数一致——
// 把 PNG 存成 .jpg 会让部分渲染器/优化器读不出来。
const README_IMAGES = (() => {
  const file = path.join(pkg, 'README.md')
  if (!fs.existsSync(file)) return []
  return [...fs.readFileSync(file, 'utf8').matchAll(/!\[[^\]]*\]\(<?([^)>\s]+)>?\)/gu)]
    .map((match) => match[1])
    // 外链（https:、data:）不检查本地文件；其余按包内相对路径处理。
    .filter((target) => !/^[a-z][a-z0-9+.-]*:/iu.test(target))
    .map((target) => target.replace(/^\.\//u, ''))
})()

/** 解析到包内的绝对路径；`docs/../../x` 这类越界写法返回 null。 */
const imageInside = (relative) => {
  const abs = path.resolve(pkg, relative)
  // 必须严格在包目录之内，而且是文件：`docs`（目录）或 `docs/..` 都不算图片。
  if (!abs.startsWith(pkg + path.sep)) return null
  try {
    return fs.statSync(abs).isFile() ? abs : null
  } catch {
    return null
  }
}

const MAGIC = {
  '.png': [Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  '.jpg': [Buffer.from([0xff, 0xd8, 0xff])],
  '.jpeg': [Buffer.from([0xff, 0xd8, 0xff])],
  '.svg': [Buffer.from('<svg'), Buffer.from('<?xml')],
  '.gif': [Buffer.from('GIF8')],
  '.webp': [Buffer.from('RIFF')],
}
const magicOf = (file) => {
  const head = fs.readFileSync(file).subarray(0, 8)
  return Object.entries(MAGIC).find(([, signatures]) => signatures.some((sig) => head.subarray(0, sig.length).equals(sig)))?.[0]
}
check('README images exist', README_IMAGES.every((relative) => imageInside(relative) !== null), README_IMAGES.join(', '))
check('README images match their extension', README_IMAGES.every((relative) => {
  const abs = imageInside(relative)
  if (abs === null) return false
  const expected = path.extname(relative).toLowerCase()
  const actual = magicOf(abs)
  return actual !== undefined && (actual === expected || (expected === '.jpeg' && actual === '.jpg'))
}), README_IMAGES.map((relative) => {
  const abs = imageInside(relative)
  if (abs === null) return `${relative} 缺失或越出包目录`
  return `${relative} 实际是 ${magicOf(abs) ?? '未知格式'}`
}).join(', '))

// ---------------------------------------------------------------- 跨平台（macOS / Windows）
// 「支持两个平台」不能只写在 README 里：这里把会让 Windows 直接坏掉的几件事变成可执行检查。
// 实现放在 scripts/platform-audit.cjs，test/platform.test.mjs 复用同一份，避免两处漂移。
for (const item of auditPlatform(pkg)) check(item.label, item.ok, item.detail ?? '')

// ---------------------------------------------------------------- 仓库约定：不提交个人绝对路径
const TEXT_FILES = ['README.md', 'INSTALL.md', 'package.json', 'cordis.patch.yml', 'index.js', 'locale/en.json', 'locale/zh.json', 'docs/DETAIL.md', 'docs/DETAIL.zh.md']
const PERSONAL_PATH = /(?:^|[^\w])[A-Za-z]:[\\/]|\/Users\/[^/\s]+|\/home\/[^/\s]+/u
const offenders = TEXT_FILES.filter((file) => fs.existsSync(path.join(pkg, file)) && PERSONAL_PATH.test(read(file)))
check('no personal absolute paths in docs/code', offenders.length === 0, offenders.join(', '))

// ---------------------------------------------------------------- locale / 详情文档
for (const locale of ['en', 'zh']) {
  const meta = JSON.parse(read(path.join('locale', `${locale}.json`))).meta
  check(`${locale} title`, typeof meta.title === 'string' && meta.title.length > 0, meta.title)
  check(`${locale} description`, typeof meta.description === 'string' && meta.description.length > 20, `${meta.description.length} chars`)
  check(`${locale} detail path`, typeof meta.detail === 'string' && meta.detail.endsWith('.md'), meta.detail)
  const detailFile = path.join(pkg, meta.detail)
  check(`${locale} detail file exists`, fs.existsSync(detailFile))
  if (fs.existsSync(detailFile)) {
    const lines = fs.readFileSync(detailFile, 'utf8').trim().split('\n')
    check(`${locale} detail is one image line`, lines.length === 1 && /^!\[[^\]]+\]\([^)]+\.svg\)$/.test(lines[0].trim()), lines[0])
    const image = /\(([^)]+)\)$/.exec(lines[0].trim())?.[1]
    check(`${locale} detail image exists`, image !== undefined && fs.existsSync(path.join(path.dirname(detailFile), image)), image)
  }
}

// ---------------------------------------------------------------- 图标 / 插图
const icon = read('icon.svg')
const iconBytes = Buffer.byteLength(icon)
check('icon is svg', icon.trimStart().startsWith('<svg'))
check('icon under 256 KiB', iconBytes < 256 * 1024, `${iconBytes} bytes`)
check('icon has no <text>', !/<text[\s>]/.test(icon))
check('icon has no script', !/<script/.test(icon))
check('icon has no <image>', !/<image[\s>]/.test(icon))
check('icon 36x36 viewBox', /viewBox="0 0 36 36"/.test(icon))

const preview = read(path.join('docs', 'preview.svg'))
check('preview 640x300', /width="640" height="300"/.test(preview) && /viewBox="0 0 640 300"/.test(preview))
check('preview has no <text>', !/<text[\s>]/.test(preview))
check('preview has no <script>', !/<script/.test(preview))
check('preview has no <style>', !/<style[\s>]/.test(preview))
check('preview under 5 MiB', Buffer.byteLength(preview) < 5 * 1024 * 1024, `${Buffer.byteLength(preview)} bytes`)

// ---------------------------------------------------------------- 技能副本与清单一致
const assetDir = path.join(pkg, 'assets', 'multichannel-story')
let skill = ''
try {
  skill = fs.readFileSync(path.join(assetDir, 'SKILL.md'), 'utf8').replace(/^\uFEFF/u, '')
} catch (error) {
  check('bundled SKILL.md exists', false, error.code ?? String(error))
}
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(skill)?.[1] ?? ''
check('bundled SKILL.md has frontmatter name', /^name:\s*multichannel-story\s*$/m.test(frontmatter))
check('bundled SKILL.md has description', /^description:/m.test(frontmatter))
check('bundled SKILL.md has no BOM', !fs.existsSync(path.join(assetDir, 'SKILL.md'))
  || !fs.readFileSync(path.join(assetDir, 'SKILL.md')).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))

// 副本里的文本文件同样不能带个人绝对路径（示例路径请写成 <插件目录> / %LOCALAPPDATA% 这类形式）。
const assetOffenders = []
const walkAssets = (dir) => {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkAssets(full)
      continue
    }
    if (entry.name === 'MANIFEST.json' || !/\.(md|mjs|sh|py|json)$/u.test(entry.name)) continue
    if (PERSONAL_PATH.test(fs.readFileSync(full, 'utf8'))) assetOffenders.push(path.relative(pkg, full))
  }
}
walkAssets(assetDir)
check('no personal absolute paths in bundled skill', assetOffenders.length === 0, assetOffenders.join(', '))

const manifestPath = path.join(assetDir, 'MANIFEST.json')
check('assets MANIFEST.json exists', fs.existsSync(manifestPath))
if (fs.existsSync(manifestPath)) {
  const recorded = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).files ?? {}
  const recordedNames = Object.keys(recorded)
  const actual = {}
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      const relative = path.relative(assetDir, full).split(path.sep).join('/')
      if (relative === 'MANIFEST.json') continue
      actual[relative] = hashFile(full)
    }
  }
  walk(assetDir)
  const actualNames = Object.keys(actual).sort()
  const missing = [...recordedNames].sort().filter((name) => actual[name] === undefined)
  const extra = actualNames.filter((name) => recorded[name] === undefined)
  const changed = [...recordedNames].sort().filter((name) => actual[name] !== undefined && actual[name] !== recorded[name])
  check('assets match MANIFEST (no hand edits)', missing.length + extra.length + changed.length === 0,
    [...missing.map((name) => `missing ${name}`), ...extra.map((name) => `unlisted ${name}`), ...changed.map((name) => `changed ${name}`)].join('; '))
  // 清单必须按键排序写入，重跑同步才会产生逐字节相同的文件。
  check('assets MANIFEST is deterministic (sorted keys)',
    JSON.stringify(recordedNames) === JSON.stringify([...recordedNames].sort()))
  check('assets include mcs.mjs', actual['scripts/mcs.mjs'] !== undefined)
  check('assets exclude install.sh', actual['scripts/install.sh'] === undefined)
}

console.log(problems === 0 ? '\nall checks passed' : `\n${problems} problem(s)`)
process.exitCode = problems === 0 ? 0 : 1
