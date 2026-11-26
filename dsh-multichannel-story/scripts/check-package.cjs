// 交付前静态检查：显示元数据、图标、详情文档、资源副本清单，以及仓库约定里的硬性项。
//
// 用法：node scripts/check-package.cjs <package dir>（默认当前目录）
// 退出码 1 表示有 FAIL，可直接接进 `npm test` / CI。
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

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
  const clientColorLiterals = client.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
  check('client has no literal colors', clientColorLiterals.length === 0, clientColorLiterals.join(', '))
  check('client avoids packaging its own React', !/require\(['"]react-dom/.test(client))
  check('client avoids internal client packages', !client.includes('@deepseek-ai/dsh-client-'))
}

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
      actual[relative] = createHash('sha256').update(fs.readFileSync(full)).digest('hex')
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
