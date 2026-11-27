/**
 * 跨平台（macOS / Windows）回归测试。
 *
 * 没有 Windows 真机，就把「Windows 上一定会坏」的几件事做成可执行的证据：
 *   1. 行尾：CRLF 检出的副本也要通过 MANIFEST 校验（哈希先归一化）；
 *   2. 约定：文本按 LF 检入、图片按二进制；
 *   3. 代码：不读 `process.env.HOME`、不通过 shell 起子进程、安装器在 Windows 用 junction；
 *   4. 文档：README 有「支持平台」小节并点名 macOS / Windows。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import assetHash from '../scripts/asset-hash.cjs'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 与 scripts/check-package.cjs 共用同一份跨平台审计，避免测试里再抄一份清单/正则。
const { auditPlatform } = createRequire(import.meta.url)(join(PLUGIN_DIR, 'scripts', 'platform-audit.cjs'))
const read = (relative) => readFileSync(join(PLUGIN_DIR, relative), 'utf8')

function copyPackage(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mcs-platform-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  cpSync(PLUGIN_DIR, dir, { recursive: true })
  return dir
}

const runNode = (cwd, args) => {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true })
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

test('哈希：CRLF 与 LF 的文本文件哈希一致，二进制仍按原始字节', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcs-hash-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const lf = join(dir, 'doc.md')
  const crlf = join(dir, 'doc-crlf.md')
  writeFileSync(lf, '# 标题\n\n正文\n', 'utf8')
  writeFileSync(crlf, '# 标题\r\n\r\n正文\r\n', 'utf8')
  assert.equal(assetHash.hashFile(crlf), assetHash.hashFile(lf), 'CRLF 检出不应该让清单失配')

  const pngA = join(dir, 'a.png')
  const pngB = join(dir, 'b.png')
  writeFileSync(pngA, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))
  writeFileSync(pngB, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0b]))
  assert.notEqual(assetHash.hashFile(pngA), assetHash.hashFile(pngB), '二进制不能做归一化')
})

test('哈希：非法 UTF-8 的文件不做有损归一化', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcs-hash-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const crlf = join(dir, 'broken-crlf.md')
  const lf = join(dir, 'broken-lf.md')
  writeFileSync(crlf, Buffer.from([0x23, 0x20, 0xff, 0x0d, 0x0a]))
  writeFileSync(lf, Buffer.from([0x23, 0x20, 0xff, 0x0a]))
  assert.notEqual(assetHash.hashFile(crlf), assetHash.hashFile(lf), '非法 UTF-8 必须按原始字节比较')
})

test('Windows 模拟：CRLF 检出仍能通过 LF 记录的 MANIFEST 校验', (t) => {
  const dir = copyPackage(t)
  const assets = join(dir, 'assets', 'multichannel-story')
  const target = join(assets, 'SKILL.md')
  const before = JSON.parse(readFileSync(join(assets, 'MANIFEST.json'), 'utf8')).files['SKILL.md']
  // 模拟 core.autocrlf=true 的检出：内容换成 CRLF，MANIFEST 保持仓库里的 LF 哈希不动。
  // 没有哈希归一化时，这一步在 Windows 上会让整个 `assets match MANIFEST` 失配。
  // 先归一化再转：工作副本本来就是 CRLF 时（Windows 上属性还没生效），直接 replace 会得到 \r\r\n，
  // 而归一化只认 \r\n，残留的 \r 会让这条测试在它要验证的平台上自己挂掉。
  const lfText = readFileSync(target, 'utf8').replace(/\r\n/gu, '\n')
  writeFileSync(target, lfText.replace(/\n/gu, '\r\n'), 'utf8')

  const check = runNode(dir, [join(dir, 'scripts', 'check-package.cjs'), dir])
  assert.equal(check.code, 0, check.output)
  assert.match(check.output, /assets match MANIFEST/u)

  // 重算清单是幂等的：CRLF 检出的工作副本算出来的哈希要与 LF 记录一致，
  // 否则每台 Windows 机器一跑 `--manifest-only` 就会改出一个假 diff。
  const resync = runNode(dir, [join(dir, 'scripts', 'sync-assets.mjs'), '--manifest-only'])
  assert.equal(resync.code, 0, resync.output)
  const after = JSON.parse(readFileSync(join(assets, 'MANIFEST.json'), 'utf8')).files['SKILL.md']
  assert.equal(after, before, 'CRLF 与 LF 必须算出同一个哈希')
})

test('.gitattributes：文本 LF、图片二进制', () => {
  const file = join(PLUGIN_DIR, '.gitattributes')
  assert.ok(existsSync(file), '缺 .gitattributes 时 Windows 会把文本检出成 CRLF')
  const text = readFileSync(file, 'utf8')
  assert.match(text, /\*\s+text=auto\s+eol=lf/u)
  for (const ext of ['png', 'jpg', 'jpeg', 'ico']) {
    assert.match(text, new RegExp(`\\*\\.${ext}\\s+binary`, 'u'), `${ext} 必须按二进制`)
  }
})

test('跨平台静态审计全过（与 check-package 共用同一实现）', () => {
  const results = auditPlatform(PLUGIN_DIR)
  assert.ok(results.length >= 7, `审计项太少：${results.map((item) => item.label).join(' / ')}`)
  for (const item of results) {
    assert.ok(item.ok, `${item.label}${item.detail === undefined ? '' : ` — ${item.detail}`}`)
  }
  // 家目录解析必须能在 Windows 上工作：这里直接调用同一套逻辑，至少证明 import 与调用成立。
  assert.ok(homedir().length > 0)
})

test('审计能抓住违规：$HOME 与缺失的 .gitattributes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcs-audit-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'scripts', 'bad.mjs'), 'const home = process.env.HOME\n', 'utf8')

  const results = auditPlatform(dir)
  const home = results.find((item) => item.label.includes('os.homedir'))
  assert.equal(home.ok, false, '$HOME 必须被判违规')
  assert.match(home.detail, /scripts\/bad\.mjs/u)
  const attributes = results.find((item) => item.label.includes('.gitattributes pins'))
  assert.equal(attributes.ok, false, '缺 .gitattributes 必须被判违规')
})

test('README 明确声明支持平台', () => {
  const readme = read('README.md')
  assert.match(readme, /^## 支持平台$/mu)
  assert.match(readme, /macOS/u)
  assert.match(readme, /Windows/u)
  assert.match(read('INSTALL.md'), /2\.1 按平台安装/u)
})
