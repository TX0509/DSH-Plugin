/**
 * 随包提供的技能命令行（assets/multichannel-story/scripts/mcs.mjs）冒烟测试：
 * 参数解析、子命令分发，以及两条“不能把没做当做了”的硬约束
 * （--out 不许覆盖源稿、check 解析失败必须失败退出）。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

