#!/usr/bin/env node
/**
 * 把 skill 仓库的 SKILL.md / references / scripts 同步进 assets/multichannel-story/。
 *
 * 用法：
 *   node scripts/sync-assets.mjs [源 skill 目录]   同步整份副本并重写清单
 *   node scripts/sync-assets.mjs --manifest-only   只按现有副本重算 MANIFEST.json
 *   源目录也可以用环境变量 MCS_SKILL_SRC 指定；都省略时取
 *   <本包>/../multichannel-story（与本插件目录同级的默认布局）。
 *
 * 为什么是副本：插件必须能单独安装/分享（npm 包、另一台机器、另一个 profile），
 * 不能依赖本机某个仓库路径。仓库永远是唯一源，副本由本脚本生成。
 * 上游源目录还没落到本机/本仓库时，用 --manifest-only 重算清单（副本就地维护）。
 *
 * 同时生成 assets/multichannel-story/MANIFEST.json（逐文件 sha256，内容确定性：
 * 排序、无时间戳、不含绝对路径）。check-package.cjs 与 `node --test` 用它检测
 * "副本被手改/同步遗漏"，这样改了 skill 忘了重跑同步会立刻暴露。
 *
 * 安全约定：先校验源、再复制到临时目录、最后整体替换。源目录不完整时不会先删掉
 * 现有副本（否则会留下一个"能激活但缺文件"的半成品包）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import assetHash from './asset-hash.cjs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const ASSET_DIR = join(PACKAGE_DIR, 'assets', 'multichannel-story')
const STAGING_DIR = join(PACKAGE_DIR, 'assets', '.multichannel-story.sync-tmp')
const PREVIOUS_DIR = join(PACKAGE_DIR, 'assets', '.multichannel-story.previous')
const MANIFEST_NAME = 'MANIFEST.json'

/** 参数：`--manifest-only` 只重算清单；`--help` 打印用法；其余第一个位置参数是源目录。 */
const argv = process.argv.slice(2)
const flags = new Set(argv.filter((arg) => arg.startsWith('--')))
const positionals = argv.filter((arg) => !arg.startsWith('--'))
for (const flag of flags) {
  if (flag !== '--manifest-only' && flag !== '--help') {
    process.stderr.write(`未知参数：${flag}\n用法：node scripts/sync-assets.mjs [源 skill 目录] [--manifest-only]\n`)
    process.exit(2)
  }
}
if (flags.has('--help')) {
  process.stdout.write('用法：node scripts/sync-assets.mjs [源 skill 目录] [--manifest-only]\n'
    + '  省略源目录时用 $MCS_SKILL_SRC 或 <本包>/../multichannel-story\n'
    + '  --manifest-only  只按现有 assets 副本重算 MANIFEST.json（不复制文件）\n')
  process.exit(0)
}
const manifestOnly = flags.has('--manifest-only')
const source = resolve(positionals[0] ?? process.env.MCS_SKILL_SRC ?? join(PACKAGE_DIR, '..', 'multichannel-story'))

// 手动安装路线专用的脚本不进插件：它会往 ~/.agents/skills 拷一份 rank 500 的副本，
// 优先级高于插件的 bundled 600，跑一次就会顶掉插件里的版本。
const EXCLUDED = new Set(['scripts/install.sh', 'scripts/install.ps1'])

// 缺任一文件都说明源目录不完整——此时生成的包能激活但缺工具，比直接失败更难查。
const REQUIRED = [
  'SKILL.md',
  'references/setup.md',
  'references/page.md',
  'references/cards.md',
  'references/video.md',
  'references/voice.md',
  'scripts/mcs.mjs',
  'scripts/preflight.sh',
  'scripts/build-page.sh',
  'scripts/build-cards.sh',
  'scripts/brand-theme.sh',
  'scripts/verify-av.sh',
  'scripts/list-recipes.mjs',
  'scripts/page-post.mjs',
  'scripts/tts.py',
  'scripts/scaffold-video.py',
]

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

/** 同步过程里可以预期到的失败：打印成一句话，不打栈。 */
class SyncError extends Error {}

/** 把一个片段里的第一个字母翻转大小写；没有字母时原样返回。 */
function flipCase(value) {
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (/[A-Za-z]/u.test(char)) {
      const flipped = char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()
      return value.slice(0, index) + flipped + value.slice(index + 1)
    }
  }
  return value
}

/**
 * 目标文件系统是否大小写不敏感（Windows、默认的 macOS APFS）。
 *
 * 不能只按平台判断：APFS 也可以格式化成大小写敏感。做法是把一个确实存在的路径
 * 片段的字母翻转大小写再 stat 一次——仍能命中就说明大小写被折叠。缓存结果，
 * 避免反复探测。
 */
let caseInsensitive
function isCaseInsensitive(referencePath) {
  if (caseInsensitive !== undefined) return caseInsensitive
  caseInsensitive = process.platform === 'win32'
  if (process.platform === 'darwin') {
    let current = referencePath
    for (let depth = 0; depth < 12; depth += 1) {
      const parent = dirname(current)
      const base = basename(current)
      const flipped = flipCase(base)
      // 原片段必须真实存在，翻转后仍能 stat 到才是大小写不敏感。
      if (flipped !== base && base !== '' && existsSync(current)) {
        caseInsensitive = existsSync(join(parent, flipped))
        break
      }
      if (parent === current) break
      current = parent
    }
  }
  return caseInsensitive
}

/**
 * 路径的规范比较形式：解析链接、统一分隔符，并在大小写不敏感的文件系统上折叠大小写。
 * 只比对 `resolve()` 的结果会漏掉两类同目录：大小写不同的同一路径、
 * 指向它的目录链接——那两种情况下脚本会把副本当成源，然后删掉副本。
 */
function canonicalPath(target) {
  let resolved
  try {
    resolved = realpathSync(target)
  } catch {
    // 目标还不存在（首次同步）：解析父目录再拼回名字。
    try {
      resolved = join(realpathSync(dirname(target)), relative(dirname(target), target))
    } catch {
      resolved = resolve(target)
    }
  }
  const withSlashes = resolved.split(sep).join('/')
  return isCaseInsensitive(PACKAGE_DIR) ? withSlashes.toLowerCase() : withSlashes
}

/**
 * 两个路径是否指向同一目录/文件（dev + inode）。大小写折叠是启发式的，
 * 这是最后一道确定性证据；Windows 上 inode 可能是 0，此时跳过该判据。
 */
function sameEntry(left, right) {
  try {
    const a = statSync(left)
    const b = statSync(right)
    return a.ino !== 0 && a.dev === b.dev && a.ino === b.ino
  } catch {
    return false
  }
}

/** 源目录不能是副本目录本身、它的祖先或它的子目录：否则会删掉源或自己。 */
function assertSafeSource(root) {
  const sourcePath = canonicalPath(root)
  const assetPath = canonicalPath(ASSET_DIR)
  if (sourcePath === assetPath || sameEntry(root, ASSET_DIR)) {
    throw new SyncError(`源目录就是副本目录（解析链接与大小写之后是同一个目录）：\n  源：${root}\n  副本：${ASSET_DIR}`)
  }
  if (assetPath.startsWith(`${sourcePath}/`)) {
    throw new SyncError(`源目录包含副本目录，拒绝执行（会删掉源）：\n  源：${root}\n  副本：${ASSET_DIR}`)
  }
  if (sourcePath.startsWith(`${assetPath}/`)) {
    throw new SyncError(`源目录位于副本目录内，拒绝执行：\n  源：${root}\n  副本：${ASSET_DIR}`)
  }
}

function relativeIn(root, path) {
  return relative(root, path).split(sep).join('/')
}

function walkFiles(root, visit) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) walkFiles(full, visit)
    else visit(full)
  }
}

/** 源目录里缺哪些必需文件。 */
function missingRequired(root) {
  return REQUIRED.filter((path) => !existsSync(join(root, path)))
}

/**
 * 按目录内容生成并写入 MANIFEST.json。
 * 内容确定：键排序、无时间戳、不含绝对路径，重跑产生逐字节相同的文件。
 * @param {string} root - 要被记录的副本目录。
 * @returns {object} 写入的清单对象。
 */
function writeManifest(root) {
  const hashes = {}
  walkFiles(root, (full) => {
    const relativePath = relativeIn(root, full)
    if (relativePath === MANIFEST_NAME) return
    hashes[relativePath] = assetHash.hashFile(full)
  })
  const sorted = {}
  for (const key of Object.keys(hashes).sort()) sorted[key] = hashes[key]
  const manifest = { generatedBy: 'scripts/sync-assets.mjs', sourceSkill: 'multichannel-story', files: sorted }
  writeFileSync(join(root, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

/** 文本文件统一成 LF（二进制不动）：Windows 来源的 CRLF 会让副本里的 .sh 在 macOS/Linux 上无法执行。 */
function normalizeLineEndings(root) {
  walkFiles(root, (full) => {
    if (!assetHash.TEXT_EXTENSIONS.has(extname(full).toLowerCase())) return
    const text = readFileSync(full, 'utf8')
    if (!text.includes('\r\n')) return
    writeFileSync(full, text.replace(/\r\n/g, '\n'), 'utf8')
  })
}

let files = 0
let bytes = 0
/** 先把源复制到临时目录并写清单；任何一步失败都不会碰现有副本。 */
function stage() {
  rmSync(STAGING_DIR, { recursive: true, force: true })
  mkdirSync(STAGING_DIR, { recursive: true })
  const copy = (path) => {
    const from = join(source, path)
    if (!existsSync(from)) return
    cpSync(from, join(STAGING_DIR, path), { recursive: statSync(from).isDirectory() })
  }
  copy('SKILL.md')
  copy('references')
  copy('scripts')
  // 先统一换行再统计/写清单：清单哈希本来就按 LF 归一化，内容也应当是真的 LF。
  normalizeLineEndings(STAGING_DIR)
  walkFiles(STAGING_DIR, (full) => {
    const relativePath = relativeIn(STAGING_DIR, full)
    if (EXCLUDED.has(relativePath)) {
      rmSync(full)
      return
    }
    files += 1
    bytes += statSync(full).size
  })

  const missingInStage = missingRequired(STAGING_DIR)
  if (missingInStage.length > 0) throw new SyncError(`同步结果缺少必需文件：\n  ${missingInStage.join('\n  ')}`)
  if (files === 0) throw new SyncError('没有复制到任何文件，检查源目录结构')

  return writeManifest(STAGING_DIR)
}

/**
 * 用临时目录替换现有副本：旧目录先挪开（同一卷上的 rename，不是删除），
 * 新目录就位后才丢弃它；替换失败就把旧目录挪回来。
 */
function replaceAssets() {
  rmSync(PREVIOUS_DIR, { recursive: true, force: true })
  const hadPrevious = existsSync(ASSET_DIR)
  if (hadPrevious) renameSync(ASSET_DIR, PREVIOUS_DIR)
  try {
    renameSync(STAGING_DIR, ASSET_DIR)
  } catch (error) {
    if (hadPrevious) renameSync(PREVIOUS_DIR, ASSET_DIR)
    throw error
  }
  // 新副本已经就位：旧目录删不掉（Windows 上被占用很常见）只提醒，不当成同步失败。
  try {
    rmSync(PREVIOUS_DIR, { recursive: true, force: true })
  } catch (error) {
    process.stderr.write(`提示：新副本已就位，但旧副本没删干净（${PREVIOUS_DIR}）：${error.message}\n`)
  }
}

/**
 * 只重算现有副本的清单。
 *
 * 上游源目录暂时不在本机时（例如 skill 副本已就地维护），没有它就无法跑完整同步；
 * 但清单仍必须能重算，否则改一处脚本就得手改哈希。这里只读现有副本：
 * 缺必需文件或混进不该随包发布的文件时直接失败，不写清单。
 * @returns {object} 写入的清单对象。
 */
function refreshManifestOnly() {
  if (!existsSync(join(ASSET_DIR, 'SKILL.md'))) {
    throw new SyncError(`副本目录里没有 SKILL.md，无法重算清单：${ASSET_DIR}`)
  }
  const missing = missingRequired(ASSET_DIR)
  if (missing.length > 0) throw new SyncError(`副本缺少必需文件（未写清单）：\n  ${missing.join('\n  ')}`)
  const excluded = [...EXCLUDED].filter((path) => existsSync(join(ASSET_DIR, path)))
  if (excluded.length > 0) {
    throw new SyncError(`副本里出现了不该随包发布的文件（先删掉再重算）：\n  ${excluded.join('\n  ')}`)
  }
  return writeManifest(ASSET_DIR)
}

/** 完整同步：校验源 → 复制到临时目录 → 写清单。返回清单；替换由调用方负责。 */
function syncFromSource() {
  assertSafeSource(source)
  if (!existsSync(join(source, 'SKILL.md'))) throw new SyncError(`源目录里没有 SKILL.md：${source}`)

  const raw = readFileSync(join(source, 'SKILL.md'), 'utf8').replace(/^\uFEFF/u, '')
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)?.[1] ?? ''
  if (!/^description:/mu.test(frontmatter)) {
    throw new SyncError(`${join(source, 'SKILL.md')} 的 frontmatter 里没有 description`)
  }
  if (!/^name:\s*multichannel-story\s*$/mu.test(frontmatter)) {
    throw new SyncError(`${join(source, 'SKILL.md')} 的 frontmatter name 不是 multichannel-story`)
  }

  // 先确认源完整，再动现有副本。
  const missingInSource = missingRequired(source)
  if (missingInSource.length > 0) {
    throw new SyncError(`源目录缺少必需文件（未改动现有副本）：\n  ${missingInSource.join('\n  ')}`)
  }
  return stage()
}

let manifest
try {
  manifest = manifestOnly ? refreshManifestOnly() : syncFromSource()
  if (!manifestOnly) replaceAssets()
} catch (error) {
  rmSync(STAGING_DIR, { recursive: true, force: true })
  // 替换失败时 replaceAssets 已把旧目录挪回；这里再确认一次，按事实措辞。
  const kept = existsSync(ASSET_DIR)
  if (existsSync(PREVIOUS_DIR) && !kept) {
    try {
      renameSync(PREVIOUS_DIR, ASSET_DIR)
    } catch {
      // 留给下面如实报告
    }
  }
  const detail = error instanceof Error ? error.message : String(error)
  if (manifestOnly) {
    fail(`重算清单失败，现有清单未改动：\n  ${detail}`)
  } else if (existsSync(ASSET_DIR)) {
    fail(`同步失败，现有副本未改动：\n  ${detail}`)
  } else {
    fail(`同步失败，且现有副本不在原位（旧副本可能残留在 ${PREVIOUS_DIR}）：\n  ${detail}`)
  }
}

if (manifestOnly) {
  process.stdout.write(`已按现有副本重算清单：${Object.keys(manifest.files).length} 个文件\n  ${join(ASSET_DIR, MANIFEST_NAME)}\n`)
} else {
  process.stdout.write(`已同步 ${files} 个文件（${(bytes / 1024).toFixed(1)} KiB），清单记录 ${Object.keys(manifest.files).length} 项\n`)
  process.stdout.write(`  ${source}\n  → ${ASSET_DIR}\n`)
}
