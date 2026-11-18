#!/usr/bin/env node
/**
 * One-command check: typecheck -> build -> artifact consistency -> syntax -> tests.
 *
 * The artifact step fails when the committed index.js / client.js differ from a
 * fresh build, which is what keeps DSH from loading stale code.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const node = process.execPath
const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

function run(label, command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`\n[verify] ${label} failed (exit ${String(result.status)})`)
    process.exit(result.status ?? 1)
  }
  console.log(`[verify] ${label} ok`)
}

run('typecheck', node, [tsc, '--noEmit'])
run('build', node, ['scripts/build.mjs'])
run('artifact consistency', 'git', ['diff', '--exit-code', '--', 'index.js', 'client.js'])
run('syntax: index.js', node, ['--check', 'index.js'])
run('syntax: client.js', node, ['--check', 'client.js'])
run('tests', node, ['--test'])
console.log('[verify] all checks passed')
