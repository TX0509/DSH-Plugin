#!/usr/bin/env node
/**
 * One-shot render smoke test against the *installed* runtime.
 *
 * Creates a throwaway project with two scenes (10 s total), renders it through
 * the same job manager the plugin uses, verifies duration/size with ffprobe and
 * prints the result. This is the M2 acceptance helper; it needs the runtime to
 * be installed first (plugin UI "安装运行时" or a normal plugin start with
 * `autoInstallRuntime`).
 *
 *   node scripts/render-smoke.mjs            # 10 s 9:16, draft quality
 *   node scripts/render-smoke.mjs --keep     # keep the temp project for inspection
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  buildRenderEnv,
  createJobManager,
  createProject,
  readSupplied,
  resolveInstallTools,
  runtimeState,
} from '../index.js'

const keep = process.argv.includes('--keep')
const runtimeDir = process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, 'cache', 'dsh-video-workbench', 'runtime')
  : path.join(os.homedir(), '.dsh', 'cache', 'dsh-video-workbench', 'runtime')

if (runtimeState(runtimeDir) !== 'ready') {
  console.error(`渲染运行时未安装：${runtimeDir}`)
  console.error('先在插件浮层点「安装运行时」，或按 INSTALL.md 手动安装。')
  process.exit(1)
}
const supplied = readSupplied(runtimeDir)
const tools = resolveInstallTools({
  dshHome: path.join(os.homedir(), '.dsh'),
  dshNodeExecutable: process.env.DSH_NODE_EXECUTABLE,
  pathEnv: process.env.PATH,
  buildEnv: (nodeBinDir, extra) => buildRenderEnv({
    baseEnv: process.env,
    nodeBinDir,
    ...(extra === undefined ? {} : { extra }),
  }),
})
if (tools === undefined) {
  console.error('找不到 node ≥22 或托管 pnpm')
  process.exit(1)
}
const chromePath = process.env.HYPERFRAMES_BROWSER_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'dshvw-smoke-projects-'))
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dshvw-smoke-data-'))
const created = createProject(projectsRoot, {
  title: 'M2 渲染冒烟',
  aspect: '9:16',
  fps: 30,
  scenes: [
    { id: 's1', text: '第一段画面', durationSec: 4, media: { kind: 'none' }, voice: { speed: 1 }, captions: { enabled: true } },
    { id: 's2', text: '第二段画面', durationSec: 6, media: { kind: 'none' }, voice: { speed: 1 }, captions: { enabled: true } },
  ],
})
if (!created.ok) {
  console.error('创建示例项目失败', created.errors)
  process.exit(1)
}

const manager = createJobManager({
  runtimeDir,
  projectsRoot,
  dataDir,
  timeoutMs: 10 * 60 * 1000,
  workers: 2,
  quality: 'draft',
  keepRenders: 5,
  logger: { info: (message) => console.log('[log]', message), error: (message) => console.error('[err]', message) },
  nodePath: tools.nodePath,
  renderEnv: buildRenderEnv({
    baseEnv: process.env,
    nodeBinDir: path.dirname(tools.nodePath),
    browserPath: chromePath,
  }),
})
const started = manager.start(created.project.id)
if (!started.ok) {
  console.error('无法开始渲染：', started.error)
  process.exit(1)
}
console.log(`job ${started.job.id}（hyperframes ${supplied?.versions.hyperframes ?? '?'}）`)

let lastPhase = ''
const deadline = Date.now() + 10 * 60 * 1000
let finalJob
while (Date.now() < deadline) {
  const job = manager.get(started.job.id)
  if (job !== undefined) {
    if (job.phase !== lastPhase) {
      console.log(`  ${job.status}/${job.phase} ${job.percent}%`)
      lastPhase = job.phase
    }
    if (['succeeded', 'failed', 'cancelled', 'timedOut'].includes(job.status)) {
      finalJob = job
      break
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1000))
}
await manager.dispose()

let ok = finalJob?.status === 'succeeded'
if (ok) {
  const renders = path.join(projectsRoot, created.project.id, 'renders')
  const index = JSON.parse(readFileSync(path.join(renders, 'index.json'), 'utf8'))
  const entry = index[0]
  console.log(`产物：${path.join(renders, entry.file)}`)
  console.log(`校验：${entry.durationSec}s · ${entry.width}x${entry.height} · ${entry.bytes} bytes`)
  ok = Math.abs(Number(entry.durationSec) - 10) < 0.05 && Number(entry.width) === 1080 && Number(entry.height) === 1920
  if (!ok) console.error('产物参数不符：期望 10s / 1080x1920')
}
if (!keep) {
  rmSync(projectsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
} else {
  console.log(`临时项目保留在：${projectsRoot}`)
}
if (!ok) {
  console.error('渲染冒烟失败：', JSON.stringify(finalJob, null, 2))
  process.exitCode = 1
}
