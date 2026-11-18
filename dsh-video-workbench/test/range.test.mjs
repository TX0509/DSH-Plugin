import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { parseRange, safeResolve } from '../index.js'

const ROOT = path.resolve('C:\\tmp\\video-root')

test('parseRange: absent header means a full response', () => {
  assert.equal(parseRange(undefined, 1000), undefined)
  assert.equal(parseRange('', 1000), 'invalid')
})

test('parseRange: closed, open-ended, and suffix forms', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 })
  assert.deepEqual(parseRange('bytes=100-', 1000), { start: 100, end: 999 })
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 })
})

test('parseRange: clamps an overlong end', () => {
  assert.deepEqual(parseRange('bytes=0-99999', 1000), { start: 0, end: 999 })
})

test('parseRange: rejects unsatisfiable and malformed ranges', () => {
  assert.equal(parseRange('bytes=1000-', 1000), 'invalid')
  assert.equal(parseRange('bytes=5-1', 1000), 'invalid')
  assert.equal(parseRange('bytes=-0', 1000), 'invalid')
  assert.equal(parseRange('bytes=-', 1000), 'invalid')
  assert.equal(parseRange('items=0-1', 1000), 'invalid')
  assert.equal(parseRange('bytes=abc-def', 1000), 'invalid')
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
