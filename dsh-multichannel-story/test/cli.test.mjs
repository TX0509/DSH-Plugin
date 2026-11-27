/**
 * 随包提供的技能命令行（assets/multichannel-story/scripts/mcs.mjs）测试：
 * 参数解析、子命令分发，以及几条“不能把没做当做了”的硬约束
 * （--out 不许覆盖源稿/项目外/符号链接、check 解析失败必须失败退出、
 *  cards 的比例标注与校验器缺失、brand 缺参数、verify 的帧率容差/响度分析/语句落点）。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MCS = join(PLUGIN_DIR, 'assets', 'multichannel-story', 'scripts', 'mcs.mjs')

function run(args, env) {
  const result = spawnSync(process.execPath, [MCS, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: env === undefined ? process.env : { ...process.env, ...env },
  })
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function makeTempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 一个最小项目目录：page 只校验这两个输入就够（渲染前就该被拦住）。 */
function makeProject(t) {
  const dir = makeTempDir(t, 'mcs-cli-')
  writeFileSync(join(dir, 'article.md'), '# 原文\n', 'utf8')
  writeFileSync(join(dir, 'annotations.json'), '{}\n', 'utf8')
  return dir
}

/** 假的 hyperframes CLI：只按给定内容输出，让 check 的解析分支可测。 */
function makeStubCli(t, body) {
  const dir = makeTempDir(t, 'mcs-hf-')
  const file = join(dir, 'hyperframes.mjs')
  writeFileSync(file, body, 'utf8')
  return file
}

test('--help 打印用法并成功退出', () => {
  const { code, output } = run(['--help'])
  assert.equal(code, 0, output)
  assert.match(output, /mcs\.mjs/u)
})

test('不带子命令打印用法并以 2 退出', () => {
  const { code, output } = run([])
  assert.equal(code, 2, output)
  assert.match(output, /preflight/u)
})

test('未知子命令以 2 退出', () => {
  const { code, output } = run(['definitely-not-a-command'])
  assert.equal(code, 2, output)
  assert.match(output, /未知子命令/u)
})

test('原型链上的名字不被当成子命令', () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const { code, output } = run([name])
    assert.equal(code, 2, `${name} 不应被当成子命令：${output}`)
    assert.match(output, /未知子命令/u)
  }
})

test('未知参数以 2 退出', () => {
  const { code, output } = run(['page', '.', '--not-a-flag'])
  assert.equal(code, 2, output)
  assert.match(output, /未知参数/u)
})

test('page --help 不写文件也能成功退出', () => {
  const { code, output } = run(['page', '--help'])
  assert.equal(code, 0, output)
  assert.match(output, /--cap-fig/u)
  assert.match(output, /\.html/u, '帮助里要写清 --out 必须是 .html')
})

test('page --out 指向 article.md 时拒绝，且源稿一个字都不变', (t) => {
  const dir = makeProject(t)
  const before = readFileSync(join(dir, 'article.md'), 'utf8')
  const { code, output } = run(['page', dir, '--out', 'article.md'])
  assert.equal(code, 2, output)
  assert.match(output, /不能指向 article\.md|不能指向输入文件/u)
  assert.equal(readFileSync(join(dir, 'article.md'), 'utf8'), before, '源稿不得被渲染器覆盖')
})

test('page --out 指向 annotations.json 时拒绝', (t) => {
  const dir = makeProject(t)
  const before = readFileSync(join(dir, 'annotations.json'), 'utf8')
  const { code, output } = run(['page', dir, '--out', join(dir, 'annotations.json')])
  assert.equal(code, 2, output)
  assert.match(output, /annotations\.json/u)
  assert.equal(readFileSync(join(dir, 'annotations.json'), 'utf8'), before)
})

test('page --out 不带 .html 后缀时拒绝', (t) => {
  const dir = makeProject(t)
  const { code, output } = run(['page', dir, '--out', 'notes.md'])
  assert.equal(code, 2, output)
  assert.match(output, /\.html/u)
})

test('check --help 说明 hyperframes 的来源', () => {
  const { code, output } = run(['check', '--help'])
  assert.equal(code, 0, output)
  assert.match(output, /install\.json|hyperframes/u)
})

test('check：CLI 输出无法解析时失败，不当作通过', (t) => {
  const project = makeTempDir(t, 'mcs-check-')
  const cli = makeStubCli(t, 'console.log("all good, trust me")\nprocess.exit(0)\n')
  const { code, output } = run(['check', project], { HYPERFRAMES_CLI: cli })
  assert.equal(code, 1, output)
  assert.match(output, /不能当作通过/u)
})

test('check：CLI 不存在时失败（而不是跳过）', (t) => {
  const project = makeTempDir(t, 'mcs-check-')
  const { code, output } = run(['check', project], { HYPERFRAMES_CLI: join(project, 'missing-cli.mjs') })
  assert.equal(code, 1, output)
  assert.match(output, /不能当作通过|找不到/u)
})

test('check：JSON 报 ok=false 时失败，ok=true 时通过', (t) => {
  const project = makeTempDir(t, 'mcs-check-')
  const failing = makeStubCli(t, [
    'console.log(JSON.stringify({ ok: false, lint: { ok: false, errorCount: 1, warningCount: 0, findings: [{ severity: "error", code: "x", message: "bad" }] } }))',
    'process.exit(0)',
  ].join('\n'))
  const failed = run(['check', project], { HYPERFRAMES_CLI: failing })
  assert.equal(failed.code, 1, failed.output)
  assert.match(failed.output, /通过：否/u)

  const passing = makeStubCli(t, [
    'console.log(JSON.stringify({ ok: true, lint: { ok: true, errorCount: 0, warningCount: 0, findings: [] } }))',
    'process.exit(0)',
  ].join('\n'))
  const passed = run(['check', project], { HYPERFRAMES_CLI: passing })
  assert.equal(passed.code, 0, passed.output)
  assert.match(passed.output, /通过：是/u)
})

/** 假的 guizang 插件根目录：只提供 page 需要的 render.mjs，按 FAKE_RENDER_MODE 输出三种页面。 */
function makeFakeGuizangRoot(t) {
  const root = makeTempDir(t, 'mcs-gz-')
  const scripts = join(root, 'skills', 'guizang-page-skill', 'scripts')
  mkdirSync(scripts, { recursive: true })
  writeFileSync(join(scripts, 'render.mjs'), [
    'import { writeFileSync } from "node:fs"',
    'const out = process.argv[4]',
    'const FOOTER = \'<footer><p>归藏 Page · Built with constrained HTML</p></footer>\'',
    'const variants = {',
    '  ok: "<html><head><title>t</title></head><body><p>正文</p>" + FOOTER + "</body></html>",',
    '  "footer-left": \'<html><head></head><body><footer class="site"><p>归藏 Page · Built with constrained HTML</p></footer></body></html>\',',
    '  "no-head": "<html><body><p>x</p></body></html>",',
    '}',
    'writeFileSync(out, variants[process.env.FAKE_RENDER_MODE] ?? variants.ok)',
  ].join('\n'), 'utf8')
  return root
}

test('page：页脚真的删掉、竖图 CSS 真的插进去', (t) => {
  const dir = makeProject(t)
  const gz = makeFakeGuizangRoot(t)
  const { code, output } = run(
    ['page', dir, '--out', 'out.html', '--cap-fig', 'p.jpg:660:840'],
    { GZ_ROOT: gz, FAKE_RENDER_MODE: 'ok' },
  )
  assert.equal(code, 0, output)
  assert.match(output, /页脚清理 1 处；人像收窄规则 1 条/u)
  const html = readFileSync(join(dir, 'out.html'), 'utf8')
  assert.ok(!html.includes('constrained HTML'), '页脚必须真的没了')
  assert.match(html, /task-figure-tuning/u)
})

test('page：页脚结构变了、品牌串还在时失败退出', (t) => {
  const dir = makeProject(t)
  const gz = makeFakeGuizangRoot(t)
  const { code, output } = run(
    ['page', dir, '--out', 'out.html'],
    { GZ_ROOT: gz, FAKE_RENDER_MODE: 'footer-left' },
  )
  assert.equal(code, 1, output)
  assert.match(output, /仍然有工具品牌页脚/u)
})

test('page：没有 </head> 时拒绝假装插入了竖图 CSS', (t) => {
  const dir = makeProject(t)
  const gz = makeFakeGuizangRoot(t)
  const { code, output } = run(
    ['page', dir, '--out', 'out.html', '--cap-fig', 'p.jpg:660:840'],
    { GZ_ROOT: gz, FAKE_RENDER_MODE: 'no-head' },
  )
  assert.equal(code, 1, output)
  assert.match(output, /没有 <\/head>/u)
})


// ---------------------------------------------------------------- --out 的边界

test('page --out 指向项目外时拒绝（不许覆盖别的项目）', (t) => {
  const dir = makeProject(t)
  const outside = makeTempDir(t, 'mcs-outside-')
  writeFileSync(join(outside, 'keep.html'), '<html>别人的页面</html>', 'utf8')
  const { code, output } = run(['page', dir, '--out', join(outside, 'keep.html')])
  assert.equal(code, 2, output)
  assert.match(output, /项目目录内/u)
  assert.equal(readFileSync(join(outside, 'keep.html'), 'utf8'), '<html>别人的页面</html>', '项目外的文件不得被覆盖')
})

test('page --out 已存在：默认拒绝，--force 才覆盖项目内普通文件', (t) => {
  const dir = makeProject(t)
  const gz = makeFakeGuizangRoot(t)
  writeFileSync(join(dir, 'out.html'), '旧内容', 'utf8')

  const blocked = run(['page', dir, '--out', 'out.html'], { GZ_ROOT: gz, FAKE_RENDER_MODE: 'ok' })
  assert.equal(blocked.code, 2, blocked.output)
  assert.match(blocked.output, /已存在/u)
  assert.equal(readFileSync(join(dir, 'out.html'), 'utf8'), '旧内容', '没加 --force 不得覆盖')

  const forced = run(['page', dir, '--out', 'out.html', '--force'], { GZ_ROOT: gz, FAKE_RENDER_MODE: 'ok' })
  assert.equal(forced.code, 0, forced.output)
  assert.ok(readFileSync(join(dir, 'out.html'), 'utf8').includes('正文'))
})

test('page --out 指向符号链接时拒绝，且链接目标不被改写', (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows 创建符号链接需要额外权限')
    return
  }
  const dir = makeProject(t)
  const gz = makeFakeGuizangRoot(t)
  const before = readFileSync(join(dir, 'article.md'), 'utf8')
  symlinkSync(join(dir, 'article.md'), join(dir, 'out.html'))

  const { code, output } = run(['page', dir, '--out', 'out.html'], { GZ_ROOT: gz, FAKE_RENDER_MODE: 'ok' })
  assert.equal(code, 2, output)
  // 符号链接 realpath 后就是 article.md：两种拒绝理由都算对，关键是不能写。
  assert.match(output, /符号链接|article\.md.*annotations\.json|不能指向/u)
  assert.equal(readFileSync(join(dir, 'article.md'), 'utf8'), before, '符号链接不能把渲染结果写到源稿上')
})

test('page 打印的是导出 argv（JSON），不是可粘贴的 shell 命令', (t) => {
  const dir = makeProject(t)
  const gz = makeFakeGuizangRoot(t)
  const { code, output } = run(['page', dir, '--out', 'out.html'], { GZ_ROOT: gz, FAKE_RENDER_MODE: 'ok' })
  assert.equal(code, 0, output)
  assert.match(output, /导出 argv/u)
  assert.match(output, /导出 argv[^\n]*\["/u)
  // 回归：以前打印 `导出：node "…" "…"`，项目名里的 $(…) 会被 agent 复制执行。
  assert.ok(!/导出：node "/u.test(output), '不应再打印可直接粘贴的 shell 命令')
})

test('page --cap-fig 的文件名不能注入 HTML/CSS', (t) => {
  const dir = makeProject(t)
  const { code, output } = run(['page', dir, '--cap-fig', 'x</style><script>alert(1)</script>.jpg:660:840'])
  assert.equal(code, 2, output)
  assert.match(output, /不能包含|HTML\/CSS/u)
})

// ---------------------------------------------------------------- brand

test('brand 缺颜色参数是用法错误（退出码 2，不是静默成功）', () => {
  const { code, output } = run(['brand'])
  assert.equal(code, 2, output)
  assert.match(output, /缺少品牌色参数/u)
})

test('brand --tokens 输出三个颜色 token；与 --apply 互斥', (t) => {
  const tokens = run(['brand', '#76B900', '--tokens'])
  assert.equal(tokens.code, 0, tokens.output)
  const parsed = JSON.parse(tokens.output.trim())
  for (const key of ['paper', 'ink', 'accent']) {
    assert.match(parsed[key], /^#[0-9a-fA-F]{6}$/u, `${key} 必须是 6 位 hex`)
  }

  const dir = makeProject(t)
  const both = run(['brand', '#76B900', '--tokens', '--apply', join(dir, 'p.html')])
  assert.equal(both.code, 2, both.output)
  assert.match(both.output, /不能和 --apply 一起用/u)
})

// ---------------------------------------------------------------- cards

/** 假的 guizang 插件根：卡片渲染/校验都用桩，避免依赖 playwright 与真实模板。 */
function makeFakeCardRoot(t, { validate } = {}) {
  const root = makeTempDir(t, 'mcs-gz-card-')
  const cardRoot = join(root, 'skills', 'guizang-social-card-skill')
  mkdirSync(join(cardRoot, 'scripts'), { recursive: true })
  mkdirSync(join(cardRoot, 'assets'), { recursive: true })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  // render.mjs：往 output/ 写一张 1x1 PNG，证明"有产物"。
  writeFileSync(join(cardRoot, 'scripts', 'render.mjs'), [
    'import { mkdirSync, writeFileSync } from "node:fs"',
    'import { join } from "node:path"',
    'mkdirSync(join(process.cwd(), "output"), { recursive: true })',
    `writeFileSync(join(process.cwd(), "output", "xhs-01.png"), Buffer.from("${png.toString('base64')}", "base64"))`,
  ].join('\n'), 'utf8')
  if (validate !== false) {
    writeFileSync(join(cardRoot, 'validate-social-deck.mjs'), 'process.exit(0)\n', 'utf8')
  }
  writeFileSync(join(cardRoot, 'assets', 'template-editorial-card.html'), '<html><!-- POSTERS_HERE --></html>\n', 'utf8')
  writeFileSync(join(cardRoot, 'assets', 'template-swiss-card.html'), '<html><!-- POSTERS_HERE --></html>\n', 'utf8')
  return root
}

test('cards：画面上有比例/尺寸标注时默认失败，--allow-labels 才放行', (t) => {
  const gz = makeFakeCardRoot(t)
  const task = makeTempDir(t, 'mcs-cards-')
  writeFileSync(join(task, 'index.html'), '<html><body><p>21:9 封面</p></body></html>', 'utf8')

  const blocked = run(['cards', task], { GZ_ROOT: gz })
  assert.equal(blocked.code, 1, blocked.output)
  assert.match(blocked.output, /比例\/尺寸标注/u)

  const allowed = run(['cards', task, '--allow-labels'], { GZ_ROOT: gz })
  assert.equal(allowed.code, 0, allowed.output)
  assert.ok(existsSync(join(task, 'output', 'xhs-01.png')))
})

test('cards：校验器缺失时报“没跑起来”，不是“校验有 FAIL”', (t) => {
  const gz = makeFakeCardRoot(t, { validate: false })
  const task = makeTempDir(t, 'mcs-cards-')
  writeFileSync(join(task, 'index.html'), '<html><body><p>正常文案</p></body></html>', 'utf8')
  const { code, output } = run(['cards', task], { GZ_ROOT: gz })
  assert.equal(code, 1, output)
  assert.match(output, /校验器没跑起来/u)
  assert.ok(!/校验有 FAIL/u.test(output), '不能把“文件缺失”误报成“校验失败”')
})

test('cards：只有 seed 模板时退出码 3（未渲染 ≠ 成功）', (t) => {
  const gz = makeFakeCardRoot(t)
  const task = makeTempDir(t, 'mcs-cards-')
  const { code, output } = run(['cards', task], { GZ_ROOT: gz })
  assert.equal(code, 3, output)
  assert.match(output, /未渲染/u)
  assert.ok(existsSync(join(task, 'index.html')))
})

// ---------------------------------------------------------------- verify

/** 在临时目录里放 node 桩 ffprobe/ffmpeg，验证 verify 的判定逻辑（不依赖真实媒体）。 */
function makeFakeMediaTools(t, options = {}) {
  const bin = makeTempDir(t, 'mcs-bin-')
  const fps = options.fps ?? '30/1'
  const loudness = options.loudness ?? '{"input_i":"-15.9","input_tp":"-2.0"}'
  const silenceEnds = options.silenceEnds ?? [0.2, 1.8]
  const ffprobe = `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ')
if (args.includes('width,height,r_frame_rate')) {
  console.log(JSON.stringify({ streams: [{ width: 1080, height: 1920, r_frame_rate: ${JSON.stringify(fps)} }] }))
} else if (args.includes('format=duration')) {
  console.log(JSON.stringify({ format: { duration: '3.0' } }))
} else if (args.includes('codec_name')) {
  console.log(JSON.stringify({ streams: [{ codec_name: 'aac', channels: 2, sample_rate: '48000' }] }))
} else {
  console.log(JSON.stringify({}))
}
`
  const ffmpeg = `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ')
if (args.includes('loudnorm')) {
  ${options.loudnessBroken === true ? "console.error('loudnorm blew up'); process.exit(0)" : `console.error(${JSON.stringify(`[Parsed_loudnorm_0] ${loudness}`)})`}
} else if (args.includes('silencedetect')) {
  console.error(${JSON.stringify(silenceEnds.map((end) => `[silencedetect] silence_end: ${end.toFixed(6)}`).join('\n'))})
}
process.exit(0)
`
  for (const [name, body] of [['ffprobe', ffprobe], ['ffmpeg', ffmpeg]]) {
    const file = join(bin, name)
    writeFileSync(file, body, 'utf8')
    chmodSync(file, 0o755)
  }
  return bin
}

const skipWindowsShims = (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows 上造 POSIX 可执行桩不稳定，交给 macOS/Linux CI')
    return true
  }
  return false
}

test('verify：29.97 帧率用浮点比较（容差 0.1，不再四舍五入成 30）', (t) => {
  if (skipWindowsShims(t)) return
  const bin = makeFakeMediaTools(t, { fps: '30000/1001' })
  const file = join(makeTempDir(t, 'mcs-mp4-'), 'clip.mp4')
  writeFileSync(file, 'not really an mp4', 'utf8')
  const { code, output } = run(['verify', file, '--expect-fps', '29.97'], { PATH: `${bin}${delimiter}${process.env.PATH}` })
  assert.equal(code, 0, output)
  assert.match(output, /29\.97 fps/u)
})

test('verify：响度解析失败报“分析失败”，不与削波混为一谈', (t) => {
  if (skipWindowsShims(t)) return
  const bin = makeFakeMediaTools(t, { loudnessBroken: true })
  const file = join(makeTempDir(t, 'mcs-mp4-'), 'clip.mp4')
  writeFileSync(file, 'not really an mp4', 'utf8')
  const { code, output } = run(['verify', file], { PATH: `${bin}${delimiter}${process.env.PATH}` })
  assert.equal(code, 1, output)
  assert.match(output, /分析失败/u)
  assert.ok(!/可能削波/u.test(output), '读取失败不能报成削波')
})

test('verify：--expect-cues 对不上时判失败；没给就明确说“未校验语句落点”', (t) => {
  if (skipWindowsShims(t)) return
  const bin = makeFakeMediaTools(t, { silenceEnds: [0.2, 1.8] })
  const dir = makeTempDir(t, 'mcs-mp4-')
  const file = join(dir, 'clip.mp4')
  writeFileSync(file, 'not really an mp4', 'utf8')
  const cues = join(dir, 'scenes.json')
  writeFileSync(cues, JSON.stringify({ scenes: [{ start: 0.2 }, { start: 2.6 }] }), 'utf8')

  const env = { PATH: `${bin}${delimiter}${process.env.PATH}` }
  const failed = run(['verify', file, '--expect-cues', cues], env)
  assert.equal(failed.code, 1, failed.output)
  assert.match(failed.output, /语句落点/u)

  const unchecked = run(['verify', file], env)
  assert.equal(unchecked.code, 0, unchecked.output)
  assert.match(unchecked.output, /未校验语句落点/u)
  assert.match(unchecked.output, /已检查项通过（语句落点未校验）/u)
})

test('参数解析：`--` 之后的位置参数不会被当成旗标', (t) => {
  const dir = makeProject(t)
  const { code } = run(['page', '--', dir])
  // 位置参数只有项目目录，--out 走默认名；没有 guizang 插件时失败点是找不到插件（退出 1），不是参数错误（2）。
  assert.notEqual(code, 2)
})
