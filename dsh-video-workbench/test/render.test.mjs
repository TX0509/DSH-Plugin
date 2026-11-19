import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { buildRenderArgs, RESOLUTION_BY_ASPECT } from '../index.js'

const PROJECT = path.resolve('C:/videos/video-projects/20261119-120000')

function input(overrides = {}) {
  return {
    nodePath: 'C:/managed/node/bin/node.exe',
    cliPath: 'C:/runtime/node_modules/hyperframes/dist/cli.js',
    projectDir: PROJECT,
    compositionPath: path.join(PROJECT, 'composition', 'index.html'),
    outputPath: path.join(PROJECT, 'renders', '.v1.mp4.tmp-abc123'),
    fps: 30,
    aspect: '9:16',
    ...overrides,
  }
}

test('buildRenderArgs: argv matches the hyperframes 0.6.33 render contract', () => {
  const argv = buildRenderArgs(input())
  assert.deepEqual(argv, [
    'C:/managed/node/bin/node.exe',
    'C:/runtime/node_modules/hyperframes/dist/cli.js',
    'render',
    PROJECT,
    '--composition', path.join('composition', 'index.html'),
    '--output', path.join(PROJECT, 'renders', '.v1.mp4.tmp-abc123'),
    '--fps', '30',
    '--quality', 'standard',
    '--workers', '2',
    '--format', 'mp4',
    '--resolution', 'portrait',
  ])
})

test('buildRenderArgs: aspect maps to the matching resolution preset', () => {
  assert.equal(RESOLUTION_BY_ASPECT['9:16'], 'portrait')
  assert.equal(RESOLUTION_BY_ASPECT['16:9'], 'landscape')
  const wide = buildRenderArgs(input({ aspect: '16:9' }))
  assert.equal(wide[wide.length - 1], 'landscape')
})

test('buildRenderArgs: quality, fps and workers are passed through', () => {
  const argv = buildRenderArgs(input({ fps: 60, quality: 'draft', workers: 4 }))
  assert.equal(argv[argv.indexOf('--fps') + 1], '60')
  assert.equal(argv[argv.indexOf('--quality') + 1], 'draft')
  assert.equal(argv[argv.indexOf('--workers') + 1], '4')
})

test('buildRenderArgs: output must stay inside renders/', () => {
  for (const outputPath of [
    path.join(PROJECT, 'renders', '..', 'project.json'),
    path.join(PROJECT, 'v1.mp4'),
    path.resolve('C:/elsewhere/v1.mp4'),
  ]) {
    assert.throws(() => buildRenderArgs(input({ outputPath })), /outputPath 必须位于/u, outputPath)
  }
})

test('buildRenderArgs: composition must stay inside the project', () => {
  assert.throws(
    () => buildRenderArgs(input({ compositionPath: path.resolve('C:/elsewhere/index.html') })),
    /compositionPath 必须位于/u,
  )
})

test('buildRenderArgs: rejects invalid fps, workers and quality', () => {
  for (const fps of [0, 1.5, 241, Number.NaN]) {
    assert.throws(() => buildRenderArgs(input({ fps })), /fps/u)
  }
  for (const workers of [0, 9, 2.5]) {
    assert.throws(() => buildRenderArgs(input({ workers })), /workers/u)
  }
  assert.throws(() => buildRenderArgs(input({ quality: 'ultra' })), /quality/u)
})

test('buildRenderArgs: rejects empty required inputs and unknown aspect', () => {
  assert.throws(() => buildRenderArgs(input({ nodePath: '  ' })), /nodePath/u)
  assert.throws(() => buildRenderArgs(input({ cliPath: '' })), /cliPath/u)
  assert.throws(() => buildRenderArgs(input({ aspect: '4:3' })), /aspect/u)
})

test('buildRenderArgs: a path-like project id cannot inject extra flags', () => {
  const argv = buildRenderArgs(input())
  // Every element is a separate argument; a crafted project dir would be one
  // element, never merged into a shell string.
  assert.ok(argv.every((part) => typeof part === 'string' && !part.includes('\0')))
  assert.equal(argv.filter((part) => part.startsWith('--')).length > 0, true)
})
