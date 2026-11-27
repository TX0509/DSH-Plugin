#!/usr/bin/env node
/**
 * multichannel-story 跨平台命令行（无第三方依赖，Node >= 20）。
 *
 * 与 `scripts/*.sh` 一一对应：`.sh` 现在只是转发到本文件的薄壳，
 * 这样 macOS / Linux / Windows(DSH Desktop) 走同一份实现，不会各写一遍再漂移。
 *
 *   node scripts/mcs.mjs preflight [--page|--cards|--video|--images|--all] [--json]
 *   node scripts/mcs.mjs page <项目目录> [--out x.html] [--force] [--style magazine|swiss]
 *                                    [--theme <主题 id>] [--embed]
 *                                    [--brand "#76B900"] [--cap-fig "文件名:宽:高"]…
 *   node scripts/mcs.mjs cards <任务目录> [--no-validate] [--allow-labels] [--seed editorial|swiss]
 *   node scripts/mcs.mjs brand "#76B900" [--family magazine|swiss]
 *                                        [--apply 文件.html] [--tokens]
 *   node scripts/mcs.mjs verify <file.mp4> [--expect-w 1080] [--expect-h 1920]
 *                                          [--expect-fps 30] [--expect-dur 40.5]
 *                                          [--expect-audio required|silent|optional]
 *                                          [--expect-lufs -16] [--expect-cues scenes.json]
 *   node scripts/mcs.mjs check <OpenMotion 工程目录> [--json]
 *
 * 依赖的外部程序：node（自身）、python（Pillow / edge-tts）、ffmpeg / ffprobe、
 * 以及 dsh-guizang-design 插件（网页 / 卡片渲染）。
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
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
    stdio: ['ignore', 'pipe', 'pipe'],
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

/** DSH_HOME（默认 ~/.dsh）：profile / 安装清单的根。 */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * 打印用的短路径：家目录 → `~`，DSH_HOME → `$DSH_HOME`。
 * AGENTS.md 要求日志/输出里不要出现完整用户路径，这里只影响展示，--json 仍保留原值。
 */
function shortenPath(target) {
  let shown = target
  const home = dshHome()
  if (shown.startsWith(home)) shown = `$DSH_HOME${shown.slice(home.length)}`
  else if (shown.startsWith(homedir())) shown = `~${shown.slice(homedir().length)}`
  return shown
}

/** 文件系统比较用：真实路径（符号链接解析到最终目标；目标不存在时解析父目录再拼文件名）。 */
function realpathForCompare(target) {
  try {
    if (existsSync(target)) return realpathSync(target)
    return join(realpathSync(dirname(target)), basename(target))
  } catch {
    return resolve(target)
  }
}

/** 比较两个路径是否同一个（Windows 大小写不敏感）。 */
function samePath(left, right) {
  const normalize = (value) => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value))
  return normalize(left) === normalize(right)
}

/** child 是否真的在 parent 目录里（按真实路径比较，避免 `..` / 符号链接逃逸）。 */
function isInsideDir(parent, child) {
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const base = normalize(parent)
  const target = normalize(child)
  return target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

/** 解析 `--flag value` 与 `--flag=value`；未知参数报错退出。`--` 之后全部当位置参数。 */
function parseFlags(args, spec) {
  const values = {}
  const positional = []
  let terminated = false
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (terminated) {
      positional.push(token)
      continue
    }
    if (token === '--') {
      terminated = true
      continue
    }
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
      if (inline !== undefined) {
        err(`${rawName} 是开关，不接受 = 值`)
        process.exit(2)
      }
      values[name] = true
      continue
    }
    const value = inline ?? args[index + 1]
    // `--out --force` 这种把下一个开关当值吃掉的情况要直接报错，别静默少一个参数。
    if (value === undefined || (inline === undefined && value.startsWith('--'))) {
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
  // `--` 之后传进来的名字如果以 - 开头，命令行工具没法把它和开关区分，直接拒绝。
  for (const item of positional) {
    if (item.startsWith('-')) {
      err(`位置参数不能以 - 开头（收到：${item}）；文件名请换一个不带前导 - 的写法`)
      process.exit(2)
    }
  }
  return { values, positional }
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/u
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const UNSAFE_FIGURE_NAME = /[\u0000-\u001F\u007F<>]/u

/** 定位 dsh-guizang-design 插件目录（GZ_ROOT 优先，其次 DSH_HOME 下各 profile 的 node_modules）。 */
function findGuizangRoot() {
  const explicit = process.env.GZ_ROOT
  if (explicit !== undefined && explicit !== '' && existsSync(explicit)) return explicit
  const profiles = join(dshHome(), 'profiles')
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

// ---------------------------------------------------------------- OpenMotion / hyperframes 发现

/**
 * 读 OpenMotion 的 install.json，拿到 appRoot / dataDirectory。
 * Studio 的安装位置随平台混乱（macOS 在 ~/openmotion，Windows 在 %LOCALAPPDATA%\openmotion），
 * 所以先看安装清单；新版 OpenMotion 把真实安装信息写进了 onboarding 文件，下面再兜。
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
      const appRoot = typeof info.appRoot === 'string' && info.appRoot !== ''
        ? info.appRoot
        : typeof info.applicationRoot === 'string' && info.applicationRoot !== ''
          ? info.applicationRoot
          : undefined
      return {
        installFile,
        appRoot,
        dataDirectory: typeof info.dataDirectory === 'string' && info.dataDirectory !== '' ? info.dataDirectory : undefined,
      }
    } catch {
      // 坏文件就继续找下一个候选
    }
  }
  return undefined
}

/** `$DSH_HOME/profiles/<profile>/openmotion-onboarding.json`：新版真实安装信息在这里。 */
function listOnboardingFiles() {
  const profiles = join(dshHome(), 'profiles')
  if (!existsSync(profiles)) return []
  let entries = []
  try {
    entries = readdirSync(profiles, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const file = join(profiles, entry.name, 'openmotion-onboarding.json')
    if (existsSync(file)) files.push(file)
  }
  return files
}

function readOnboardingFile(file) {
  try {
    const info = JSON.parse(readFileSync(file, 'utf8'))
    return {
      file,
      appRoot: typeof info.applicationRoot === 'string' && info.applicationRoot !== ''
        ? info.applicationRoot
        : typeof info.appRoot === 'string' && info.appRoot !== ''
          ? info.appRoot
          : undefined,
      dataDirectory: typeof info.dataDirectory === 'string' && info.dataDirectory !== '' ? info.dataDirectory : undefined,
    }
  } catch {
    return undefined
  }
}

/** appRoot 下 node 能直接执行的 hyperframes CLI（.bin 里是 .cmd / 符号链接，跑批处理会失败）。 */
function hyperframesCliPath(appRoot) {
  return join(appRoot, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs')
}

/**
 * 多级发现 hyperframes CLI（顺序即优先级）：
 *   1. HYPERFRAMES_CLI 环境变量（显式覆盖；指错就直接报错，不静默换别的安装）
 *   2. install.json 的 appRoot
 *   3. $DSH_HOME/profiles/<profile>/openmotion-onboarding.json 的 applicationRoot
 *   4. 已知安装根目录下直接探测 node_modules/hyperframes/bin/hyperframes.mjs
 * 返回 { cli, source, appRoot, dataDirectory, install, onboarding, attempted }；
 * 找不到时 attempted 里是已经试过的位置，给报错用。
 */
function discoverHyperframes() {
  const attempted = []
  const info = { cli: undefined, source: undefined, appRoot: undefined, dataDirectory: undefined, install: undefined, onboarding: undefined, envMissing: undefined, attempted }
  const pushAttempt = (source, candidate) => attempted.push({ source, candidate })

  const envCli = process.env.HYPERFRAMES_CLI
  if (envCli !== undefined && envCli !== '') {
    pushAttempt('HYPERFRAMES_CLI 环境变量', envCli)
    if (existsSync(envCli)) {
      info.cli = envCli
      info.source = 'HYPERFRAMES_CLI 环境变量'
      return info
    }
    info.envMissing = envCli
    return info
  }

  // install.json（老版本安装）
  const install = readOpenmotionInstall()
  if (install !== undefined) {
    info.install = install
    info.appRoot = install.appRoot
    info.dataDirectory = install.dataDirectory
    if (install.appRoot !== undefined) {
      const candidate = hyperframesCliPath(install.appRoot)
      pushAttempt(`install.json（${shortenPath(install.installFile)}）`, candidate)
      if (existsSync(candidate)) {
        info.cli = candidate
        info.source = 'install.json'
        return info
      }
    }
  }

  // openmotion-onboarding.json（新版安装把 applicationRoot / dataDirectory 记在这里）
  for (const file of listOnboardingFiles()) {
    const onboarding = readOnboardingFile(file)
    if (onboarding === undefined) continue
    if (info.onboarding === undefined) info.onboarding = onboarding
    if (info.appRoot === undefined) info.appRoot = onboarding.appRoot
    if (info.dataDirectory === undefined) info.dataDirectory = onboarding.dataDirectory
    const source = `openmotion-onboarding.json（${shortenPath(file)}）`
    if (onboarding.appRoot === undefined) {
      pushAttempt(source, '')
      continue
    }
    const candidate = hyperframesCliPath(onboarding.appRoot)
    pushAttempt(source, candidate)
    if (existsSync(candidate)) {
      info.cli = candidate
      info.source = `openmotion-onboarding.json（${shortenPath(file)}）`
      return info
    }
  }

  // 已知安装目录直接探测（本机事实：~/openmotion 是源码目录、没有 install.json 时也能找到 CLI）
  const rootCandidates = [
    info.install?.appRoot,
    info.onboarding?.appRoot,
    process.env.OPENMOTION_ROOT,
    join(homedir(), 'openmotion'),
    process.env.LOCALAPPDATA === undefined ? '' : join(process.env.LOCALAPPDATA, 'openmotion'),
    process.env.APPDATA === undefined ? '' : join(process.env.APPDATA, 'openmotion'),
    join(homedir(), '.openmotion'),
  ].filter((root) => root !== undefined && root !== '')
  const seenRoots = new Set()
  for (const root of rootCandidates) {
    const key = process.platform === 'win32' ? root.toLowerCase() : root
    if (seenRoots.has(key)) continue
    seenRoots.add(key)
    const candidate = hyperframesCliPath(root)
    pushAttempt(`已知安装目录（${shortenPath(root)}）`, candidate)
    if (existsSync(candidate)) {
      info.cli = candidate
      info.source = `已知安装目录（${shortenPath(root)}）`
      if (info.appRoot === undefined) info.appRoot = root
      return info
    }
  }
  return info
}

/** 从发现结果里确定 OpenMotion 的 dataDirectory（优先清单里记的，其次已知目录）。 */
function resolveOpenmotionData(discovery) {
  for (const candidate of [
    discovery.dataDirectory,
    discovery.install?.dataDirectory,
    discovery.onboarding?.dataDirectory,
  ]) {
    if (candidate !== undefined && existsSync(candidate)) return candidate
  }
  const roots = [
    discovery.appRoot,
    discovery.install?.appRoot,
    discovery.onboarding?.appRoot,
    join(homedir(), 'openmotion'),
  ].filter((root) => root !== undefined && root !== '')
  for (const root of roots) {
    const data = join(root, 'data')
    if (existsSync(data)) return data
  }
  const userData = join(homedir(), '.openmotion', 'data')
  return existsSync(userData) ? userData : undefined
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
    out('  --page   网页长文：歸藏设计插件 + page skill 的 render.mjs / export.mjs')
    out('  --cards  小红书/公众号卡片：卡片 skill 的 render.mjs、validate-social-deck.mjs、seed 模板')
    out('  --video  视频链路：ffmpeg / ffprobe、python + edge-tts、openmotion CLI（多级发现）')
    out('  --images 素材链路：ego-browser CLI/skill、图库工具')
    out('  --all    以上全部；不带开关时默认只查 --page --cards')
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
  // python 只有视频链路（TTS / 视频骨架）需要：--page / --cards 不该因为没装 python 被判 MISSING。
  if (python !== undefined) pass('基础运行时', 'python', python)
  else if (needVideo) fail('基础运行时', 'python', '需要 python3（TTS / 视频骨架）')
  else note('基础运行时', 'python', '可选：只有 --video（TTS / 视频骨架）需要 python，本次 --page/--cards 用不到')
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
        const pageSkill = join(guizangRoot, 'skills', 'guizang-page-skill')
        if (existsSync(join(pageSkill, 'scripts', 'render.mjs'))) {
          pass('歸藏设计插件', 'guizang-page-skill')
        } else {
          fail('歸藏设计插件', 'guizang-page-skill', '插件不完整，重装 dsh-guizang-design')
        }
        if (existsSync(join(pageSkill, 'scripts', 'export.mjs'))) {
          pass('歸藏设计插件', 'guizang-page-skill/export')
        } else {
          fail('歸藏设计插件', 'guizang-page-skill/export', '缺 export.mjs（PDF / 长图导出要用），重装 dsh-guizang-design')
        }
      }
      if (needCards) {
        const cardSkill = join(guizangRoot, 'skills', 'guizang-social-card-skill')
        if (existsSync(join(cardSkill, 'scripts', 'render.mjs'))) {
          pass('歸藏设计插件', 'guizang-social-card-skill')
        } else {
          fail('歸藏设计插件', 'guizang-social-card-skill', '插件不完整，重装 dsh-guizang-design')
        }
        if (existsSync(join(cardSkill, 'validate-social-deck.mjs'))) {
          pass('歸藏设计插件', 'validate-social-deck')
        } else {
          fail('歸藏设计插件', 'validate-social-deck', '缺卡片校验器 validate-social-deck.mjs，重装 dsh-guizang-design')
        }
        const seedTemplates = ['template-editorial-card.html', 'template-swiss-card.html']
          .map((name) => join(cardSkill, 'assets', name))
        const missingSeeds = seedTemplates.filter((file) => !existsSync(file))
        if (missingSeeds.length === 0) pass('歸藏设计插件', 'seed 模板')
        else fail('歸藏设计插件', 'seed 模板', `缺 ${missingSeeds.map((file) => basename(file)).join(', ')}，重装 dsh-guizang-design`)
        // 去 AI 味只影响文案，不阻塞渲染：缺了给提示，不算 MISSING。
        if (existsSync(join(guizangRoot, 'skills', 'humanizer-zh', 'SKILL.md'))) {
          pass('歸藏设计插件', 'humanizer-zh')
        } else {
          note('歸藏设计插件', 'humanizer-zh', '可选：只影响文案去 AI 味，缺了不阻塞网页/卡片渲染')
        }
        // 卡片渲染走 playwright；浏览器版本要和插件自带的 playwright 对得上，
        // 对不上时渲染会报 Executable doesn't exist。缓存目录按平台区分，并尊重 PLAYWRIGHT_BROWSERS_PATH。
        const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH
          ?? (process.platform === 'win32'
            ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright')
            : process.platform === 'darwin'
              ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
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
    // 与 `mcs check` 共用同一套多级发现：preflight 绿了 check 就一定能找到 CLI，不能各查各的。
    const discovery = discoverHyperframes()
    if (discovery.cli !== undefined) {
      pass('视频链路', 'openmotion CLI', `${shortenPath(discovery.cli)}（${discovery.source}）`)
    } else {
      fail('视频链路', 'openmotion CLI', '未找到：装好 Studio，或设 HYPERFRAMES_CLI=<…/node_modules/hyperframes/bin/hyperframes.mjs>')
      for (const item of discovery.attempted.slice(0, 6)) {
        note('视频链路', '尝试过', `${item.source}：${item.candidate === '' ? '（未提供 appRoot）' : shortenPath(item.candidate)}`)
      }
    }
    const openmotionData = resolveOpenmotionData(discovery)
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

function pageUsage() {
  out('用法：node scripts/mcs.mjs page <项目目录> [--out x.html] [--force] [--style magazine|swiss]')
  out('                                    [--theme <主题 id>] [--embed] [--brand "#76B900"]')
  out('                                    [--cap-fig "文件名:宽:高"]…')
  out('  --out      必须以 .html 结尾、落在项目目录内；已存在的文件默认拒绝，--force 才覆盖普通文件。')
  out('  --force    只允许覆盖项目内的普通文件；符号链接一律拒绝（防止写到 article.md 或项目外）。')
  out('  --cap-fig  文件名不能含 < > 或控制字符；从右往左取两段数字，Windows 绝对路径也能用。')
  out('  后处理会核对页脚是否真的清掉、竖图 CSS 是否真的插入，没生效就失败退出。')
}

/**
 * 解析 --cap-fig 的 `文件名:宽:高`：从右往左切两刀，这样 Windows 盘符开头的
 * 绝对路径（例如 `D:` + 路径）不会被 split(':') 切碎。返回对象或错误字符串。
 */
function parseCapFig(spec) {
  const heightColon = spec.lastIndexOf(':')
  const widthColon = heightColon <= 0 ? -1 : spec.lastIndexOf(':', heightColon - 1)
  if (widthColon < 0) return `--cap-fig 需要 "文件名:宽:高" 三段，宽高是像素数（收到：${spec}）`
  const name = spec.slice(0, widthColon).trim()
  const width = spec.slice(widthColon + 1, heightColon).trim()
  const height = spec.slice(heightColon + 1).trim()
  if (name === '') return `--cap-fig 的文件名不能为空（收到：${spec}）`
  if (UNSAFE_FIGURE_NAME.test(name)) {
    return `--cap-fig 的文件名不能包含 <、>、控制字符或换行（会被写进 HTML/CSS，收到：${JSON.stringify(name)}）`
  }
  if (!/^\d+$/u.test(width) || !/^\d+$/u.test(height)) {
    return `--cap-fig 的宽高必须是像素数（收到：${spec}）`
  }
  return { name, width, height }
}

function page(args) {
  const { values, positional } = parseFlags(args, {
    out: { type: 'string' },
    force: { type: 'boolean' },
    style: { type: 'string' },
    theme: { type: 'string' },
    embed: { type: 'boolean' },
    brand: { type: 'string' },
    'cap-fig': { type: 'list' },
  })
  const dir = positional[0]
  if (values.help === true) {
    pageUsage()
    return 0
  }
  if (dir === undefined) {
    pageUsage()
    return 2
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

  const outFile = values.out ?? `${basename(projectDir)}.html`
  if (outFile.startsWith('-')) {
    err(`--out 文件名不能以 - 开头（会被当成命令行参数，收到：${outFile}）`)
    return 2
  }

  // 参数语法先校验：写错时不要先渲染出一份产物再失败。
  const style = values.style ?? 'magazine'
  if (values.style !== undefined && (!KEBAB_CASE.test(values.style) || (style !== 'magazine' && style !== 'swiss'))) {
    err(`--style 只支持 magazine|swiss（收到：${values.style}）`)
    return 2
  }
  // 配色不在这里兜底：render.mjs 没收到 --theme 时会用该风格在 themes.json 里的 default，
  // 那张表归「歸藏设计」插件维护。写死一个默认主题就会和上游漂移（瑞士风还会因此落到杂志风的主题上）。
  const theme = values.theme
  if (values.theme !== undefined && !KEBAB_CASE.test(values.theme)) {
    err(`--theme 必须是 kebab-case（小写字母/数字/连字符，收到：${values.theme}）`)
    return 2
  }
  if (values.brand !== undefined && !HEX_COLOR.test(values.brand)) {
    err(`--brand 要用 6 位 hex 颜色，例如 "#76B900"（收到：${values.brand}）`)
    return 2
  }
  const figureCaps = []
  for (const spec of values['cap-fig'] ?? []) {
    const parsed = parseCapFig(spec)
    if (typeof parsed === 'string') {
      err(parsed)
      return 2
    }
    figureCaps.push(parsed)
  }

  // 先校验输出路径再渲染：渲染器会直接写到 --out 指向的位置，
  // 允许它指向 article.md / annotations.json、符号链接或项目外，就等于允许毁掉输入。
  const outPath = isAbsolute(outFile) ? outFile : join(projectDir, outFile)
  // 先判“是不是输入文件”，报错才能说清是哪一条；否则只会得到一句“必须以 .html 结尾”。
  const projectReal = realpathForCompare(projectDir)
  const articleReal = realpathForCompare(article)
  const annotationsReal = realpathForCompare(annotations)
  const outReal = realpathForCompare(outPath)
  if (samePath(outReal, articleReal) || samePath(outReal, annotationsReal)) {
    err('--out 不能指向 article.md / annotations.json：渲染会先覆盖它，源稿就无法恢复')
    return 2
  }
  if (!/\.html$/iu.test(outPath)) {
    err(`--out 必须以 .html 结尾（收到：${outFile}）`)
    return 2
  }
  // 已存在的符号链接一律拒绝：realpath 之后可能指到项目外或源稿上，--force 也不行。
  if (existsSync(outPath) && lstatSync(outPath).isSymbolicLink()) {
    err(`--out 指向符号链接，拒绝写入：符号链接可能把内容写到项目外或源稿上（${shortenPath(outPath)}）`)
    return 2
  }
  if (!isInsideDir(projectReal, outReal)) {
    err(`--out 必须落在项目目录内（项目：${shortenPath(projectReal)}；收到：${shortenPath(outReal)}）`)
    return 2
  }
  if (existsSync(outPath) && values.force !== true) {
    err(`--out 目标已存在，拒绝覆盖：${shortenPath(outPath)}（确认覆盖项目内这个普通文件时加 --force）`)
    return 2
  }
  if (existsSync(outPath) && !lstatSync(outPath).isFile()) {
    err(`--force 只允许覆盖项目内的普通文件（${shortenPath(outPath)} 不是普通文件）`)
    return 2
  }

  const guizangRoot = findGuizangRoot()
  if (guizangRoot === undefined) {
    err('找不到 dsh-guizang-design 插件（先跑 preflight）')
    return 1
  }
  const render = join(guizangRoot, 'skills', 'guizang-page-skill', 'scripts', 'render.mjs')

  const renderArgs = [render, article, annotations, outFile, '--style', style]
  if (theme !== undefined) renderArgs.push('--theme', theme)
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
  const exportBase = outFile.replace(/\.html$/iu, '')
  out(`✓ 页面：${shortenPath(outPath)}`)
  // 不打印可直接粘进 shell 的命令行：项目名/文件名里可能带 $(...)、反引号，粘贴执行就是命令注入。
  // 输出 argv 数组，调用方按数组 exec（第一个元素是 node 可执行文件）。
  const exportArgv = [nodeBin, exportScript, outFile, '--pdf', `${exportBase}.pdf`, '--png', `${exportBase}-长图.png`, '--width', '1240']
  out(`  导出 argv（按数组直接执行，不要拼 shell 字符串）：${JSON.stringify(exportArgv)}`)
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

/** output 目录下（含子目录）的 PNG 文件列表。 */
function listPngFiles(dir) {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { recursive: true })
      .map((entry) => String(entry))
      .filter((entry) => /\.png$/iu.test(entry))
  } catch {
    return []
  }
}

function cardsUsage() {
  out('用法：node scripts/mcs.mjs cards <任务目录> [--no-validate] [--allow-labels] [--seed editorial|swiss]')
  out('  --no-validate  渲染后不跑 validate-social-deck.mjs（默认必须跑到，校验器没跑起来算失败）')
  out('  --allow-labels 放行画面上的比例/尺寸标注（默认失败：用户要求成图上不写这些制作标注）')
  out('  --seed         没有 index.html 时从 seed 模板拷一份，退出码 3 表示「只拷了模板、还没渲染」')
}

function cards(args) {
  const { values, positional } = parseFlags(args, {
    'no-validate': { type: 'boolean' },
    'allow-labels': { type: 'boolean' },
    seed: { type: 'string' },
  })
  const dir = positional[0]
  if (values.help === true) {
    cardsUsage()
    return 0
  }
  if (dir === undefined) {
    cardsUsage()
    return 2
  }
  const taskDir = resolveArg(dir)
  const seed = values.seed ?? 'editorial'
  if (seed !== 'editorial' && seed !== 'swiss') {
    err(`--seed 只支持 editorial|swiss（收到：${seed}）`)
    return 2
  }
  const guizangRoot = findGuizangRoot()
  if (guizangRoot === undefined) {
    err('找不到 dsh-guizang-design 插件（先跑 preflight）')
    return 1
  }
  const cardRoot = join(guizangRoot, 'skills', 'guizang-social-card-skill')
  const indexFile = join(taskDir, 'index.html')

  if (!existsSync(indexFile)) {
    const template = join(cardRoot, 'assets', seed === 'swiss' ? 'template-swiss-card.html' : 'template-editorial-card.html')
    if (!existsSync(template)) {
      err(`找不到 seed 模板：${template}`)
      return 1
    }
    copyFileSync(template, indexFile)
    out('已从 seed 模板创建 index.html —— 先把 <!-- POSTERS_HERE --> 区域替换成真实卡片再渲染。')
    out('主题用 <html data-theme="ikb"> 之类，与网页实际用的主题保持一致（别固定写某一个）。')
    // 退出码 3：只拷贝了未渲染的模板，不能当成“卡片已生成”。
    out('未渲染：本次只拷贝了 seed 模板，补完卡片后重跑 `mcs cards` 才会渲染与校验。')
    return 3
  }

  const ratioText = visibleText(readFileSync(indexFile, 'utf8'))
  const hits = []
  for (const [pattern, label] of RATIO_PATTERNS) {
    for (const match of ratioText.matchAll(pattern)) {
      const start = Math.max(0, (match.index ?? 0) - 16)
      hits.push(`${label}: ${ratioText.slice(start, (match.index ?? 0) + match[0].length + 16).split(/\s+/u).join(' ')}`)
    }
  }
  if (hits.length > 0) {
    const uniq = [...new Set(hits)]
    if (values['allow-labels'] !== true) {
      err('可见文本里出现比例/尺寸标注（用户要求画面上不要出现）：')
      for (const hit of uniq) err(`    ${hit}`)
      err('')
      err('把制作标注从画面里删掉后重跑；确认是误报/必须保留时才加 --allow-labels。')
      return 1
    }
    out('⚠ 可见文本里有比例/尺寸标注，--allow-labels 已放行：')
    for (const hit of uniq) out(`    ${hit}`)
    out('')
  }

  const outputDir = join(taskDir, 'output')
  mkdirSync(outputDir, { recursive: true })
  const rendered = spawnSync(nodeBin, [join(cardRoot, 'scripts', 'render.mjs'), '.', '--out', 'output'], {
    cwd: taskDir,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
  })
  if (rendered.status !== 0) return rendered.status ?? 1

  // 渲染命令 exit 0 不代表真有产物：output 里一张 PNG 都没有时不能报成功。
  const pngs = listPngFiles(outputDir)
  if (pngs.length === 0) {
    err(`渲染命令成功退出，但 ${shortenPath(outputDir)} 里没有 PNG：检查卡片 skill 的 render.mjs 输出参数`)
    return 1
  }

  if (values['no-validate'] !== true) {
    out('')
    const validator = join(cardRoot, 'validate-social-deck.mjs')
    if (!existsSync(validator)) {
      err(`校验器没跑起来：找不到 ${shortenPath(validator)}（重装 dsh-guizang-design）`)
      return 1
    }
    const validated = spawnSync(nodeBin, [validator, '.'], {
      cwd: taskDir,
      encoding: 'utf8',
      stdio: 'inherit',
      windowsHide: true,
    })
    // status === null 表示进程根本没起来（或被杀），和「校验器跑了但报 FAIL」是两回事。
    if (validated.error !== undefined || validated.status === null) {
      err('校验器没跑起来：validate-social-deck.mjs spawn 失败')
      if (validated.error !== undefined) err(validated.error.message)
      return 1
    }
    if (validated.status !== 0) {
      out('校验有 FAIL：按提示修 HTML 后重跑。advisory 警告可在交付说明里解释。')
      return 1
    }
  }

  out(`✓ 卡片输出：${shortenPath(outputDir)}（${pngs.length} 张 PNG）`)
  return 0
}

// ---------------------------------------------------------------- brand

function brandUsage() {
  out('用法：node scripts/mcs.mjs brand "#RRGGBB" [--family magazine|swiss] [--apply 文件.html] [--tokens]')
  out('  --family  magazine（默认，会压彩度）| swiss（保留鲜度）')
  out('  --apply   把品牌主题注入 HTML：写 <style id="brand-theme"> 并把 <html data-theme> 切成 brand')
  out('  --tokens  只输出 {"paper","ink","accent"}，供视频骨架的 theme 使用')
  out('  颜色必须是 6 位 hex（例如 "#76B900"）；不带颜色参数是用法错误，退出码 2。')
}

function brand(args) {
  const { values, positional } = parseFlags(args, {
    family: { type: 'string' },
    apply: { type: 'string' },
    tokens: { type: 'boolean' },
  })
  const hex = positional[0]
  if (values.help === true) {
    brandUsage()
    return 0
  }
  // 不带颜色参数是用法错误，不能退 0 让脚本调用方误判成功。
  if (hex === undefined) {
    brandUsage()
    err('缺少品牌色参数：例如 node scripts/mcs.mjs brand "#76B900"')
    return 2
  }
  if (values.tokens === true && values.apply !== undefined) {
    err('--tokens 只输出颜色 token，不能和 --apply 一起用：先注入主题，或先取 token，二选一')
    return 2
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
      const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`, 'u').exec(block)
      return match === null ? null : match[1]
    }
    const tokens = { paper: token('paper'), ink: token('ink'), accent: token('accent') }
    const missing = Object.entries(tokens).filter(([, value]) => value === null).map(([name]) => name)
    // token 解析不出来时不能输出 "paper":null 还退 0：视频骨架拿到 null 会静默丢主题。
    if (missing.length > 0) {
      err(`品牌 token 解析失败：${missing.join(', ')} 为 null（gz-theme.mjs 的输出格式可能变了）`)
      return 1
    }
    out(JSON.stringify(tokens))
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

/** 从 ffmpeg 日志末尾取 loudnorm 的 JSON 对象（print_format=json）。 */
function lastJsonObject(text) {
  const start = text.lastIndexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/** 两遍法的第一遍：只测量，读 input_i（整体响度 LUFS）与 input_tp（真峰 dBTP）。 */
function measureLoudness(file) {
  const result = run('ffmpeg', [
    '-hide_banner', '-nostats', '-i', file, '-map', '0:a:0',
    '-af', 'loudnorm=I=-16:TP=-1:LRA=11:print_format=json', '-f', 'null', '-',
  ])
  const text = `${result.stdout}\n${result.stderr}`
  const parsed = lastJsonObject(text)
  if (parsed === undefined) {
    const tail = text.trim().split('\n').slice(-2).join(' ').slice(0, 200)
    return { ok: false, reason: `loudnorm 没有输出可解析的 JSON${tail === '' ? '' : `（${tail}）`}` }
  }
  const inputI = Number(parsed.input_i)
  const inputTp = Number(parsed.input_tp)
  if (!Number.isFinite(inputI) || !Number.isFinite(inputTp)) {
    return { ok: false, reason: 'loudnorm JSON 里缺少 input_i / input_tp' }
  }
  return { ok: true, inputI, inputTp }
}

/** 检测每句起点附近的 silence_end（句间停顿的结束点）。 */
function detectSilenceEnds(file) {
  const result = run('ffmpeg', [
    '-hide_banner', '-nostats', '-i', file, '-map', '0:a:0',
    '-af', 'silencedetect=noise=-38dB:d=0.2', '-f', 'null', '-',
  ])
  const text = `${result.stdout}\n${result.stderr}`
  if (result.code !== 0) {
    const tail = text.trim().split('\n').slice(-2).join(' ').slice(0, 200)
    return { ok: false, reason: `silencedetect 执行失败${tail === '' ? '' : `（${tail}）`}` }
  }
  const ends = [...text.matchAll(/silence_end:\s*([0-9.]+)/gu)].map((match) => Number(match[1]))
  return { ok: true, ends }
}

/** 读 --expect-cues：scenes.json（scenes[].start）或 tts sidecar（segments[].start）。 */
function readExpectedCues(file) {
  if (!existsSync(file)) return { error: `找不到 --expect-cues 文件：${shortenPath(file)}` }
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { error: `--expect-cues 文件不是合法 JSON：${shortenPath(file)}` }
  }
  const list = Array.isArray(data?.scenes)
    ? data.scenes
    : Array.isArray(data?.segments)
      ? data.segments
      : Array.isArray(data)
        ? data
        : undefined
  if (list === undefined) {
    return { error: '--expect-cues 需要 scenes[]（网页场次）或 segments[]（tts sidecar）' }
  }
  const starts = list.map((item) => Number(item?.start)).filter((value) => Number.isFinite(value))
  if (starts.length === 0) return { error: '--expect-cues 文件里没有可用的 start 时间（scenes[].start / segments[].start）' }
  return { starts }
}

function verifyUsage() {
  out('用法：node scripts/mcs.mjs verify <file.mp4> [--expect-w 1080] [--expect-h 1920] [--expect-fps 30]')
  out('                                          [--expect-dur 40.5] [--expect-audio required|silent|optional]')
  out('                                          [--expect-lufs -16] [--expect-cues scenes.json]')
  out('  --expect-lufs  响度目标（默认 -16 LUFS，容差 ±1.0）；真峰必须 ≤ -1.0 dBTP')
  out('  --expect-cues  按 scenes[].start 或 segments[].start 校验语句落点（容差 0.4s）；')
  out('                 不给就明确打印「未校验语句落点」，不会假装通过。')
  out('  响度用 loudnorm 两遍法读 input_i / input_tp；解析失败算「分析失败」，和削波分开报。')
}

function verify(args) {
  const { values, positional } = parseFlags(args, {
    'expect-w': { type: 'string' },
    'expect-h': { type: 'string' },
    'expect-fps': { type: 'string' },
    'expect-dur': { type: 'string' },
    'expect-audio': { type: 'string' },
    'expect-lufs': { type: 'string' },
    'expect-cues': { type: 'string' },
  })
  const file = positional[0]
  if (values.help === true) {
    verifyUsage()
    return 0
  }
  if (file === undefined) {
    verifyUsage()
    return 2
  }

  // 先校验参数语法，避免跑到一半才发现参数错。
  const expectedNumbers = {
    'expect-w': { pattern: /^\d+$/u, hint: '--expect-w 必须是整数像素值' },
    'expect-h': { pattern: /^\d+$/u, hint: '--expect-h 必须是整数像素值' },
    'expect-fps': { pattern: /^\d+(?:\.\d+)?$/u, hint: '--expect-fps 必须是数字（例如 29.97）' },
    'expect-dur': { pattern: /^\d+(?:\.\d+)?$/u, hint: '--expect-dur 必须是秒数（例如 40.5）' },
    'expect-lufs': { pattern: /^-?\d+(?:\.\d+)?$/u, hint: '--expect-lufs 必须是数字（例如 -16）' },
  }
  for (const [name, rule] of Object.entries(expectedNumbers)) {
    const raw = values[name]
    if (raw !== undefined && !rule.pattern.test(raw)) {
      err(`${rule.hint}（收到：${raw}）`)
      return 2
    }
  }
  const expectedAudio = values['expect-audio'] ?? 'required'
  if (!['required', 'silent', 'optional'].includes(expectedAudio)) {
    err(`--expect-audio 只支持 required|silent|optional（收到：${expectedAudio}）`)
    return 2
  }

  const target = resolveArg(file)
  if (!existsSync(target)) {
    err(`找不到文件：${file}`)
    return 1
  }
  // 只查 ffprobe 不够：响度与语句落点都靠 ffmpeg，缺了要在这里说清楚，不能跑到一半才报错。
  if (!works('ffprobe', ['-version'])) {
    err('缺 ffprobe：无法读取分辨率/帧率/时长；先安装 ffmpeg（通常同时带 ffprobe）')
    return 1
  }
  if (!works('ffmpeg', ['-version'])) {
    err('缺 ffmpeg：响度与语句落点分析需要 ffmpeg；先安装 ffmpeg 再重跑 verify')
    return 1
  }

  const expectedWidth = values['expect-w'] ?? '1080'
  const expectedHeight = values['expect-h'] ?? '1920'
  const expectedFps = Number(values['expect-fps'] ?? '30')
  const expectedDuration = values['expect-dur'] === undefined ? undefined : Number(values['expect-dur'])
  const expectedLufs = values['expect-lufs'] === undefined ? -16 : Number(values['expect-lufs'])
  const expectCues = values['expect-cues'] === undefined ? undefined : resolveArg(values['expect-cues'])
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
    // 29.97 这类帧率不能四舍五入成整数比较：用浮点比较，容差 0.1。
    const [num, den] = String(video.r_frame_rate ?? '0/1').split('/')
    const actualFps = Number(den) > 0 ? Number(num) / Number(den) : Number(num)
    if (Number.isFinite(actualFps) && Math.abs(actualFps - expectedFps) <= 0.1) {
      ok('帧率', `${actualFps.toFixed(2)} fps`)
    } else {
      bad('帧率', `${Number.isFinite(actualFps) ? `${actualFps.toFixed(2)} fps` : String(video.r_frame_rate)}（期望 ${expectedFps}，容差 0.1）`)
    }
  }

  const format = ffprobeJson(target, ['-show_entries', 'format=duration'])
  const duration = Number(format?.format?.duration ?? '')
  if (expectedDuration === undefined) {
    ok('时长', Number.isFinite(duration) ? `${duration}s` : '未知')
  } else if (Number.isFinite(duration) && Math.abs(duration - expectedDuration) <= 0.15) {
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
    out('-- 响度（loudnorm 两遍法） --')
    const loudness = measureLoudness(target)
    if (!loudness.ok) {
      // 解析失败是「分析失败」，不是削波，两者不能混成一句话。
      bad('响度', `分析失败：${loudness.reason}`)
    } else {
      if (Math.abs(loudness.inputI - expectedLufs) <= 1.0) {
        ok('响度', `${loudness.inputI.toFixed(2)} LUFS（期望 ${Number(expectedLufs).toFixed(2)} ± 1.0）`)
      } else {
        bad('响度', `${loudness.inputI.toFixed(2)} LUFS（期望 ${Number(expectedLufs).toFixed(2)} ± 1.0）`)
      }
      if (loudness.inputTp <= -1.0) {
        ok('真峰', `${loudness.inputTp.toFixed(2)} dBTP ≤ -1.0`)
      } else {
        bad('真峰', `${loudness.inputTp.toFixed(2)} dBTP > -1.0，可能削波`)
      }
    }

    out('-- 语句落点 --')
    if (expectCues === undefined) {
      // 没有期望值就没法判定：明确写出来，不能用「全部通过」暗示已经检查过。
      out('  ⚠️  未校验语句落点：没有提供 --expect-cues（scenes.json 或 tts sidecar）。')
    } else {
      const expected = readExpectedCues(expectCues)
      if (expected.error !== undefined) {
        bad('语句落点', expected.error)
      } else {
        const detected = detectSilenceEnds(target)
        if (!detected.ok) {
          bad('语句落点', `分析失败：${detected.reason}`)
        } else {
          const tolerance = 0.4
          const unmatched = expected.starts.filter((start) => !detected.ends.some((end) => Math.abs(end - start) <= tolerance))
          if (unmatched.length === 0) {
            ok('语句落点', `${expected.starts.length} 个起点全部对齐（容差 ${tolerance}s）`)
          } else {
            const shown = unmatched.slice(0, 8).map((value) => `${value.toFixed(2)}s`).join(', ')
            bad('语句落点', `${unmatched.length}/${expected.starts.length} 个起点附近没有对应的 silence_end（容差 ${tolerance}s）：${shown}`)
          }
        }
      }
    }
  } else if (expectCues !== undefined) {
    bad('语句落点', '没有音轨，无法检测语句落点（但提供了 --expect-cues）')
  }

  out('')
  const cuesChecked = audio !== undefined && expectCues !== undefined
  if (fails === 0) {
    if (audio !== undefined && !cuesChecked) out('== ✅ 已检查项通过（语句落点未校验）==')
    else out('== ✅ 全部通过 ==')
    return 0
  }
  out(`== ❌ ${fails} 项不通过 ==`)
  return 1
}

// ---------------------------------------------------------------- check（HyperFrames 工程校验）

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

function checkUsage() {
  out('用法：node scripts/mcs.mjs check <OpenMotion 工程目录> [--json]')
  out('  hyperframes CLI 按多级顺序发现：HYPERFRAMES_CLI → install.json →')
  out('  $DSH_HOME/profiles/*/openmotion-onboarding.json → 已知安装目录直接探测。')
  out('  找不到时列出尝试过的位置；跑通时会打印用的是哪一条。')
  out('  CLI 输出无法解析时按失败退出（不会把“没校验到”当成通过）。')
}

function check(args) {
  const { values, positional } = parseFlags(args, { json: { type: 'boolean' } })
  const dir = positional[0]
  if (values.help === true) {
    checkUsage()
    return 0
  }
  if (dir === undefined) {
    checkUsage()
    return 2
  }
  const projectDir = resolveArg(dir)
  if (!existsSync(projectDir)) {
    err(`找不到工程目录：${dir}`)
    return 1
  }
  const discovery = discoverHyperframes()
  const cli = discovery.cli
  if (cli === undefined) {
    err('找不到 hyperframes CLI（OpenMotion 没装，或安装信息里没有可用的 applicationRoot）。')
    if (discovery.envMissing !== undefined) {
      err(`HYPERFRAMES_CLI 指向的 CLI 不存在：${shortenPath(discovery.envMissing)}`)
    }
    err('已尝试的 CLI 路径：')
    for (const item of discovery.attempted.slice(0, 12)) {
      err(`  - ${item.source}：${item.candidate === '' ? '（未提供路径）' : shortenPath(item.candidate)}`)
    }
    err('装好 Studio 后重跑；也可以设 HYPERFRAMES_CLI=<…/node_modules/hyperframes/bin/hyperframes.mjs>。')
    return 1
  }
  if (values.json !== true) {
    out(`== hyperframes check：${shortenPath(projectDir)} ==`)
    out(`  CLI：${shortenPath(cli)}（来源：${discovery.source}）`)
  }
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
  const passed = result.code === 0 && report.ok === true
  if (values.json === true) {
    out(JSON.stringify({ cli, cliSource: discovery.source, install: discovery.install, onboarding: discovery.onboarding, report }, null, 2))
  } else {
    out(`  通过：${passed === true ? '是' : '否'}${report.browserSkipped === true ? '（只做了静态检查，浏览器被跳过）' : ''}`)
    // 不能“先打印通过、再 exit 1”：report 说 ok 但 CLI 退出码非 0 时，按失败展示并解释原因。
    if (report.ok === true && result.code !== 0) {
      out(`  ! report.ok 为 true 但 CLI 退出码是 ${result.code}：按失败处理`)
    }
    for (const line of summariseCheck(report)) out(line)
  }
  return passed ? 0 : 1
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
  out('  node scripts/mcs.mjs page <项目目录> [--out x.html] [--force] [--style magazine|swiss]')
  out('                    [--theme <主题 id>] [--embed] [--brand "#76B900"] [--cap-fig "文件名:宽:高"]')
  out('  node scripts/mcs.mjs cards <任务目录> [--no-validate] [--allow-labels] [--seed editorial|swiss]')
  out('  node scripts/mcs.mjs brand "#76B900" [--family magazine|swiss] [--apply 文件.html] [--tokens]')
  out('  node scripts/mcs.mjs verify <file.mp4> [--expect-w 1080] [--expect-h 1920] [--expect-fps 30]')
  out('                    [--expect-dur 40.5] [--expect-audio required|silent|optional]')
  out('                    [--expect-lufs -16] [--expect-cues scenes.json]')
  out('  node scripts/mcs.mjs check <OpenMotion 工程目录> [--json]')
  out('')
  out('每个子命令都支持 --help；`--` 之后的参数一律当位置参数（但不能以 - 开头）。')
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
