/**
 * check-package.cjs 自身的负例测试：检验它真的会失败，而不是"永远通过"。
 * 在临时目录里复制一份包，改动副本后运行检查；真实包不被修改。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function copyPackage(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mcs-check-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  cpSync(PLUGIN_DIR, dir, { recursive: true })
  return dir
}

function runCheck(dir) {
  const result = spawnSync(process.execPath, [join(dir, 'scripts', 'check-package.cjs'), dir], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

test('原样副本通过检查', (t) => {
  const { code, output } = runCheck(copyPackage(t))
  assert.equal(code, 0, output)
  assert.match(output, /all checks passed/u)
})

test('手改技能副本会被 MANIFEST 哈希抓住', (t) => {
  const dir = copyPackage(t)
  const target = join(dir, 'assets', 'multichannel-story', 'scripts', 'mcs.mjs')
  writeFileSync(target, `${readFileSync(target, 'utf8')}\n// tampered\n`, 'utf8')
  const { code, output } = runCheck(dir)
  assert.equal(code, 1, output)
  assert.match(output, /changed scripts\/mcs\.mjs/u)
})

test('缺 INSTALL.md、个人绝对路径、图标问题都会被判失败', (t) => {
  const dir = copyPackage(t)
  rmSync(join(dir, 'INSTALL.md'))
  const readme = join(dir, 'README.md')
  writeFileSync(readme, `${readFileSync(readme, 'utf8')}\n个人路径示例：C:\\Users\\someone\\repo\n`, 'utf8')
  writeFileSync(join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text>图标</text></svg>', 'utf8')
  const { code, output } = runCheck(dir)
  assert.equal(code, 1, output)
  assert.match(output, /FAIL files\[\] entries exist — INSTALL\.md/u)
  assert.match(output, /FAIL no personal absolute paths in docs\/code/u)
  assert.match(output, /FAIL icon has no <text>/u)
})

test('跨平台约定缺失会被判失败（.gitattributes / 支持平台声明）', (t) => {
  const dir = copyPackage(t)
  rmSync(join(dir, '.gitattributes'))
  const readme = join(dir, 'README.md')
  writeFileSync(readme, readFileSync(readme, 'utf8').replace('## 支持平台', '## 平台说明'), 'utf8')
  const { code, output } = runCheck(dir)
  assert.equal(code, 1, output)
  assert.match(output, /\.gitattributes pins text files to LF/u)
  assert.match(output, /README has a supported-platform section/u)
})

test('README 图片：扩展名不符或越出包目录都会失败', (t) => {
  const dir = copyPackage(t)
  // PNG 内容改成 .jpg 扩展名
  renameSync(join(dir, 'docs', 'workbench.png'), join(dir, 'docs', 'workbench.jpg'))
  const readme = join(dir, 'README.md')
  writeFileSync(readme, readFileSync(readme, 'utf8').replace('docs/workbench.png', 'docs/workbench.jpg'), 'utf8')
  const mismatch = runCheck(dir)
  assert.equal(mismatch.code, 1, mismatch.output)
  assert.match(mismatch.output, /FAIL README images match their extension/u)

  // 越界路径不能被当成「包内图片」
  const dir2 = copyPackage(t)
  const readme2 = join(dir2, 'README.md')
  writeFileSync(readme2, readFileSync(readme2, 'utf8').replace('docs/workbench.png', 'docs/../../outside.png'), 'utf8')
  const escape = runCheck(dir2)
  assert.equal(escape.code, 1, escape.output)
  assert.match(escape.output, /FAIL README images exist/u)
})

test('package.json 的 files 覆盖自检依赖的文件', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'))
  const files = manifest.files ?? []
  // .gitattributes 决定 LF 检入，check-package 会硬性要求它；它不在 files 里时
  // npm 不会打包隐藏文件，装到别处跑 check 就会失败（曾经真的漏过）。
  assert.ok(files.includes('.gitattributes'), 'files 必须包含 .gitattributes')
  for (const dir of ['scripts', 'assets', 'docs', 'test']) {
    assert.ok(files.includes(dir), `files 必须包含 ${dir}`)
  }
})

/** 找一条能用的 npm：优先 npm_execpath（npm test 时由 npm 注入），否则试 PATH 里的 npm。 */
function npmCommand() {
  const cli = process.env.npm_execpath
  if (cli !== undefined && /\.c?js$/u.test(cli)) return [process.execPath, cli]
  const probe = spawnSync('npm', ['--version'], { encoding: 'utf8', windowsHide: true })
  return probe.status === 0 ? ['npm', null] : null
}

test('npm pack 产物包含自检要求的文件（防 files 漏项）', (t) => {
  const command = npmCommand()
  if (command === null) {
    t.skip('找不到可用的 npm，跳过打包检查')
    return
  }
  const [bin, cli] = command
  const args = [...(cli === null ? [] : [cli]), 'pack', '--dry-run', '--json']
  const result = spawnSync(bin, args, { cwd: PLUGIN_DIR, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`)
  const packed = JSON.parse(result.stdout)[0].files.map((file) => file.path)
  for (const required of [
    '.gitattributes',
    'client.js',
    'index.js',
    'cordis.patch.yml',
    'docs/workbench.png',
    'scripts/asset-hash.cjs',
    'scripts/platform-audit.cjs',
    'scripts/sync-themes.mjs',
    'scripts/theme-block.cjs',
    'assets/multichannel-story/SKILL.md',
  ]) {
    assert.ok(packed.includes(required), `打包产物缺少 ${required}：检查 package.json 的 files`)
  }
})

test('缺 SKILL.md 时给一条 FAIL 而不是抛栈', (t) => {
  const dir = copyPackage(t)
  rmSync(join(dir, 'assets', 'multichannel-story', 'SKILL.md'))
  const { code, output } = runCheck(dir)
  assert.equal(code, 1, output)
  assert.match(output, /FAIL bundled SKILL\.md exists/u)
  assert.ok(!/at Object\.<anonymous>/u.test(output), output)
})
