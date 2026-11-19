import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { contains, parseRange, safeResolve } from '../index.js'

const ROOT = path.resolve('C:\\tmp\\video-root')

test('parseRange: absent header means a full response', () => {
  assert.equal(parseRange(undefined, 1000), undefined)
  // An empty header is out of spec: ignore it rather than fail the request.
  assert.equal(parseRange('', 1000), 'unrecognized')
})

test('parseRange: closed, open-ended, and suffix forms', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 })
  assert.deepEqual(parseRange('bytes=100-', 1000), { start: 100, end: 999 })
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 })
  // The range unit is case-insensitive (RFC 9110 §2).
  assert.deepEqual(parseRange('BYTES=10-19', 1000), { start: 10, end: 19 })
})

test('parseRange: clamps an overlong end', () => {
  assert.deepEqual(parseRange('bytes=0-99999', 1000), { start: 0, end: 999 })
})

test('parseRange: unsatisfiable single ranges are reported separately from malformed ones', () => {
  // Valid syntax, nothing to serve: the caller answers 416.
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable')
  assert.equal(parseRange('bytes=5-1', 1000), 'unsatisfiable')
  // Ranges this server does not handle: the caller ignores them and answers 200.
  assert.equal(parseRange('bytes=-0', 1000), 'unrecognized')
  assert.equal(parseRange('bytes=-', 1000), 'unrecognized')
  assert.equal(parseRange('bytes=abc-def', 1000), 'unrecognized')
  assert.equal(parseRange('bytes=0-1,3-4', 1000), 'unrecognized')
  assert.equal(parseRange('bytes=0-1, 5-', 1000), 'unrecognized')
  assert.equal(parseRange('items=0-1', 1000), 'unrecognized')
  assert.equal(parseRange('bytes= 0-9', 1000), 'unrecognized')
})

test('safeResolve: accepts plain nested files', () => {
  assert.equal(safeResolve(ROOT, 'test.mp4'), path.join(ROOT, 'test.mp4'))
  assert.equal(safeResolve(ROOT, 'renders/v1.mp4'), path.join(ROOT, 'renders', 'v1.mp4'))
  assert.equal(safeResolve(ROOT, 'a\\b\\c.png'), path.join(ROOT, 'a', 'b', 'c.png'))
})

test('safeResolve: accepts Unicode and spaces inside a name', () => {
  assert.equal(safeResolve(ROOT, '中文 片段.mp4'), path.join(ROOT, '中文 片段.mp4'))
  assert.equal(safeResolve(ROOT, 'renders/第 1 集.mp4'), path.join(ROOT, 'renders', '第 1 集.mp4'))
})

test('safeResolve: rejects traversal, empty names, and deep paths', () => {
  assert.equal(safeResolve(ROOT, ''), undefined)
  assert.equal(safeResolve(ROOT, '../secret.txt'), undefined)
  assert.equal(safeResolve(ROOT, 'a/../../secret.txt'), undefined)
  assert.equal(safeResolve(ROOT, '..\\..\\secret.txt'), undefined)
  assert.equal(safeResolve(ROOT, 'C:\\Windows\\win.ini'), undefined)
  assert.equal(safeResolve(ROOT, 'a/b/c/d/e/f.mp4'), undefined)
  assert.equal(safeResolve(ROOT, '.hidden'), undefined)
  assert.equal(safeResolve(ROOT, 'a\0b.mp4'), undefined)
})

test('safeResolve: five segments fit the project layout', () => {
  assert.equal(safeResolve(ROOT, 'a/b/c/d/e.mp4'), path.join(ROOT, 'a', 'b', 'c', 'd', 'e.mp4'))
  assert.equal(safeResolve(ROOT, 'project/assets/scene/01.png'), path.join(ROOT, 'project', 'assets', 'scene', '01.png'))
})

test('safeResolve: rejects Windows-reserved and odd names', () => {
  assert.equal(safeResolve(ROOT, 'a:b.mp4'), undefined)
  assert.equal(safeResolve(ROOT, 'a*b.mp4'), undefined)
  assert.equal(safeResolve(ROOT, 'name.'), undefined)
  assert.equal(safeResolve(ROOT, 'name '), undefined)
  assert.equal(safeResolve(ROOT, 'x'.repeat(129) + '.mp4'), undefined)
})

test('safeResolve: rejects Windows device names with or without an extension', () => {
  for (const name of [
    'CON', 'con.mp4', 'PRN', 'AUX', 'NUL.txt', 'COM1', 'LPT9.mp4',
    'CONIN$', 'CONOUT$', 'CLOCK$', 'COM\u00b9',
  ]) {
    assert.equal(safeResolve(ROOT, name), undefined, `expected ${name} to be rejected`)
  }
  // Names that merely start with a device name are still legal.
  assert.equal(safeResolve(ROOT, 'console.mp4'), path.join(ROOT, 'console.mp4'))
  assert.equal(safeResolve(ROOT, 'com10.mp4'), path.join(ROOT, 'com10.mp4'))
})

test('contains: compares whole segments, not a ".." string prefix', () => {
  assert.equal(contains(ROOT, ROOT), false)
  assert.equal(contains(ROOT, path.join(ROOT, 'a.mp4')), true)
  // A child literally named "..cache" is inside the root, not a parent hop.
  assert.equal(contains(ROOT, path.join(ROOT, '..cache', 'x.mp4')), true)
  assert.equal(contains(ROOT, path.join(ROOT, '..', 'x.mp4')), false)
})
