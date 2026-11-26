/**
 * check-package.cjs 自身的负例测试：检验它真的会失败，而不是"永远通过"。
 * 在临时目录里复制一份包，改动副本后运行检查；真实包不被修改。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('缺 SKILL.md 时给一条 FAIL 而不是抛栈', (t) => {
  const dir = copyPackage(t)
  rmSync(join(dir, 'assets', 'multichannel-story', 'SKILL.md'))
  const { code, output } = runCheck(dir)
  assert.equal(code, 1, output)
  assert.match(output, /FAIL bundled SKILL\.md exists/u)
  assert.ok(!/at Object\.<anonymous>/u.test(output), output)
})
