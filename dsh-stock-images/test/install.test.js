import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const PLUGIN_DIR = resolve(import.meta.dirname, '..')
const SCRIPT = join(PLUGIN_DIR, 'scripts', 'install.mjs')
const PLUGIN_NAME = 'dsh-stock-images'

/** Create a throwaway DSH home with two empty profiles. */
async function createDshHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-stock-images-install-'))
  for (const profile of ['web', 'desktop']) {
    const dir = join(home, 'profiles', profile)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify(
        { name: `dsh-profile-${profile}`, dependencies: {}, dsh: { profile: { bundles: [] } } },
        null,
        2
      ) + '\n'
    )
  }
  return home
}

/** Run the installer with an isolated DSH_HOME. */
async function installer(home, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, ...args], {
      cwd: PLUGIN_DIR,
      env: { ...process.env, DSH_HOME: home },
      timeout: 60_000
    })
    return { code: 0, output: `${stdout}${stderr}` }
  } catch (error) {
    return { code: error.code ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

test('installer --check fails before installation and passes after it', async () => {
  const home = await createDshHome()
  try {
    const before = await installer(home, ['--check'])
    assert.equal(before.code, 1)
    assert.match(before.output, /FAIL/)

    const installed = await installer(home, [])
    assert.equal(installed.code, 0, installed.output)

    const after = await installer(home, ['--check'])
    assert.equal(after.code, 0, after.output)
    assert.match(after.output, /全部已安装/)

    for (const profile of ['web', 'desktop']) {
      const manifest = JSON.parse(await readFile(join(home, 'profiles', profile, 'package.json'), 'utf8'))
      assert.equal(manifest.dependencies[PLUGIN_NAME], `link:${PLUGIN_DIR.replace(/\\/g, '/')}`)
      assert.ok(manifest.dsh.profile.bundles.includes(PLUGIN_NAME))
      const stats = await lstat(join(home, 'profiles', profile, 'node_modules', PLUGIN_NAME))
      assert.ok(stats.isSymbolicLink() || stats.isDirectory())
    }

    const uninstalled = await installer(home, ['--uninstall'])
    assert.equal(uninstalled.code, 0, uninstalled.output)
    for (const profile of ['web', 'desktop']) {
      const manifest = JSON.parse(await readFile(join(home, 'profiles', profile, 'package.json'), 'utf8'))
      assert.equal(manifest.dependencies[PLUGIN_NAME], undefined)
      assert.equal(manifest.dsh.profile.bundles.includes(PLUGIN_NAME), false)
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('installer --dry-run changes nothing', async () => {
  const home = await createDshHome()
  try {
    const files = ['web', 'desktop'].map((profile) => join(home, 'profiles', profile, 'package.json'))
    const before = await Promise.all(files.map((file) => readFile(file, 'utf8')))

    const planned = await installer(home, ['--dry-run'])
    assert.equal(planned.code, 0, planned.output)
    assert.match(planned.output, /\[plan\]/)
    assert.match(planned.output, /未修改任何文件/)

    const after = await Promise.all(files.map((file) => readFile(file, 'utf8')))
    assert.deepEqual(after, before)
    for (const profile of ['web', 'desktop']) {
      await assert.rejects(lstat(join(home, 'profiles', profile, 'node_modules', PLUGIN_NAME)))
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('installer refuses an unknown profile and an unrelated manifest', async () => {
  const home = await createDshHome()
  try {
    const unknown = await installer(home, ['--profile', 'nope'])
    assert.equal(unknown.code, 1)
    assert.match(unknown.output, /profile 不存在/)

    const dir = join(home, 'profiles', 'web')
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'not-a-profile' }) + '\n')
    const unrelated = await installer(home, ['--profile', 'web'])
    assert.equal(unrelated.code, 1)
    assert.match(unrelated.output, /不是 DSH profile/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
