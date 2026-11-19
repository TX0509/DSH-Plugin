import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/**
 * Guards the markdown tables against the corruption that hit README once: a
 * formatter dropped every `|`, leaving `cell   cell   cell` rows that render as
 * plain text. Tables here are documentation for humans, so a silent strip is a
 * real regression.
 */
const ROOT = new URL('..', import.meta.url)
const FILES = [
  'README.md',
  'INSTALL.md',
  'PLAN.md',
  ...readdirSync(new URL('../docs', import.meta.url))
    .filter((name) => name.endsWith('.md'))
    .map((name) => path.join('docs', name)),
]

/** A row that lost its delimiters: `v0.2.0   某事   ✅ …`, or `---   ---   ---`. */
const BROKEN_ROW = /^\s{0,2}(?:v\d[^\s]*|阶段|版本|配置项)\s{2,}\S/u
const BROKEN_SEPARATOR = /^\s{0,2}(?:---\s+)+---\s*$/u

function scan(file, problems) {
  const lines = readFileSync(new URL(file, ROOT), 'utf8').replace(/\r\n/gu, '\n').split('\n')
  let inFence = false
  for (const [index, line] of lines.entries()) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const trimmed = line.trim()
    if (BROKEN_ROW.test(line) || BROKEN_SEPARATOR.test(line)) {
      problems.push(`${file}:${String(index + 1)} 表格行丢了竖线：${trimmed.slice(0, 60)}`)
    }
    // A table row must be closed on both sides.
    if (trimmed.startsWith('|') && !trimmed.endsWith('|')) {
      problems.push(`${file}:${String(index + 1)} 表格行缺少结尾竖线`)
    }
  }
}

test('docs: markdown tables keep their pipe delimiters', () => {
  const problems = []
  for (const file of FILES) scan(file, problems)
  assert.deepEqual(problems, [])
})

test('docs: the README acceptance table lists the current version', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /^\| v0\.2\.1 \|/mu, 'README 需要记录 v0.2.1')
})
