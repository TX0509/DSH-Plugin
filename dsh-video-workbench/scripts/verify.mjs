#!/usr/bin/env node
/**
 * One-command check: typecheck -> DSH boundary -> build -> artifact consistency
 * -> syntax -> tests.
 *
 * The artifact step fails when the committed index.js / client.js differ from a
 * fresh build, which is what keeps DSH from loading stale code.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
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

/**
 * Keep DSH coupling inside the adapter layer. `shared/dsh.ts` is the
 * hand-written type declaration module, so it is allowed to name the services;
 * business modules must not.
 */
function checkDshBoundary() {
  const offenders = []
  for (const relative of readdirSync(path.join(ROOT, 'src'), { recursive: true })) {
    const name = String(relative).replaceAll('\\', '/')
    if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue
    if (name.includes('adapters/') || name === 'shared/dsh.ts') continue
    const source = readFileSync(path.join(ROOT, 'src', name), 'utf8')
    if (/webServer|__ModuleLoader__|slots\.|__DSH_VIDEO_WORKBENCH__/u.test(source)) offenders.push(name)
  }
  if (offenders.length > 0) {
    console.error(`\n[verify] dsh boundary failed: ${offenders.join(', ')}`)
    process.exit(1)
  }
  console.log('[verify] dsh boundary ok')
}

run('typecheck', node, [tsc, '--noEmit'])
checkDshBoundary()
run('build', node, ['scripts/build.mjs'])
run('artifact consistency', 'git', ['diff', '--exit-code', '--', 'index.js', 'client.js'])
run('syntax: index.js', node, ['--check', 'index.js'])
run('syntax: client.js', node, ['--check', 'client.js'])
run('tests', node, ['--test'])
console.log('[verify] all checks passed')
