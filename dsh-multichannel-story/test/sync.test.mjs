/**
 * scripts/sync-assets.mjs 的安全约定：源不完整或源/目标重叠时必须失败，
 * 而且失败不能动现有副本。
 *
 * 所有用例都在临时复制出来的包目录里跑（node --test 并行执行测试文件，
 * 共享地修改真实 assets/ 会与 CLI 冒烟测试互相干扰）。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 临时复制一份插件包，返回它自己的 scripts/sync-assets.mjs 与 assets 目录。 */
function copyPackage(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mcs-sync-pkg-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  cpSync(PLUGIN_DIR, dir, { recursive: true })
  return {
    root: dir,
    script: join(dir, 'scripts', 'sync-assets.mjs'),
    assets: join(dir, 'assets', 'multichannel-story'),
  }
}

function runSync(pkg, source) {
  const result = source === undefined
    ? spawnSync(process.execPath, [pkg.script], { encoding: 'utf8', windowsHide: true })
    : spawnSync(process.execPath, [pkg.script, source], { encoding: 'utf8', windowsHide: true })
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/** 目录内容指纹（相对路径 + 内容哈希 + 大小），用来断言"没被改动"。 */
function fingerprint(dir) {
  const entries = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      const hash = createHash('sha256').update(readFileSync(full)).digest('hex')
      entries.push(`${full.slice(dir.length)}:${hash}:${statSync(full).size}`)
    }
  }
  walk(dir)
  return entries.sort().join('\n')
}

function makeSource(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'mcs-sync-src-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return dir
}

const COMPLETE_SOURCE_FILES = {
  'SKILL.md': '---\nname: multichannel-story\ndescription: 测试源\n---\n\n# 正文\n',
  'references/setup.md': '# setup\n',
  'references/page.md': '# page\n',
  'references/cards.md': '# cards\n',
  'references/video.md': '# video\n',
  'references/voice.md': '# voice\n',
  'scripts/mcs.mjs': '// mcs\n',
  'scripts/preflight.sh': '#!/usr/bin/env bash\n',
  'scripts/build-page.sh': '#!/usr/bin/env bash\n',
  'scripts/build-cards.sh': '#!/usr/bin/env bash\n',
  'scripts/brand-theme.sh': '#!/usr/bin/env bash\n',
  'scripts/verify-av.sh': '#!/usr/bin/env bash\n',
  'scripts/list-recipes.mjs': '// recipes\n',
  'scripts/page-post.mjs': '// page post\n',
  'scripts/tts.py': '# tts\n',
  'scripts/scaffold-video.py': '# scaffold\n',
  'scripts/install.sh': '#!/usr/bin/env bash\n# 不应进入副本\n',
}

test('源目录缺必需文件时失败，且现有副本原样保留', (t) => {
  const pkg = copyPackage(t)
  const before = fingerprint(pkg.assets)
  const source = makeSource(t, {
    'SKILL.md': '---\nname: multichannel-story\ndescription: 只有正文没有 references/scripts\n---\n\n# 正文\n',
  })

  const { code, output } = runSync(pkg, source)
  assert.equal(code, 1, output)
  assert.match(output, /缺少必需文件/u)
  assert.match(output, /现有副本未改动|未改动现有副本/u)
  assert.equal(fingerprint(pkg.assets), before, '失败时不得改动副本')
})

test('源目录等于副本目录时拒绝执行', (t) => {
  const pkg = copyPackage(t)
  const before = fingerprint(pkg.assets)
  const { code, output } = runSync(pkg, pkg.assets)
  assert.equal(code, 1, output)
  assert.match(output, /源目录就是副本目录|拒绝执行/u)
  assert.equal(fingerprint(pkg.assets), before)
})

test('源目录包含副本目录时拒绝执行', (t) => {
  const pkg = copyPackage(t)
  const before = fingerprint(pkg.assets)
  const { code, output } = runSync(pkg, pkg.root)
  assert.equal(code, 1, output)
  assert.match(output, /拒绝执行/u)
  assert.equal(fingerprint(pkg.assets), before)
})

test('副本路径换个大小写也算同一个目录（Windows 大小写不敏感）', (t) => {
  const pkg = copyPackage(t)
  const lowered = pkg.assets.toLowerCase()
  if (lowered === pkg.assets || !existsSync(lowered)) {
    t.skip('该文件系统区分大小写')
    return
  }
  writeFileSync(join(pkg.assets, 'EXTRA.md'), '# 用来证明副本没被删\n', 'utf8')
  const before = fingerprint(pkg.assets)

  const { code, output } = runSync(pkg, lowered)
  assert.equal(code, 1, output)
  assert.match(output, /同一个目录|拒绝执行/u)
  assert.equal(fingerprint(pkg.assets), before, '拒绝时副本必须原样保留')
  assert.ok(existsSync(join(pkg.assets, 'EXTRA.md')), '副本里的文件不得被静默删除')
})

test('通过目录链接指向副本时也算同一个目录', (t) => {
  const pkg = copyPackage(t)
  const alias = join(pkg.root, 'assets-alias')
  symlinkSync(pkg.assets, alias, process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(pkg.assets, 'EXTRA.md'), '# 用来证明副本没被删\n', 'utf8')
  const before = fingerprint(pkg.assets)

  const { code, output } = runSync(pkg, alias)
  assert.equal(code, 1, output)
  assert.match(output, /同一个目录|拒绝执行/u)
  assert.equal(fingerprint(pkg.assets), before, '拒绝时副本必须原样保留')
  assert.ok(existsSync(join(pkg.assets, 'EXTRA.md')))
})

test('正常源同步成功，排除 install.sh，且重复执行结果一致', (t) => {
  const pkg = copyPackage(t)
  const source = makeSource(t, COMPLETE_SOURCE_FILES)

  const first = runSync(pkg, source)
  assert.equal(first.code, 0, first.output)
  const manifest = JSON.parse(readFileSync(join(pkg.assets, 'MANIFEST.json'), 'utf8'))
  assert.equal(manifest.files['scripts/install.sh'], undefined, 'install.sh 必须被排除')
  assert.ok(manifest.files['scripts/mcs.mjs'], '清单应记录 mcs.mjs')
  assert.deepEqual(Object.keys(manifest.files), [...Object.keys(manifest.files)].sort(), '清单键应排序')
  const snapshot = fingerprint(pkg.assets)

  const second = runSync(pkg, source)
  assert.equal(second.code, 0, second.output)
  assert.equal(fingerprint(pkg.assets), snapshot, '重复同步应产生相同内容')
})

test('缺 SKILL.md 的源被拒绝', (t) => {
  const pkg = copyPackage(t)
  const source = makeSource(t, { 'references/setup.md': '# setup\n' })
  const { code, output } = runSync(pkg, source)
  assert.equal(code, 1, output)
  assert.match(output, /没有 SKILL\.md/u)
})
