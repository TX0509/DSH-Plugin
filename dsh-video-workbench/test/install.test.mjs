import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Drive scripts/install.mjs against a throwaway DSH_HOME. The real profile is
 * never touched, which is also why these tests can run unattended.
 */
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INSTALL_SCRIPT = path.join(PLUGIN_DIR, 'scripts', 'install.mjs')
const PLUGIN_NAME = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8')).name
const BASELINE_BUNDLE = '@deepseek-ai/dsh-base'

function setupHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dshvw-install-'))
  const profileDir = path.join(home, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  const manifestFile = path.join(profileDir, 'package.json')
  writeFileSync(manifestFile, `${JSON.stringify({
    name: 'install-test-profile',
    private: true,
    dsh: { profile: { bundles: [BASELINE_BUNDLE] } },
  }, null, 2)}\n`, 'utf8')
  return { home, profileDir, manifestFile }
}

function runInstall(home, args) {
  const result = spawnSync(process.execPath, [INSTALL_SCRIPT, ...args], {
    cwd: PLUGIN_DIR,
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const readManifest = (file) => JSON.parse(readFileSync(file, 'utf8'))
const linkPath = (profileDir) => path.join(profileDir, 'node_modules', PLUGIN_NAME)
const tempFiles = (dir) => readdirSync(dir).filter((name) => name.includes('.tmp-video-workbench-'))

/** Remove the junction first: a recursive delete must not walk into the plugin. */
function removeHome(home) {
  const link = path.join(home, 'profiles', 'desktop', 'node_modules', PLUGIN_NAME)
  if (existsSync(link)) {
    try {
      unlinkSync(link)
    } catch {
      try {
        rmdirSync(link)
      } catch {
        // Best effort; the recursive delete below retries.
      }
    }
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

test('install script: --check and --dry-run never touch the profile', () => {
  const { home, profileDir, manifestFile } = setupHome()
  try {
    const before = readFileSync(manifestFile, 'utf8')

    const check = runInstall(home, ['--check'])
    assert.equal(check.status, 1, 'an uninstalled profile must fail --check')
    assert.match(check.stdout, /\[FAIL\] desktop/u)

    const dryRun = runInstall(home, ['--dry-run'])
    assert.equal(dryRun.status, 0, dryRun.stdout + dryRun.stderr)
    assert.match(dryRun.stdout, /\[plan\] desktop/u)

    assert.equal(readFileSync(manifestFile, 'utf8'), before, '--dry-run must not write')
    assert.equal(existsSync(linkPath(profileDir)), false)
    assert.deepEqual(tempFiles(profileDir), [])
  } finally {
    removeHome(home)
  }
})

test('install script: installs atomically and passes --check', () => {
  const { home, profileDir, manifestFile } = setupHome()
  try {
    const installed = runInstall(home, ['--profile', 'desktop'])
    assert.equal(installed.status, 0, installed.stdout + installed.stderr)

    const manifest = readManifest(manifestFile)
    assert.ok(manifest.dsh.profile.bundles.includes(PLUGIN_NAME))
    assert.ok(manifest.dsh.profile.bundles.includes(BASELINE_BUNDLE), 'other bundles must survive')
    assert.match(String(manifest.dependencies?.[PLUGIN_NAME]), /^link:/u)
    assert.equal(existsSync(linkPath(profileDir)), true)
    assert.deepEqual(tempFiles(profileDir), [], 'no temp manifest may be left behind')

    const check = runInstall(home, ['--check'])
    assert.equal(check.status, 0, check.stdout + check.stderr)
    assert.match(check.stdout, /\[ok\] desktop/u)
  } finally {
    removeHome(home)
  }
})

test('install script: uninstall removes the link and both registrations', () => {
  const { home, profileDir, manifestFile } = setupHome()
  try {
    assert.equal(runInstall(home, ['--profile', 'desktop']).status, 0)
    const removed = runInstall(home, ['--uninstall', '--profile', 'desktop'])
    assert.equal(removed.status, 0, removed.stdout + removed.stderr)

    const manifest = readManifest(manifestFile)
    assert.equal(manifest.dsh.profile.bundles.includes(PLUGIN_NAME), false)
    assert.equal(manifest.dependencies?.[PLUGIN_NAME], undefined)
    assert.equal(existsSync(linkPath(profileDir)), false)
    assert.deepEqual(tempFiles(profileDir), [])
  } finally {
    removeHome(home)
  }
})

test('install script: rejects a profile name that escapes the profiles directory', () => {
  const { home } = setupHome()
  try {
    const result = runInstall(home, ['--profile', '../escape'])
    assert.equal(result.status, 1)
    assert.match(result.stdout + result.stderr, /profile 名非法|profile 不存在/u)
  } finally {
    removeHome(home)
  }
})
