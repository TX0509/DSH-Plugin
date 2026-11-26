#!/usr/bin/env node
/**
 * multichannel-story 跨平台命令行（无第三方依赖，Node >= 20）。
 *
 * 与 `scripts/*.sh` 一一对应：`.sh` 现在只是转发到本文件的薄壳，
 * 这样 macOS / Linux / Windows(DSH Desktop) 走同一份实现，不会各写一遍再漂移。
 *
 *   node scripts/mcs.mjs preflight [--page|--cards|--video|--images|--all] [--json]
 *   node scripts/mcs.mjs page <项目目录> [--out x.html] [--style magazine|swiss]
 *                                    [--theme indigo-porcelain] [--embed]
 *                                    [--brand "#76B900"] [--cap-fig "文件名:宽:高"]…
 *   node scripts/mcs.mjs cards <任务目录> [--no-validate] [--seed editorial|swiss]
 *   node scripts/mcs.mjs brand "#76B900" [--family magazine|swiss]
 *                                        [--apply 文件.html] [--tokens]
 *   node scripts/mcs.mjs verify <file.mp4> [--expect-w 1080] [--expect-h 1920]
 *                                          [--expect-fps 30] [--expect-dur 40.5]
 *                                          [--expect-audio required|silent|optional]
 *
 * 依赖的外部程序：node（自身）、python（Pillow / edge-tts）、ffmpeg / ffprobe、
 * 以及 dsh-guizang-design 插件（网页 / 卡片渲染）。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { postProcessPage } from './page-post.mjs'

const argv = process.argv.slice(2)
const command = argv[0]
const rest = argv.slice(1)

// ---------------------------------------------------------------- 基础工具

function out(text = '') {
  process.stdout.write(`${text}\n`)
}

function err(text = '') {
  process.stderr.write(`${text}\n`)
}

/** 运行一个外部命令，返回 {code, stdout, stderr}；找不到命令时 code = -1 并带 error。 */
function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: options.capture === false ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    cwd: options.cwd,
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    code: result.status === null ? -1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  }
}

const nodeBin = process.execPath

/** 在一个命令可以正常执行时返回 true。 */
function works(cmd, args = ['--version']) {
  const result = run(cmd, args)
  return result.code === 0
}

/** 依次尝试候选命令，返回第一个能跑的。 */
function firstWorking(candidates) {
  for (const [cmd, args] of candidates) {
    if (cmd === undefined || cmd === '') continue
    if (works(cmd, args)) return cmd
  }
  return undefined
}

/** 归一化用户传入的相对路径（以调用者的 cwd 为基准）。 */
function resolveArg(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

/**
 * 打印用的短路径：家目录 → `~`，DSH_HOME → `$DSH_HOME`。
 * AGENTS.md 要求日志/输出里不要出现完整用户路径，这里只影响展示，--json 仍保留原值。
 */
function shortenPath(target) {
  let shown = target
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  if (shown.startsWith(dshHome)) shown = `$DSH_HOME${shown.slice(dshHome.length)}`
  else if (shown.startsWith(homedir())) shown = `~${shown.slice(homedir().length)}`
  return shown
}

/** 解析 `--flag value` 与 `--flag=value`；未知参数报错退出。 */
function parseFlags(args, spec) {
  const values = {}
  const positional = []
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '-h' || token === '--help') {
      values.help = true
      continue
    }
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const [rawName, inline] = token.includes('=') ? token.split(/=(.*)/su, 2) : [token, undefined]
    const name = rawName.slice(2)
    const def = Object.hasOwn(spec, name) ? spec[name] : undefined
    if (def === undefined) {
      err(`未知参数：${token}`)
      process.exit(2)
    }
    if (def.type === 'boolean') {
      values[name] = true
      continue
    }
    const value = inline ?? args[index + 1]
    if (value === undefined) {
      err(`${token} 需要一个值`)
      process.exit(2)
    }
    if (inline === undefined) index += 1
    if (def.type === 'list') {
      values[name] = [...(values[name] ?? []), value]
    } else {
      values[name] = value
    }
  }
  return { values, positional }
}

/** 定位 dsh-guizang-design 插件目录（GZ_ROOT 优先，其次 DSH_HOME 下各 profile 的 node_modules）。 */
function findGuizangRoot() {
  const explicit = process.env.GZ_ROOT
  if (explicit !== undefined && explicit !== '' && existsSync(explicit)) return explicit
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profiles = join(dshHome, 'profiles')
  if (!existsSync(profiles)) return undefined
  let entries = []
  try {
    entries = readdirSync(profiles, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const candidate = join(profiles, entry.name, 'node_modules', 'dsh-guizang-design')
    if (existsSync(join(candidate, 'skills'))) return candidate
  }
  return undefined
}

// ---------------------------------------------------------------- preflight

function preflight(args) {
  const { values } = parseFlags(args, {
    page: { type: 'boolean' },
    cards: { type: 'boolean' },
    video: { type: 'boolean' },
    images: { type: 'boolean' },
    all: { type: 'boolean' },
    json: { type: 'boolean' },
  })
  if (values.help === true) {
    out('用法：node scripts/mcs.mjs preflight [--page] [--cards] [--video] [--images] [--all] [--json]')
    return 0
  }

  let needPage = values.page === true
  let needCards = values.cards === true
  let needVideo = values.video === true
  let needImages = values.images === true
  if (values.all === true) {
    needPage = needCards = needVideo = needImages = true
  }
  if (!needPage && !needCards && !needVideo && !needImages) needPage = needCards = true

  const items = []
  const record = (section, status, label, detail = '') => items.push({ section, status, label, detail })
  const pass = (section, label, detail = '') => record(section, 'ok', label, detail)
  const fail = (section, label, detail = '') => record(section, 'missing', label, detail)
  const note = (section, label, detail = '') => record(section, 'info', label, detail)


  // 基础运行时
  if (values.json !== true) out('== multichannel-story 环境自检 ==')
  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (nodeMajor >= 20) pass('基础运行时', `node ${process.version}`)
  else fail('基础运行时', `node ${process.version}`, '需要 Node.js ≥ 20')

  const pythonCandidates = [
    [process.env.DSH_PYTHON, ['-c', 'import sys']],
    ['python3', ['-c', 'import sys']],
    ['python', ['-c', 'import sys']],
    ['py', ['-3', '-c', 'import sys']],
  ]
  const python = firstWorking(pythonCandidates.filter(([cmd]) => cmd !== undefined && cmd !== ''))
  const hasModule = (module) => {
    if (python === undefined) return false
    const args = python === 'py' ? ['-3', '-c', `import ${module}`] : ['-c', `import ${module}`]
    return run(python, args).code === 0
  }
  const moduleVersion = (module, attr) => {
    if (python === undefined) return ''
    const args = python === 'py' ? ['-3', '-c', `import ${module};print(${module}.${attr})`] : ['-c', `import ${module};print(${module}.${attr})`]
    return run(python, args).stdout.trim()
  }
  if (python !== undefined) pass('基础运行时', 'python', python)
  else fail('基础运行时', 'python', '需要 python3')
  // Pillow 只有图片裁切/接触表会用到，ffmpeg 也能替代：缺了只提示，不算 MISSING，
  // 否则不带 Pillow 的解释器会把整条流水线硬停在用不到的依赖上。
  if (python !== undefined && hasModule('PIL')) pass('基础运行时', 'Pillow', moduleVersion('PIL', '__version__'))
  else note('基础运行时', 'Pillow', '可选：仅图片裁切/接触表需要（ffmpeg 也能做），缺了不影响自检结论')

  // 歸藏设计插件
  const guizangRoot = findGuizangRoot()
  if (needPage || needCards) {
    if (guizangRoot !== undefined) {
      pass('歸藏设计插件', 'dsh-guizang-design', shortenPath(guizangRoot))
      if (needPage) {
        if (existsSync(join(guizangRoot, 'skills', 'guizang-page-skill', 'scripts', 'render.mjs'))) {
          pass('歸藏设计插件', 'guizang-page-skill')
        } else {
          fail('歸藏设计插件', 'guizang-page-skill', '插件不完整，重装 dsh-guizang-design')
        }
      }
      if (needCards) {
        if (existsSync(join(guizangRoot, 'skills', 'guizang-social-card-skill', 'scripts', 'render.mjs'))) {
          pass('歸藏设计插件', 'guizang-social-card-skill')
        } else {
          fail('歸藏设计插件', 'guizang-social-card-skill', '插件不完整，重装 dsh-guizang-design')
        }
        if (existsSync(join(guizangRoot, 'skills', 'humanizer-zh', 'SKILL.md'))) {
          pass('歸藏设计插件', 'humanizer-zh')
        } else {
          fail('歸藏设计插件', 'humanizer-zh', '插件不完整')
        }
        // 卡片渲染走 playwright；浏览器版本要和插件自带的 playwright 对得上，
        // 对不上时渲染会报 Executable doesn't exist。
        const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH
          ?? (process.platform === 'win32'
            ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright')
            : join(homedir(), '.cache', 'ms-playwright'))
        const chromiumDirs = existsSync(browsersPath)
          ? readdirSync(browsersPath).filter((name) => name.startsWith('chromium'))
          : []
        if (chromiumDirs.length > 0) {
          note('歸藏设计插件', 'playwright chromium', `${shortenPath(browsersPath)}（${chromiumDirs.join(', ')}；渲染报 Executable doesn't exist 时在该插件目录跑 npx playwright install chromium）`)
        } else {
          note('歸藏设计插件', 'playwright chromium', `未找到 ${shortenPath(browsersPath)}；渲染前在 dsh-guizang-design 目录跑 npx playwright install chromium`)
        }
      }
    } else {
      fail('歸藏设计插件', 'dsh-guizang-design', '未安装')
      note('歸藏设计插件', '安装', 'plugin_manager(action="install_bundle", target="dsh-guizang-design")，装完重启会话')
    }
  }

  // 视频链路
  if (needVideo) {
    const ffmpeg = firstWorking([['ffmpeg', ['-version']]])
    const ffprobe = firstWorking([['ffprobe', ['-version']]])
    if (ffmpeg !== undefined && ffprobe !== undefined) {
      const version = run(ffmpeg, ['-version']).stdout.split('\n')[0].split(' ')[2] ?? ''
      pass('视频链路', 'ffmpeg', version)
    } else {
      fail('视频链路', 'ffmpeg', process.platform === 'win32' ? 'winget install Gyan.FFmpeg 或 scoop install ffmpeg' : 'brew install ffmpeg')
    }
    if (python !== undefined && hasModule('edge_tts')) pass('视频链路', 'edge-tts', moduleVersion('edge_tts', '__version__'))
    else fail('视频链路', 'edge-tts', `${python ?? 'python3'} -m pip install edge-tts（需要联网）`)
    // Studio 的安装位置随平台不同：macOS 是 ~/openmotion，Windows 是 %LOCALAPPDATA%\openmotion。
    const openmotionInstallCandidates = [
      join(homedir(), 'openmotion'),
      process.env.LOCALAPPDATA === undefined ? '' : join(process.env.LOCALAPPDATA, 'openmotion'),
      process.env.APPDATA === undefined ? '' : join(process.env.APPDATA, 'openmotion'),
    ].filter((candidate) => candidate !== '')
    const openmotionInstall = openmotionInstallCandidates.find((candidate) => existsSync(candidate))
    if (openmotionInstall !== undefined) pass('视频链路', 'openmotion 安装目录', shortenPath(openmotionInstall))
    else fail('视频链路', 'openmotion', '未安装：按 openmotion 技能里的安装文档装好本机 Studio')
    const openmotionDataCandidates = [
      join(homedir(), '.openmotion', 'data'),
      openmotionInstall === undefined ? '' : join(openmotionInstall, 'data'),
    ].filter((candidate) => candidate !== '')
    const openmotionData = openmotionDataCandidates.find((candidate) => existsSync(candidate))
    if (openmotionData !== undefined) pass('视频链路', 'openmotion 数据目录', shortenPath(openmotionData))
    else fail('视频链路', 'openmotion 数据目录', '启动一次 Studio 会创建')
    note('视频链路', 'MCP 连接', '只能在对话里验证：调 openmotion_get_project() 成功即可')
  }

  // 素材链路
  if (needImages) {
    const egoBin = firstWorking([['ego-browser', ['--version']]])
    const egoLocal = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'ego-browser.exe' : 'ego-browser')
    if (egoBin !== undefined) pass('素材链路', 'ego-browser CLI', egoBin)
    else if (existsSync(egoLocal)) pass('素材链路', 'ego-browser CLI', shortenPath(egoLocal))
    else fail('素材链路', 'ego-browser CLI', '按 ego-browser 技能的 install.md 安装')
    if (existsSync(join(homedir(), '.agents', 'skills', 'ego-browser', 'SKILL.md'))) pass('素材链路', 'ego-browser skill')
    else fail('素材链路', 'ego-browser skill', '装到 ~/.agents/skills/')
    note('素材链路', 'stock_image_search', '工具在且配置了图库 Key 即可用（Pexels/Unsplash 需 Key，Wikimedia/Openverse 免 Key）')
  }

  const okCount = items.filter((item) => item.status === 'ok').length
  const missCount = items.filter((item) => item.status === 'missing').length

  if (values.json === true) {
    out(JSON.stringify({ ok: okCount, missing: missCount, ready: missCount === 0, items }, null, 2))
  } else {
    let currentSection = ''
    for (const item of items) {
      if (item.section !== currentSection) {
        currentSection = item.section
        out(`-- ${item.section} --`)
      }
      const icon = item.status === 'ok' ? '✅' : item.status === 'missing' ? '❌' : 'ℹ️'
      out(` ${icon} ${item.label.padEnd(26, ' ')} ${item.detail}`.trimEnd())
    }
    out('')
    out(`== 结果：${okCount} 项就绪，${missCount} 项缺失 ==`)
    if (missCount > 0) out('缺的依赖先装，装不上就停下来告诉用户缺什么、影响哪一步。')
    else out('可以开始。')
  }
  return missCount > 0 ? 1 : 0
}

// ---------------------------------------------------------------- page

function page(args) {
  const { values, positional } = parseFlags(args, {
    out: { type: 'string' },
    style: { type: 'string' },
    theme: { type: 'string' },
    embed: { type: 'boolean' },
    brand: { type: 'string' },
    'cap-fig': { type: 'list' },
  })
  const dir = positional[0]
  if (values.help === true || dir === undefined) {
    out('用法：node scripts/mcs.mjs page <项目目录> [--out x.html] [--style magazine|swiss]')
    out('                                    [--theme indigo-porcelain] [--embed] [--brand "#76B900"]')
    out('                                    [--cap-fig "文件名:宽:高"]…')
    out('  --out 必须以 .html 结尾，且不能指向 article.md / annotations.json（会覆盖源稿）。')
    out('  后处理会核对页脚是否真的清掉、竖图 CSS 是否真的插入，没生效就失败退出。')
    return values.help === true ? 0 : 2
  }
  const projectDir = resolveArg(dir)
  const article = join(projectDir, 'article.md')
  const annotations = join(projectDir, 'annotations.json')
  if (!existsSync(article)) {
    err('缺少 article.md')
    return 1
  }
  if (!existsSync(annotations)) {
    err('缺少 annotations.json（用锚点算行号生成）')
    return 1
  }

  // 先校验输出路径再渲染：渲染器会直接写到 --out 指向的位置，
  // 允许它指向 article.md / annotations.json 或非 .html 后缀，就等于允许毁掉输入。
  const outFile = values.out ?? `${basename(projectDir)}.html`
  const outPath = isAbsolute(outFile) ? outFile : join(projectDir, outFile)
  const sameFile = (left, right) => {
    const normalize = (value) => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value))
    return normalize(left) === normalize(right)
  }
  // 先判“是不是输入文件”，报错才能说清是哪一条；否则只会得到一句“必须以 .html 结尾”。
  if (sameFile(outPath, article) || sameFile(outPath, annotations)) {
    err('--out 不能指向 article.md / annotations.json：渲染会先覆盖它，源稿就无法恢复')
    return 2
  }
  if (!/\.html$/iu.test(outFile)) {
    err(`--out 必须以 .html 结尾（收到：${outFile}）`)
    return 2
  }

  const guizangRoot = findGuizangRoot()
  if (guizangRoot === undefined) {
    err('找不到 dsh-guizang-design 插件（先跑 preflight）')
    return 1
  }
  const render = join(guizangRoot, 'skills', 'guizang-page-skill', 'scripts', 'render.mjs')
  const style = values.style ?? 'magazine'
  const theme = values.theme ?? 'indigo-porcelain'
  const caps = values['cap-fig'] ?? []

  // 先校验再渲染：参数写错时不要先写出一份产物再失败。
  const figureCaps = []
  for (const spec of caps) {
    const parts = spec.split(':')
    const valid = parts.length === 3
      && parts[0].trim() !== ''
      && /^\d+$/u.test(parts[1].trim())
      && /^\d+$/u.test(parts[2].trim())
    if (!valid) {
      err(`--cap-fig 需要 "文件名:宽:高" 三段，宽高是像素数（收到：${spec}）`)
      return 2
    }
    figureCaps.push({ name: parts[0].trim(), width: parts[1].trim(), height: parts[2].trim() })
  }

  const renderArgs = [render, article, annotations, outFile, '--style', style, '--theme', theme]
  if (values.embed === true) renderArgs.push('--embed')
  if (values.brand !== undefined) renderArgs.push('--brand', values.brand)
  const rendered = spawnSync(nodeBin, renderArgs, { cwd: projectDir, encoding: 'utf8', stdio: 'inherit', windowsHide: true })
  if (rendered.status !== 0) return rendered.status ?? 1

  // 输出文件可能与项目目录不同（--out 允许绝对路径）：这里用的必须是同一个解析结果。
  const post = postProcessPage(readFileSync(outPath, 'utf8'), figureCaps)
  if (post.leftoverFooter) {
    err('清理后页面里仍然有工具品牌页脚：渲染器的页脚结构可能变了，先看页面再交付')
    return 1
  }
  if (post.headMissing) {
    err('页面里没有 </head>，竖图收窄 CSS 无法插入：检查渲染器输出，别把没生效当成已生效')
    return 1
  }
  writeFileSync(outPath, post.html, 'utf8')
  out(`[post] 页脚清理 ${post.footerRemoved} 处；人像收窄规则 ${post.figureRules} 条`)
  if (post.footerRemoved === 0) {
    out('  ! 这次没找到工具页脚（渲染器已改或页脚结构变了）：交付前自己确认页脚没有品牌字样')
  }

  const exportScript = join(guizangRoot, 'skills', 'guizang-page-skill', 'scripts', 'export.mjs')
  const exportBase = outFile.replace(/\.html$/u, '')
  out(`✓ 页面：${outPath}`)
  out(`  导出：node "${exportScript}" "${outFile}" --pdf "${exportBase}.pdf" --png "${exportBase}-长图.png" --width 1240`)
  return 0
}

// ---------------------------------------------------------------- cards

const RATIO_PATTERNS = [
  [/21:9/gu, '21:9'],
  [/1:1/gu, '1:1'],
  [/3:4/gu, '3:4'],
  [/2100\s*[×xX]\s*900/gu, '2100x900'],
  [/1080\s*[×xX]\s*(?:1080|1440)/gu, '1080x1080/1440'],
]

/** 剥离标签后的可见文本，用于检查「画面上不要出现比例/尺寸」。 */
function visibleText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gu, ' ')
    .replace(/<script[\s\S]*?<\/script>/gu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<[^>]+>/gu, ' ')
}

function cards(args) {
  const { values, positional } = parseFlags(args, {
    'no-validate': { type: 'boolean' },
    seed: { type: 'string' },
  })
  const dir = positional[0]
  if (values.help === true || dir === undefined) {
    out('用法：node scripts/mcs.mjs cards <任务目录> [--no-validate] [--seed editorial|swiss]')
    return values.help === true ? 0 : 2
  }
  const taskDir = resolveArg(dir)
  const guizangRoot = findGuizangRoot()
  if (guizangRoot === undefined) {
    err('找不到 dsh-guizang-design 插件（先跑 preflight）')
    return 1
  }
  const cardRoot = join(guizangRoot, 'skills', 'guizang-social-card-skill')
  const indexFile = join(taskDir, 'index.html')
  const seed = values.seed ?? 'editorial'

  if (!existsSync(indexFile)) {
    const template = join(cardRoot, 'assets', seed === 'swiss' ? 'template-swiss-card.html' : 'template-editorial-card.html')
    if (!existsSync(template)) {
      err(`找不到 seed 模板：${template}`)
      return 1
    }
    copyFileSync(template, indexFile)
    out('已从 seed 模板创建 index.html —— 先把 <!-- POSTERS_HERE --> 区域替换成真实卡片再渲染。')
    out('主题用 <html data-theme="indigo-porcelain"> 之类与网页保持一致。')
    return 0
  }

  const text = visibleText(readFileSync(indexFile, 'utf8'))
  const hits = []
  for (const [pattern, label] of RATIO_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const start = Math.max(0, (match.index ?? 0) - 16)
      hits.push(`${label}: ${text.slice(start, (match.index ?? 0) + match[0].length + 16).split(/\s+/u).join(' ')}`)
    }
  }
  if (hits.length > 0) {
    out('⚠ 可见文本里出现比例/尺寸标注（用户要求画面上不要出现）：')
    for (const hit of [...new Set(hits)]) out(`    ${hit}`)
    out('')
  }

  mkdirSync(join(taskDir, 'output'), { recursive: true })
  const rendered = spawnSync(nodeBin, [join(cardRoot, 'scripts', 'render.mjs'), '.', '--out', 'output'], {
    cwd: taskDir,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
  })
  if (rendered.status !== 0) return rendered.status ?? 1

  if (values['no-validate'] !== true) {
    out('')
    const validated = spawnSync(nodeBin, [join(cardRoot, 'validate-social-deck.mjs'), '.'], {
      cwd: taskDir,
      encoding: 'utf8',
      stdio: 'inherit',
      windowsHide: true,
    })
    if (validated.status !== 0) {
      out('校验有 FAIL：按提示修 HTML 后重跑。advisory 警告可在交付说明里解释。')
      return 1
    }
  }

  out(`✓ 卡片输出：${join(taskDir, 'output')}`)
  return 0
}

// ---------------------------------------------------------------- brand

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/u

function brand(args) {
  const { values, positional } = parseFlags(args, {
    family: { type: 'string' },
    apply: { type: 'string' },
    tokens: { type: 'boolean' },
  })
  const hex = positional[0]
  if (values.help === true || hex === undefined) {
    out('用法：node scripts/mcs.mjs brand "#RRGGBB" [--family magazine|swiss] [--apply 文件.html] [--tokens]')
    out('  --family  magazine（默认，会压彩度）| swiss（保留鲜度）')
    out('  --apply   把品牌主题注入 HTML：写 <style id="brand-theme"> 并把 <html data-theme> 切成 brand')
    out('  --tokens  只输出 {"paper","ink","accent"}，供视频骨架的 theme 使用')
    // 无参数只是忘了写颜色，不是错误用法：和 --help 一样退 0，避免脚本调用方误判。
    return 0
  }
  if (!HEX_COLOR.test(hex)) {
    err(`品牌色要用 6 位 hex，例如 "#76B900"（收到：${hex}）`)
    return 2
  }
  const family = values.family ?? 'magazine'
  if (family !== 'magazine' && family !== 'swiss') {
    err('--family 只支持 magazine|swiss')
    return 2
  }
  const guizangRoot = findGuizangRoot()
  if (guizangRoot === undefined) {
    err('找不到 dsh-guizang-design 插件（先跑 preflight）')
    return 1
  }
  const themeScript = join(guizangRoot, 'skills', 'guizang-page-skill', 'scripts', 'gz-theme.mjs')
  const generated = run(nodeBin, [themeScript, 'brand', hex, '--family', family])
  if (generated.code !== 0) {
    err('品牌色生成失败（插件拒绝了这个颜色）：')
    for (const line of generated.stdout.trimEnd().split('\n').slice(-3)) err(line)
    for (const line of generated.stderr.trimEnd().split('\n').slice(-3)) err(line)
    return 1
  }
  const lines = generated.stdout.trimEnd().split('\n')
  const comment = lines[0] ?? ''
  const block = lines[lines.length - 1] ?? ''

  if (values.tokens === true) {
    const token = (name) => {
      const match = new RegExp(`--${name}:(#[0-9a-fA-F]{6})`, 'u').exec(block)
      return match === null ? null : match[1]
    }
    out(JSON.stringify({ paper: token('paper'), ink: token('ink'), accent: token('accent') }))
    return 0
  }

  out(comment)
  out(block)

  if (values.apply !== undefined) {
    const target = resolveArg(values.apply)
    if (!existsSync(target)) {
      err(`找不到要注入的文件：${values.apply}`)
      return 1
    }
    let html = readFileSync(target, 'utf8')
    if (!html.includes('<html') || !html.includes('</head>')) {
      err(`${basename(target)} 不是完整 HTML（缺 <html> 或 </head>），换个文件或先用 seed 模板`)
      return 1
    }
    const style = `<style id="brand-theme">${block}</style>\n`
    html = html.replace(/<style id="brand-theme">[\s\S]*?<\/style>\n?/u, '') // 幂等：重复注入只留一份
    html = html.replace('</head>', `${style}</head>`)
    let replaced = 0
    html = html.replace(/<html[^>]*>/u, (tag) => {
      replaced += 1
      return tag.includes('data-theme=')
        ? tag.replace(/data-theme="[^"]*"/u, 'data-theme="brand"')
        : `${tag.slice(0, -1)} data-theme="brand">`
    })
    if (replaced !== 1) {
      err('没找到 <html> 标签')
      return 1
    }
    writeFileSync(target, html, 'utf8')
    out(`[brand] 已注入 ${basename(target)}：data-theme="brand"，<style id="brand-theme">`)
  }
  return 0
}

// ---------------------------------------------------------------- verify

function ffprobeJson(file, args) {
  const result = run('ffprobe', ['-v', 'error', ...args, '-of', 'json', file])
  if (result.code !== 0) {
    err(result.stderr.trim() || 'ffprobe 执行失败')
    return undefined
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    return undefined
  }
}

function verify(args) {
  const { values, positional } = parseFlags(args, {
    'expect-w': { type: 'string' },
    'expect-h': { type: 'string' },
    'expect-fps': { type: 'string' },
    'expect-dur': { type: 'string' },
    'expect-audio': { type: 'string' },
  })
  const file = positional[0]
  if (values.help === true || file === undefined) {
    out('用法：node scripts/mcs.mjs verify <file.mp4> [--expect-w 1080] [--expect-h 1920] [--expect-fps 30]')
    out('                                          [--expect-dur 40.5] [--expect-audio required|silent|optional]')
    return values.help === true ? 0 : 2
  }
  const target = resolveArg(file)
  if (!existsSync(target)) {
    err(`找不到文件：${file}`)
    return 1
  }
  if (!works('ffprobe', ['-version'])) {
    err('缺 ffprobe')
    return 1
  }

  const expectedWidth = values['expect-w'] ?? '1080'
  const expectedHeight = values['expect-h'] ?? '1920'
  const expectedFps = values['expect-fps'] ?? '30'
  const expectedDuration = values['expect-dur']
  const expectedAudio = values['expect-audio'] ?? 'required'
  let fails = 0
  const check = (label, expected, actual) => {
    if (String(expected) === String(actual)) out(`  ✅ ${label.padEnd(14, ' ')} ${actual}`)
    else {
      out(`  ❌ ${label.padEnd(14, ' ')} ${actual}（期望 ${expected}）`)
      fails += 1
    }
  }
  const ok = (label, detail) => out(`  ✅ ${label.padEnd(14, ' ')} ${detail}`)
  const bad = (label, detail) => {
    out(`  ❌ ${label.padEnd(14, ' ')} ${detail}`)
    fails += 1
  }

  out(`== 成片核查：${basename(target)} ==`)
  const streams = ffprobeJson(target, ['-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate'])
  const video = streams?.streams?.[0]
  if (video === undefined) {
    bad('视频流', '找不到视频流')
  } else {
    check('宽', expectedWidth, video.width)
    check('高', expectedHeight, video.height)
    const [num, den] = String(video.r_frame_rate ?? '0/1').split('/')
    const fps = den !== undefined ? Math.round(Number(num) / Number(den)) : Number(num)
    check('帧率', expectedFps, Number.isFinite(fps) ? fps : String(video.r_frame_rate))
  }

  const format = ffprobeJson(target, ['-show_entries', 'format=duration'])
  const duration = Number(format?.format?.duration ?? '')
  if (expectedDuration === undefined) {
    ok('时长', Number.isFinite(duration) ? `${duration}s` : '未知')
  } else if (Number.isFinite(duration) && Math.abs(duration - Number(expectedDuration)) <= 0.15) {
    ok('时长', `${Math.round(duration * 100) / 100}s`)
  } else {
    bad('时长', `${Number.isFinite(duration) ? Math.round(duration * 100) / 100 : '?'}s（期望 ${expectedDuration}s）`)
  }

  const audioStreams = ffprobeJson(target, ['-select_streams', 'a', '-show_entries', 'stream=codec_name,channels,sample_rate'])
  const audio = audioStreams?.streams?.[0]
  const audioInfo = audio === undefined
    ? ''
    : `${audio.codec_name} ${audio.channels}ch ${audio.sample_rate}Hz`
  if (audio !== undefined) {
    if (expectedAudio === 'silent') bad('音轨', '存在音轨（期望静音）')
    else ok('音轨', audioInfo)
  } else if (expectedAudio === 'silent') ok('音轨', '无音轨（符合静音要求）')
  else if (expectedAudio === 'optional') ok('音轨', '无音轨（可接受）')
  else bad('音轨', '没有音轨（需要配音）')

  if (audio !== undefined) {
    out('-- 响度 --')
    const loudness = run('ffmpeg', ['-hide_banner', '-i', target, '-map', '0:a', '-af', 'volumedetect', '-f', 'null', '-'])
    const analysis = `${loudness.stdout}\n${loudness.stderr}`
    const mean = /mean_volume:\s*([^\n]+)/u.exec(analysis)?.[1] ?? ''
    const max = /max_volume:\s*([^\n]+)/u.exec(analysis)?.[1] ?? ''
    out(`  ℹ️  mean_volume: ${mean.trim()} / max_volume: ${max.trim()}`)
    const maxDb = /-?[0-9.]+/u.exec(max)?.[0]
    if (maxDb !== undefined && Number(maxDb) <= -0.5) ok('峰值', '无削波')
    else bad('峰值', '接近 0 dB，可能削波')

    out('-- 语句落点（silence_end 即每句起点附近） --')
    const detected = run('ffmpeg', ['-hide_banner', '-i', target, '-map', '0:a', '-af', 'silencedetect=noise=-38dB:d=0.35', '-f', 'null', '-'])
    const silenceText = `${detected.stdout}\n${detected.stderr}`
    const ends = [...silenceText.matchAll(/silence_end:\s*([0-9.]+)/gu)].map((match) => Number(match[1]))
    for (const end of ends.slice(0, 20)) out(`  ${end.toFixed(2)}s`)
  }

  out('')
  if (fails === 0) {
    out('== ✅ 全部通过 ==')
    return 0
  }
  out(`== ❌ ${fails} 项不通过 ==`)
  return 1
}

// ---------------------------------------------------------------- check（HyperFrames 工程校验）

/**
 * 读 OpenMotion 的 install.json，拿到 appRoot / dataDirectory。
 * Studio 的安装位置随平台混乱（macOS 在 ~/openmotion，Windows 在 %LOCALAPPDATA%\openmotion），
 * 所以以 install.json 为唯一真相，不猜路径。
 */
function readOpenmotionInstall() {
  const roots = [
    process.env.OPENMOTION_ROOT,
    process.env.LOCALAPPDATA === undefined ? '' : join(process.env.LOCALAPPDATA, 'openmotion'),
    join(homedir(), 'openmotion'),
    join(homedir(), '.openmotion'),
  ].filter((root) => root !== undefined && root !== '')
  for (const root of roots) {
    const installFile = join(root, 'install.json')
    if (!existsSync(installFile)) continue
    try {
      const info = JSON.parse(readFileSync(installFile, 'utf8'))
      return {
        installFile,
        appRoot: typeof info.appRoot === 'string' && info.appRoot !== '' ? info.appRoot : undefined,
        dataDirectory: typeof info.dataDirectory === 'string' && info.dataDirectory !== '' ? info.dataDirectory : undefined,
      }
    } catch {
      // 坏文件就继续找下一个候选
    }
  }
  return undefined
}

/**
 * 在 OpenMotion 的 appRoot 里找 hyperframes CLI。
 * 只认 node 能直接执行的 bin/hyperframes.mjs：.bin 下是 .cmd/符号链接，
 * 用 `node <那个文件>` 跑批处理会失败，与其给出难懂的报错不如直接说"找不到"。
 */
function findHyperframesCli(appRoot) {
  if (appRoot === undefined) return undefined
  const candidate = join(appRoot, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs')
  return existsSync(candidate) ? candidate : undefined
}

/** 把 hyperframes check 的 JSON 汇总成几行，避免把整份 findings 倒给模型。 */
function summariseCheck(report) {
  const lines = []
  const findings = []
  for (const [section, value] of Object.entries(report)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    if (typeof value.errorCount !== 'number' && typeof value.warningCount !== 'number') continue
    const state = value.ok === true ? 'ok' : 'FAIL'
    lines.push(`  ${section.padEnd(10, ' ')} ${state}  errors=${value.errorCount ?? 0}  warnings=${value.warningCount ?? 0}  info=${value.infoCount ?? 0}`)
    if (Array.isArray(value.findings)) findings.push(...value.findings)
  }
  const interesting = findings
    .filter((item) => item !== null && typeof item === 'object')
    .sort((left, right) => (left.severity === 'error' ? 0 : 1) - (right.severity === 'error' ? 0 : 1))
  for (const item of interesting.slice(0, 12)) {
    const where = typeof item.selector === 'string' && item.selector !== '' ? ` ${item.selector}` : ''
    lines.push(`  - [${item.severity ?? 'issue'}] ${item.code ?? ''}${where}: ${item.message ?? ''}`)
  }
  if (interesting.length > 12) lines.push(`  … 另有 ${interesting.length - 12} 条，用 --json 看全部`)
  return lines
}

function check(args) {
  const { values, positional } = parseFlags(args, { json: { type: 'boolean' } })
  const dir = positional[0]
  if (values.help === true || dir === undefined) {
    out('用法：node scripts/mcs.mjs check <OpenMotion 工程目录> [--json]')
    out('  从 OpenMotion 的 install.json 找到 hyperframes CLI，跑 lint/布局/动效/对比度校验。')
    out('  CLI 输出无法解析时按失败退出（不会把“没校验到”当成通过）。')
    return values.help === true ? 0 : 2
  }
  const projectDir = resolveArg(dir)
  if (!existsSync(projectDir)) {
    err(`找不到工程目录：${dir}`)
    return 1
  }
  const install = readOpenmotionInstall()
  const cli = process.env.HYPERFRAMES_CLI !== undefined && process.env.HYPERFRAMES_CLI !== ''
    ? process.env.HYPERFRAMES_CLI
    : findHyperframesCli(install?.appRoot)
  if (cli === undefined) {
    err('找不到 hyperframes CLI：OpenMotion 没装，或 install.json 里没有 appRoot。')
    err('装好 Studio 后重跑；也可以设 HYPERFRAMES_CLI=<…/node_modules/hyperframes/bin/hyperframes.mjs>。')
    return 1
  }
  if (values.json !== true) out(`== hyperframes check：${projectDir} ==`)
  const result = run(nodeBin, [cli, 'check', projectDir, '--json'])
  const stdout = result.stdout.trim()
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  let report
  if (start !== -1 && end > start) {
    try {
      report = JSON.parse(stdout.slice(start, end + 1))
    } catch {
      report = undefined
    }
  }
  if (report === undefined) {
    err('hyperframes check 没有返回可解析的 JSON —— 不能当作通过：')
    err((stdout !== '' ? stdout : result.stderr).slice(-4000))
    return 1
  }
  if (values.json === true) {
    out(JSON.stringify({ cli, install, report }, null, 2))
  } else {
    out(`  通过：${report.ok === true ? '是' : '否'}${report.browserSkipped === true ? '（只做了静态检查，浏览器被跳过）' : ''}`)
    for (const line of summariseCheck(report)) out(line)
  }
  return result.code === 0 && report.ok === true ? 0 : 1
}

// ---------------------------------------------------------------- 入口

const COMMANDS = {
  preflight,
  page,
  cards,
  brand,
  verify,
  check,
}

function usage() {
  out('multichannel-story 跨平台命令行')
  out('')
  out('  node scripts/mcs.mjs preflight [--page|--cards|--video|--images|--all] [--json]')
  out('  node scripts/mcs.mjs page <项目目录> [--out x.html] [--style magazine|swiss] [--embed] [--brand "#76B900"]')
  out('  node scripts/mcs.mjs cards <任务目录> [--no-validate] [--seed editorial|swiss]')
  out('  node scripts/mcs.mjs brand "#76B900" [--family magazine|swiss] [--apply 文件.html] [--tokens]')
  out('  node scripts/mcs.mjs verify <file.mp4> [--expect-w] [--expect-h] [--expect-fps] [--expect-dur] [--expect-audio]')
  out('  node scripts/mcs.mjs check <OpenMotion 工程目录> [--json]')
  out('')
  out('每个子命令都支持 --help。')
}

if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
  usage()
  process.exitCode = command === undefined ? 2 : 0
} else if (!Object.hasOwn(COMMANDS, command)) {
  // 用 hasOwn 判断：`constructor` / `toString` 这类原型链上的成员不是子命令。
  err(`未知子命令：${command}`)
  usage()
  process.exitCode = 2
} else {
  try {
    // 用 exitCode 而不是 process.exit()：Windows 下 stdout 是管道时，
    // 立即退出可能丢掉还没 flush 的尾部输出。
    const code = COMMANDS[command](rest)
    process.exitCode = typeof code === 'number' ? code : 0
  } catch (error) {
    err(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
