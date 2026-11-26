/**
 * scripts/install.mjs 的行为测试：全程使用临时 DSH_HOME，不碰真实 profile。
 * 覆盖 AGENTS.md 8.1 要求的 --check / --dry-run，以及安装 → 检查 → 卸载闭环、
 * 外来链接保护与 --force 重建。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INSTALL_SCRIPT = join(PLUGIN_DIR, 'scripts', 'install.mjs')
const PLUGIN_NAME = 'dsh-multichannel-story'
const DEP_SPEC = 'link:' + PLUGIN_DIR.replace(/\\/g, '/')

/** 真实路径比较：只在 Windows 上忽略大小写。 */
function samePath(left, right) {
  const normalize = (value) => {
    const resolved = realpathSync(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

function makeDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 一个假 DSH_HOME，里面只有一个 web profile。 */
function fakeDshHome(t) {
  const home = makeDir(t, 'mcs-install-')
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, null, 2) + '\n', 'utf8')
  return { home, profileDir, manifestPath: join(profileDir, 'package.json'), linkPath: join(profileDir, 'node_modules', PLUGIN_NAME) }
}

function runInstall(home, args) {
  const result = spawnSync(process.execPath, [INSTALL_SCRIPT, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, DSH_HOME: home },
  })
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

const readManifest = (file) => JSON.parse(readFileSync(file, 'utf8'))

/** 另一个"安装来源"目录，用来模拟链接指向别处。 */
function foreignCheckout(t) {
  const dir = makeDir(t, 'mcs-other-')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: PLUGIN_NAME, version: '0.0.0' }, null, 2), 'utf8')
  return dir
}

function linkTo(target, linkPath) {
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

test('--check 在未安装时报告未就绪且不改动文件', (t) => {
  const { home, profileDir, manifestPath } = fakeDshHome(t)
  const before = readFileSync(manifestPath, 'utf8')
  const { code, output } = runInstall(home, ['--check'])
  assert.equal(code, 1, output)
  assert.match(output, /\[FAIL\] web/u)
  assert.equal(readFileSync(manifestPath, 'utf8'), before, '--check 不应写 package.json')
  assert.ok(!existsSync(join(profileDir, 'node_modules', PLUGIN_NAME)), '--check 不应创建链接')
})

test('--dry-run 只打印计划，不落盘', (t) => {
  const { home, profileDir, manifestPath } = fakeDshHome(t)
  const before = readFileSync(manifestPath, 'utf8')
  const { code, output } = runInstall(home, ['--dry-run'])
  assert.equal(code, 0, output)
  assert.match(output, /\[plan\] web/u)
  assert.equal(readFileSync(manifestPath, 'utf8'), before)
  assert.ok(!existsSync(join(profileDir, 'node_modules', PLUGIN_NAME)))
})

test('安装后 --check 通过，链接指向本插件目录且 bundle 已登记', (t) => {
  const { home, profileDir, manifestPath, linkPath } = fakeDshHome(t)
  const installed = runInstall(home, [])
  assert.equal(installed.code, 0, installed.output)

  const profile = readManifest(manifestPath)
  assert.ok(profile.dsh.profile.bundles.includes(PLUGIN_NAME), 'bundles 应登记插件')
  assert.equal(profile.dependencies[PLUGIN_NAME], DEP_SPEC)
  assert.ok(existsSync(linkPath), '应创建 node_modules 链接')
  assert.ok(samePath(linkPath, PLUGIN_DIR))

  const checked = runInstall(home, ['--check'])
  assert.equal(checked.code, 0, checked.output)
  assert.match(checked.output, /\[ok\] web: 已安装/u)
})

test('--uninstall 移除链接与登记，并保留 manifest 备份', (t) => {
  const { home, profileDir, manifestPath, linkPath } = fakeDshHome(t)
  assert.equal(runInstall(home, []).code, 0)

  const removed = runInstall(home, ['--uninstall'])
  assert.equal(removed.code, 0, removed.output)

  const profile = readManifest(manifestPath)
  assert.ok(!profile.dsh.profile.bundles.includes(PLUGIN_NAME))
  assert.equal(profile.dependencies?.[PLUGIN_NAME], undefined)
  assert.ok(!existsSync(linkPath), '链接应被移除')

  const backups = readdirSync(profileDir).filter((name) => name.startsWith('package.json.bak-multichannel-story-'))
  assert.ok(backups.length >= 2, `应有安装与卸载两次备份，实际 ${backups.join(', ')}`)
})

test('--uninstall 遇到指向别处的链接时拒绝动手（不留孤儿登记）', (t) => {
  const { home, profileDir, manifestPath, linkPath } = fakeDshHome(t)
  const other = foreignCheckout(t)
  linkTo(other, linkPath)
  writeFileSync(manifestPath, JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: { [PLUGIN_NAME]: DEP_SPEC },
    dsh: { profile: { bundles: [PLUGIN_NAME] } },
  }, null, 2) + '\n', 'utf8')
  const before = readFileSync(manifestPath, 'utf8')

  const { code, output } = runInstall(home, ['--uninstall'])
  assert.equal(code, 1, output)
  assert.match(output, /不是本插件目录|链接指向/u)
  assert.ok(existsSync(linkPath), '指向别处的链接必须保留')
  assert.ok(samePath(linkPath, other), '链接目标不应被改动')
  assert.equal(readFileSync(manifestPath, 'utf8'), before, '拒绝时不得改动登记（否则留下孤儿安装）')
  assert.equal(readdirSync(profileDir).filter((name) => name.includes('.bak-multichannel-story-')).length, 0, '拒绝时不应产生备份')
})

test('复制式安装（真实目录）不会被当成链接删除', (t) => {
  const { home, manifestPath, linkPath } = fakeDshHome(t)
  mkdirSync(linkPath, { recursive: true })
  writeFileSync(join(linkPath, 'package.json'), '{"name":"' + PLUGIN_NAME + '"}\n', 'utf8')

  const checked = runInstall(home, ['--check'])
  assert.equal(checked.code, 1, checked.output)
  assert.match(checked.output, /真实目录|复制式/u)

  const forced = runInstall(home, ['--force'])
  assert.equal(forced.code, 1, forced.output)
  assert.match(forced.output, /真实目录|复制式/u)
  assert.ok(existsSync(join(linkPath, 'package.json')), '真实目录里的文件不得被删')

  // 复制式安装同样会登记 bundles/dependencies；卸载时也必须先拒绝，而不是删登记留目录。
  writeFileSync(manifestPath, JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: { [PLUGIN_NAME]: DEP_SPEC },
    dsh: { profile: { bundles: [PLUGIN_NAME] } },
  }, null, 2) + '\n', 'utf8')
  const registered = readFileSync(manifestPath, 'utf8')

  const removed = runInstall(home, ['--uninstall'])
  assert.equal(removed.code, 1, removed.output)
  assert.match(removed.output, /真实目录|复制式/u)

  assert.equal(readFileSync(manifestPath, 'utf8'), registered, '复制式安装失败时不得改动 profile')
  assert.ok(existsSync(join(linkPath, 'package.json')))
})

test('链接受别的目录占用时安装被拒绝，--force 才会重建', (t) => {
  const { home, manifestPath, linkPath } = fakeDshHome(t)
  const other = foreignCheckout(t)
  linkTo(other, linkPath)

  const blocked = runInstall(home, [])
  assert.equal(blocked.code, 1, blocked.output)
  assert.match(blocked.output, /--force/u)
  assert.ok(samePath(linkPath, other), '未加 --force 时不得替换链接')

  const forced = runInstall(home, ['--force'])
  assert.equal(forced.code, 0, forced.output)
  assert.ok(samePath(linkPath, PLUGIN_DIR), '--force 后应指向本插件目录')
  assert.ok(readManifest(manifestPath).dsh.profile.bundles.includes(PLUGIN_NAME))
})

test('未知 profile 名被拒绝（含路径穿越）', (t) => {
  const { home } = fakeDshHome(t)
  for (const name of ['nope', '../escape', '..']) {
    const { code, output } = runInstall(home, ['--profile', name])
    assert.equal(code, 1, `${name} 应被拒绝：${output}`)
    assert.match(output, /profile (不存在|名)/u)
  }
})

test('profile package.json 带 BOM 也能读取', (t) => {
  const { home, manifestPath } = fakeDshHome(t)
  writeFileSync(manifestPath, '\uFEFF' + readFileSync(manifestPath, 'utf8'), 'utf8')
  const { code, output } = runInstall(home, ['--check'])
  assert.equal(code, 1, output) // 未安装 → FAIL，但不应该抛解析错误
  assert.match(output, /\[FAIL\] web/u)
  assert.ok(!/JSON|Unexpected token/u.test(output), output)
})
