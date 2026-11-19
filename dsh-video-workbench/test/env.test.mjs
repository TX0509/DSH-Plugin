import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { buildRenderEnv } from '../index.js'

const NODE_DIR = path.join('C:', 'managed', 'node', 'bin')

test('buildRenderEnv: only allowlisted host variables survive', () => {
  const env = buildRenderEnv({
    baseEnv: {
      PATH: 'C:/windows/system32',
      SystemRoot: 'C:/Windows',
      TEMP: 'C:/Temp',
      USERPROFILE: 'C:/Users/x',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--inspect',
      npm_config_registry: 'https://example.invalid',
      PNPM_HOME: 'C:/pnpm',
      DSH_PROFILE: 'desktop',
      RANDOM_THING: 'x',
    },
    nodeBinDir: NODE_DIR,
  })
  assert.equal(env.SystemRoot, 'C:/Windows')
  assert.equal(env.TEMP, 'C:/Temp')
  assert.equal(env.USERPROFILE, 'C:/Users/x')
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'npm_config_registry', 'PNPM_HOME', 'DSH_PROFILE', 'RANDOM_THING']) {
    assert.equal(key in env, false, `${key} must not be inherited`)
  }
})

test('buildRenderEnv: the managed node dir leads PATH', () => {
  const env = buildRenderEnv({
    baseEnv: { Path: 'C:/windows/system32' },
    nodeBinDir: NODE_DIR,
  })
  assert.equal(env.Path, [NODE_DIR, 'C:/windows/system32'].join(path.delimiter))
})

test('buildRenderEnv: missing PATH becomes the node dir alone', () => {
  const env = buildRenderEnv({ baseEnv: {}, nodeBinDir: NODE_DIR })
  assert.equal(env[Object.keys(env).find((key) => key.toUpperCase() === 'PATH')], NODE_DIR)
})

test('buildRenderEnv: hyperframes stays offline by default', () => {
  const env = buildRenderEnv({ baseEnv: {}, nodeBinDir: NODE_DIR })
  assert.equal(env.HYPERFRAMES_NO_AUTO_INSTALL, '1')
  assert.equal(env.HYPERFRAMES_NO_TELEMETRY, '1')
  assert.equal(env.HYPERFRAMES_NO_UPDATE_CHECK, '1')
  assert.equal('HYPERFRAMES_BROWSER_PATH' in env, false, 'no browser configured → no override')
})

test('buildRenderEnv: a configured browser is passed to hyperframes', () => {
  const env = buildRenderEnv({
    baseEnv: {},
    nodeBinDir: NODE_DIR,
    browserPath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  })
  assert.equal(env.HYPERFRAMES_BROWSER_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe')
})

test('buildRenderEnv: extra variables win, empty host values are dropped', () => {
  const env = buildRenderEnv({
    baseEnv: { TEMP: '', PATH: 'C:/x' },
    nodeBinDir: NODE_DIR,
    extra: { HYPERFRAMES_EXTRACT_CACHE_DIR: 'C:/cache' },
  })
  assert.equal('TEMP' in env, false, 'empty host value must not survive')
  assert.equal(env.HYPERFRAMES_EXTRACT_CACHE_DIR, 'C:/cache')
})

test('buildRenderEnv: is deterministic and does not mutate the input', () => {
  const baseEnv = { PATH: 'C:/x', ELECTRON_RUN_AS_NODE: '1' }
  const first = buildRenderEnv({ baseEnv, nodeBinDir: NODE_DIR })
  const second = buildRenderEnv({ baseEnv, nodeBinDir: NODE_DIR })
  assert.deepEqual(first, second)
  assert.deepEqual(baseEnv, { PATH: 'C:/x', ELECTRON_RUN_AS_NODE: '1' })
})
