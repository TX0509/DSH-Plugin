import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  MIN_NODE_MAJOR,
  chromeCandidates,
  listRuntimeDependencyDirs,
  majorOf,
  nodeCandidates,
  parseVersion,
  pickChrome,
  pickNode,
} from '../index.js'

const NODE_BIN = process.platform === 'win32' ? 'node.exe' : 'node'
const CHROME_REL = path.join('Google', 'Chrome', 'Application', 'chrome.exe')

test('parseVersion: accepts the shapes node and hyperframes print', () => {
  assert.equal(parseVersion('v24.19.0'), '24.19.0')
  assert.equal(parseVersion('node v24.19.0'), '24.19.0')
  assert.equal(parseVersion('24.19.0\n'), '24.19.0')
  assert.equal(parseVersion('v22.0.0-rc.1'), undefined, 'prerelease output is not a plain node version')
  assert.equal(parseVersion(''), undefined)
})

test('majorOf: leading component only, rejects nonsense', () => {
  assert.equal(majorOf('24.19.0'), 24)
  assert.equal(majorOf('22.0.1'), 22)
  assert.equal(majorOf('abc.1.0'), undefined)
})

test('nodeCandidates: managed runtime first, then DSH node, then PATH', () => {
  const candidates = nodeCandidates({
    runtimeDependencyDirs: ['C:/dsh/dsh-runtimes/primary/dependencies'],
    dshNodeExecutable: 'C:/Program Files/DSH/DeepSeek Harness.exe',
    pathEnv: ['C:/other/node', 'C:/usr/bin'].join(path.delimiter),
  })
  assert.deepEqual(candidates.map((candidate) => candidate.source), [
    'managed-runtime',
    'dsh-node-executable',
    'path',
    'path',
  ])
  assert.equal(candidates[0].path, path.join('C:/dsh/dsh-runtimes/primary/dependencies', 'node', 'bin', NODE_BIN))
})

test('nodeCandidates: duplicate paths keep the higher-priority source', () => {
  const candidates = nodeCandidates({ pathEnv: ['C:/n', 'C:/n'].join(path.delimiter) })
  assert.equal(candidates.length, 1)
})

test('nodeCandidates: the Electron binary carries ELECTRON_RUN_AS_NODE', () => {
  const candidates = nodeCandidates({ dshNodeExecutable: 'C:/Program Files/DSH/DeepSeek Harness.exe' })
  assert.equal(candidates.length, 1)
  assert.deepEqual(candidates[0].env, { ELECTRON_RUN_AS_NODE: '1' })
})

test('pickNode: skips a too-old node and picks the first acceptable one', () => {
  const candidates = [
    { path: '/old', source: 'managed-runtime' },
    { path: '/broken', source: 'path' },
    { path: '/good', source: 'path' },
  ]
  const picked = pickNode(candidates, (candidate) => {
    if (candidate.path === '/old') return { ok: true, version: 'v21.9.0' }
    if (candidate.path === '/broken') return { ok: false, error: 'ENOENT' }
    return { ok: true, version: 'v24.19.0' }
  })
  assert.equal(picked.chosen?.path, '/good')
  assert.deepEqual(picked.rejected.map((entry) => entry.reason), [
    `node 21 < ${MIN_NODE_MAJOR}`,
    'ENOENT',
  ])
})

test('pickNode: unparsable version is rejected, not accepted', () => {
  const picked = pickNode([{ path: '/x', source: 'path' }], () => ({ ok: true, version: 'weird' }))
  assert.equal(picked.chosen, undefined)
  assert.match(picked.rejected[0].reason, /无法解析版本/u)
})

test('pickNode: nothing usable reports every rejection and no choice', () => {
  const picked = pickNode([{ path: '/a', source: 'path' }], () => ({ ok: false, error: 'EACCES' }))
  assert.equal(picked.chosen, undefined)
  assert.equal(picked.rejected.length, 1)
})

test('chromeCandidates: configured path first, then Windows locations', () => {
  const candidates = chromeCandidates({
    configured: 'D:/Apps/Chrome/chrome.exe',
    env: {
      ProgramFiles: 'C:/Program Files',
      'ProgramFiles(x86)': 'C:/Program Files (x86)',
      LOCALAPPDATA: 'C:/Users/x/AppData/Local',
    },
  })
  assert.deepEqual(candidates.map((candidate) => candidate.source), [
    'configured',
    'program-files',
    'program-files-x86',
    'local-appdata',
  ])
  assert.equal(candidates[1].path, path.join('C:/Program Files', CHROME_REL))
})

test('chromeCandidates: environment keys are matched case-insensitively', () => {
  const candidates = chromeCandidates({ env: { PROGRAMFILES: 'C:/PF' } })
  assert.deepEqual(candidates.map((candidate) => candidate.source), ['program-files'])
})

test('chromeCandidates: same install reached through two roots is deduped', () => {
  const candidates = chromeCandidates({
    env: { ProgramFiles: 'C:/PF', 'ProgramFiles(x86)': 'C:/PF' },
  })
  assert.equal(candidates.length, 1)
})

test('pickChrome: the first existing candidate wins', () => {
  const picked = pickChrome([
    { path: 'C:/missing/chrome.exe', source: 'configured' },
    { path: 'C:/real/chrome.exe', source: 'program-files' },
  ], (candidatePath) => candidatePath.startsWith('C:/real'))
  assert.equal(picked.chosen?.source, 'program-files')
  assert.equal(picked.rejected.length, 1)
})

test('listRuntimeDependencyDirs: missing root is empty, existing dirs sorted', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dshvw-runtime-'))
  try {
    assert.deepEqual(listRuntimeDependencyDirs(home), [])
    for (const name of ['z-last', 'a-first']) {
      mkdirSync(path.join(home, 'dsh-runtimes', name, 'dependencies'), { recursive: true })
    }
    writeFileSync(path.join(home, 'dsh-runtimes', 'not-a-runtime.txt'), 'x', 'utf8')
    const dirs = listRuntimeDependencyDirs(home)
    assert.deepEqual(dirs, [
      path.join(home, 'dsh-runtimes', 'a-first', 'dependencies'),
      path.join(home, 'dsh-runtimes', 'z-last', 'dependencies'),
    ])
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
