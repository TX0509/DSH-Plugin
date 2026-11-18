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
 * Keep DSH coupling inside the adapter layer.
 *
 * - `shared/dsh.ts` is the hand-written type declaration module, so it names
 *   the services but runs no calls.
 * - `shared/routes.ts` is the wire contract, so it owns the page-global name.
 * - Everything else outside `adapters/` must not touch either.
 */
function checkDshBoundary() {
  const callPattern = /webServer|__ModuleLoader__|slots\./u
  const wirePattern = /__DSH_VIDEO_WORKBENCH__/u
  const offenders = []
  for (const relative of readdirSync(path.join(ROOT, 'src'), { recursive: true })) {
    const name = String(relative).replaceAll('\\', '/')
    if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue
    const adapter = name.includes('adapters/')
    const source = readFileSync(path.join(ROOT, 'src', name), 'utf8')
    if (!adapter && name !== 'shared/dsh.ts' && callPattern.test(source)) offenders.push(name)
    if (!adapter && name !== 'shared/dsh.ts' && name !== 'shared/routes.ts' && wirePattern.test(source)) {
      offenders.push(name)
    }
  }
  if (offenders.length > 0) {
    console.error(`\n[verify] dsh boundary failed: ${[...new Set(offenders)].join(', ')}`)
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
