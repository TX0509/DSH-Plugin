import assert from 'node:assert/strict'
import fs, { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Manifest-level contract: the fields DSH reads before it loads any plugin code.
 * These are cheap guards for mistakes that only show up as "plugin refuses to
 * activate" or "package is missing a runtime file after publishing".
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

/**
 * The tested DSH floor. This plugin is personal (not published), so the range is
 * open-ended: every newer DSH activates it, and a breaking DSH release shows up
 * as a failing startup self-check instead of a refused activation.
 * Widening or narrowing it is a deliberate act: update this assertion and
 * `docs/UPGRADE-PLAYBOOK.md` together.
 */
const TESTED_DSH_RANGE = '>=0.2.2-rc.5'

/** Files that must ship for the plugin to load and render. */
const RUNTIME_FILES = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'locale/zh.json',
  'locale/en.json',
  'README.md',
  'INSTALL.md',
  'LICENSE',
]

/** Does one `files` entry cover a package-relative path? */
function covers(entry, relative) {
  const normalized = entry.replaceAll('\\', '/').replace(/\/+$/u, '')
  if (normalized.includes('*')) {
    const pattern = normalized
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
      .join('[^/]*')
    return new RegExp(`^${pattern}$`, 'u').test(relative)
  }
  if (relative === normalized) return true
  // A directory entry covers everything below it.
  const { statSync } = fs
  try {
    return statSync(path.join(ROOT, normalized)).isDirectory() && relative.startsWith(`${normalized}/`)
  } catch {
    return false
  }
}

test('manifest: engines.dsh is the documented tested floor, not an exact pin', () => {
  assert.equal(manifest.engines?.dsh, TESTED_DSH_RANGE)
  assert.ok(manifest.engines?.node, 'engines.node must be declared')
  // An exact pin was what disabled the plugin on the rc.3 -> rc.5 nightly upgrade.
  assert.match(manifest.engines.dsh, /^>=/u, 'engines.dsh must be an open lower bound')
})

test('manifest: declares the bundle patch and the client platform', () => {
  assert.equal(manifest.dsh?.manifestVersion, 1)
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.ok(existsSync(path.join(ROOT, manifest.dsh.bundle.patch)), 'patch file must exist')
})

test('manifest: cordis.patch.yml inserts this package under a stable id', () => {
  const patch = readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /^- insert:/mu)
  assert.match(patch, new RegExp(`^[ \\t]+name: ${manifest.name}$`, 'mu'))
  assert.match(patch, /^[ \t]+- id: [\w-]+$/mu, 'the inserted row needs an id')
})

test('manifest: files covers every runtime file', () => {
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0)
  const missing = RUNTIME_FILES.filter((file) => !manifest.files.some((entry) => covers(entry, file)))
  assert.deepEqual(missing, [], `package files does not cover: ${missing.join(', ')}`)
  // npm always ships package.json itself, so it is not part of the `files` check.
  const absent = [...RUNTIME_FILES, 'package.json'].filter((file) => !existsSync(path.join(ROOT, file)))
  assert.deepEqual(absent, [], `declared runtime file missing on disk: ${absent.join(', ')}`)
})
