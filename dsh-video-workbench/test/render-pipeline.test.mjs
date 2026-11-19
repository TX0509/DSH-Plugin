import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createJobManager,
  createProgressParser,
  expiredRenders,
  exportFileName,
  isPidAlive,
  jobRegistryPath,
  killTree,
  nextRenderVersion,
  parseFfprobeJson,
  parseProgressLine,
  readJobRegistries,
  reapOrphans,
  renderFileName,
  renderVersionOf,
  safeTitle,
  scaffoldCompositionHtml,
  stripAnsi,
  tempRenderPath,
  createProject,
} from '../index.js'

// --- progress --------------------------------------------------------------

const REAL_LINES = [
  '\u001B[2K  ████████░░░░  43%  Capturing frame 120/300 (2 workers)',
  '\u001B[2K  ██████████████████░░░░░  75%  Encoding video',
  '\u001B[2K  ██████████████████████░░░  90%  Assembling final video',
  '\u001B[2K  █████████████████████████  100%  Render complete',
]

test('stripAnsi: removes cursor/erase sequences', () => {
  assert.equal(stripAnsi('\u001B[2Khello\u001B[?25l'), 'hello')
})

test('parseProgressLine: recognises every phase hyperframes 0.6.33 prints', () => {
  const capturing = parseProgressLine(REAL_LINES[0])
  assert.equal(capturing.phase, 'capturing')
  assert.equal(capturing.frames, 120)
  assert.equal(capturing.totalFrames, 300)
  assert.ok(capturing.percent > 5 && capturing.percent < 75)
  assert.equal(parseProgressLine(REAL_LINES[1]).phase, 'encoding')
  assert.equal(parseProgressLine(REAL_LINES[2]).percent, 90)
  assert.equal(parseProgressLine(REAL_LINES[3]).percent, 100)
  assert.equal(parseProgressLine('⚠ [compositions/a.html] composition_self_attribute_selector: x').warning,
    'composition_self_attribute_selector: x')
  assert.equal(parseProgressLine('random noise'), undefined)
})

test('createProgressParser: buffers partial lines and never goes backwards', () => {
  const parser = createProgressParser()
  assert.deepEqual(parser.feed('Capturing frame 30/300 (2 wor'), [])
  const updates = parser.feed('kers)\nCapturing frame 60/300\n')
  assert.equal(updates.length, 2, 'both completed lines report progress')
  assert.equal(updates[1].frames, 60)
  // A later "Rendering" line would be a regression: ignore it.
  assert.deepEqual(parser.feed('Rendering x → y\n'), [])
  const done = parser.feed('Render complete\n')
  assert.equal(done[0].percent, 100)
})

// --- outputs ---------------------------------------------------------------

test('renderVersionOf / nextRenderVersion / expiredRenders', () => {
  assert.equal(renderVersionOf('v3.mp4'), 3)
  assert.equal(renderVersionOf('v0.mp4'), undefined)
  assert.equal(renderVersionOf('v3.MP4'), undefined)
  assert.equal(renderVersionOf('.v3.mp4.tmp-x'), undefined)
  assert.equal(nextRenderVersion([]), 1)
  assert.equal(nextRenderVersion(['v1.mp4', 'v7.mp4', 'notes.txt']), 8)
  assert.deepEqual(expiredRenders(['v1.mp4', 'v2.mp4', 'v3.mp4', 'v4.mp4', 'v5.mp4', 'v6.mp4', 'extra.mp4'], 3),
    ['v3.mp4', 'v2.mp4', 'v1.mp4'])
  assert.deepEqual(expiredRenders(['v1.mp4'], 0), [])
})

test('safeTitle: strips reserved characters, caps length, falls back to the slug', () => {
  assert.equal(safeTitle('我的 第一个/视频: 测试?', 'slug'), '我的-第一个-视频-测试')
  assert.equal(safeTitle('a'.repeat(60), 'slug').length, 40)
  assert.equal(safeTitle('<>:"/\\|?*', 'slug'), 'slug')
  assert.equal(safeTitle('   ', 'slug'), 'slug')
})

test('exportFileName: never overwrites an existing export', () => {
  assert.equal(exportFileName('20261119-120000', '标题', 3, []), '20261119-120000-标题-v3.mp4')
  assert.equal(
    exportFileName('20261119-120000', '标题', 3, ['20261119-120000-标题-v3.mp4']),
    '20261119-120000-标题-v3-2.mp4',
  )
  assert.equal(
    exportFileName('20261119-120000', '标题', 3, ['20261119-120000-标题-v3-2.mp4']),
    '20261119-120000-标题-v3.mp4',
  )
})

test('tempRenderPath: hidden temp inside renders/', () => {
  const file = tempRenderPath('C:/p/renders', 4, 'abcd')
  assert.equal(path.dirname(file), path.resolve('C:/p/renders'))
  assert.equal(path.basename(file).startsWith('.v4.tmp-'), true)
  assert.equal(file.endsWith('.mp4'), true, 'hyperframes needs the real extension')
})

// --- process registry ------------------------------------------------------

test('job registry: write, read, remove, and malformed entries are reported', () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dshvw-jobs-'))
  try {
    const file = jobRegistryPath(dataDir, 'r-1')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ id: 'r-1', pid: 1234, projectId: 'p', startedAt: 'now', command: 'node' }), 'utf8')
    writeFileSync(path.join(path.dirname(file), 'broken.json'), '{oops', 'utf8')
    const read = readJobRegistries(dataDir)
    assert.equal(read.entries.length, 1)
    assert.equal(read.entries[0].pid, 1234)
    assert.equal(read.corrupt.length, 1)
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    assert.deepEqual(readJobRegistries(dataDir), { entries: [], corrupt: [] })
  } finally {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('reapOrphans: removes stale entries and never kills the current process', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dshvw-jobs-'))
  try {
    const dir = path.dirname(jobRegistryPath(dataDir, 'x'))
    mkdirSync(dir, { recursive: true })
    for (const entry of [
      { id: 'dead', pid: 999999, projectId: 'p', startedAt: 'x', command: 'node' },
      { id: 'self', pid: process.pid, projectId: 'p', startedAt: 'x', command: 'node' },
    ]) {
      writeFileSync(jobRegistryPath(dataDir, entry.id), JSON.stringify(entry), 'utf8')
    }
    const reaped = await reapOrphans(dataDir)
    assert.equal(reaped.killed.length, 0)
    assert.ok(reaped.removed.includes('dead'))
    assert.ok(reaped.removed.includes('self'))
    assert.deepEqual(readJobRegistries(dataDir).entries, [])
  } finally {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('isPidAlive / killTree: refuse dangerous inputs', async () => {
  assert.equal(isPidAlive(0), false)
  assert.equal(isPidAlive(-1), false)
  assert.equal(isPidAlive(process.pid), true)
  assert.equal(await killTree(process.pid), false, 'never kill ourselves')
  assert.equal(await killTree(0), false)
})

// --- job manager with a fake CLI ------------------------------------------

const FAKE_CLI = [
  "process.stdout.write('Rendering demo → out.mp4\\n')",
  "process.stdout.write('\\u001b[2K  ███  43%  Capturing frame 12/30 (2 workers)\\n')",
  "process.stdout.write('\\u001b[2K  75%  Encoding video\\n')",
  "process.stdout.write('\\u001b[2K  90%  Assembling final video\\n')",
  "process.stdout.write('\\u001B[2K  100%  Render complete\\n')",
  'const fs = require("node:fs")',
  'fs.writeFileSync(process.argv[2], Buffer.alloc(1024, 1))',
  'if (process.env.SLEEP_MS) setTimeout(() => {}, Number(process.env.SLEEP_MS))',
].join('\n')

function pipelineFixture() {
  const projectsRoot = mkdtempSync(path.join(os.tmpdir(), 'dshvw-pipe-'))
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dshvw-pipedata-'))
  const created = createProject(projectsRoot, { title: '渲染测试' })
  assert.equal(created.ok, true)
  const projectId = created.project.id
  mkdirSync(path.join(projectsRoot, projectId, 'composition'), { recursive: true })
  writeFileSync(path.join(projectsRoot, projectId, 'index.html'), '<!doctype html><html></html>', 'utf8')
  const cliFile = path.join(projectsRoot, 'fake-cli.cjs')
  writeFileSync(cliFile, FAKE_CLI, 'utf8')
  return { projectsRoot, dataDir, projectId, cliFile }
}

function managerFor(fixture, extra = {}) {
  return createJobManager({
    runtimeDir: fixture.projectsRoot,
    projectsRoot: fixture.projectsRoot,
    dataDir: fixture.dataDir,
    timeoutMs: 5000,
    workers: 2,
    quality: 'standard',
    keepRenders: 2,
    logger: { info: () => {}, error: () => {} },
    commandFor: (input) => ({
      command: process.execPath,
      args: [fixture.cliFile, input.outputPath],
      env: { ...process.env, SLEEP_MS: '0' },
      cwd: fixture.projectsRoot,
    }),
    probeOutput: async () => ({ durationSec: 10, width: 1080, height: 1920 }),
    ...extra,
  })
}

async function waitFor(manager, id, predicate, timeoutMs = 8000) {
  const started = Date.now()
  for (;;) {
    const job = manager.get(id)
    if (job !== undefined && predicate(job)) return job
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for job ${id}: ${JSON.stringify(manager.get(id))}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test('job manager: a fake render publishes v1.mp4, index.json and cleans up', async () => {
  const fixture = pipelineFixture()
  const manager = managerFor(fixture)
  try {
    const started = manager.start(fixture.projectId)
    assert.equal(started.ok, true)
    const job = await waitFor(manager, started.job.id, (view) => view.status === 'succeeded' || view.status === 'failed')
    assert.equal(job.status, 'succeeded', JSON.stringify(job))
    assert.equal(job.output.version, 1)
    assert.equal(existsSync(job.output.file), true)
    assert.equal(readFileSync(job.output.file).length, 1024)
    const index = JSON.parse(readFileSync(path.join(fixture.projectsRoot, fixture.projectId, 'renders', 'index.json'), 'utf8'))
    assert.equal(index[0].file, 'v1.mp4')
    assert.equal(index[0].durationSec, 10)
    assert.deepEqual(readJobRegistries(fixture.dataDir).entries, [])
    assert.equal(manager.get(started.job.id).percent, 100)
    assert.equal(manager.get(started.job.id).phase, 'done')
  } finally {
    await manager.dispose()
    rmSync(fixture.projectsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(fixture.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('job manager: busy while a render runs, and cancel stops it', async () => {
  const fixture = pipelineFixture()
  const manager = managerFor(fixture, {
    commandFor: (input) => ({
      command: process.execPath,
      args: [fixture.cliFile, input.outputPath],
      env: { ...process.env, SLEEP_MS: '5000' },
      cwd: fixture.projectsRoot,
    }),
  })
  try {
    const first = manager.start(fixture.projectId)
    assert.equal(first.ok, true)
    // One job may wait in the queue; the third is rejected outright.
    const second = manager.start(fixture.projectId)
    assert.equal(second.ok, true)
    assert.equal(second.job.status, 'queued')
    const third = manager.start(fixture.projectId)
    assert.equal(third.ok, false)
    assert.equal(third.error, 'busy')
    const cancelled = manager.cancel(first.job.id)
    assert.equal(cancelled.ok, true)
    const job = await waitFor(manager, first.job.id, (view) => view.status !== 'running' && view.status !== 'queued')
    assert.equal(['cancelled', 'failed', 'timedOut'].includes(job.status), true, job.status)
  } finally {
    await manager.dispose()
    rmSync(fixture.projectsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(fixture.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('job manager: a missing composition is scaffolded offline before rendering', async () => {
  const fixture = pipelineFixture()
  rmSync(path.join(fixture.projectsRoot, fixture.projectId, 'index.html'))
  const manager = managerFor(fixture)
  try {
    const started = manager.start(fixture.projectId)
    const job = await waitFor(manager, started.job.id, (view) => view.status === 'succeeded' || view.status === 'failed')
    assert.equal(job.status, 'succeeded', JSON.stringify(job))
    const html = readFileSync(path.join(fixture.projectsRoot, fixture.projectId, 'index.html'), 'utf8')
    assert.match(html, /data-composition-id="main-video"/u)
    assert.match(html, /data-scene="s1"/u)
  } finally {
    await manager.dispose()
    rmSync(fixture.projectsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(fixture.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('job manager: timeout kills the render and marks timedOut', async () => {
  const fixture = pipelineFixture()
  const manager = managerFor(fixture, {
    timeoutMs: 300,
    commandFor: (input) => ({
      command: process.execPath,
      args: [fixture.cliFile, input.outputPath],
      env: { ...process.env, SLEEP_MS: '5000' },
      cwd: fixture.projectsRoot,
    }),
  })
  try {
    const started = manager.start(fixture.projectId)
    const job = await waitFor(manager, started.job.id, (view) => view.status === 'timedOut' || view.status === 'failed')
    assert.equal(job.status, 'timedOut')
  } finally {
    await manager.dispose()
    rmSync(fixture.projectsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(fixture.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

// --- scaffold --------------------------------------------------------------

test('scaffoldCompositionHtml: one composition with per-scene time windows', () => {
  const html = scaffoldCompositionHtml({
    title: '测试 <项目>',
    aspect: '9:16',
    scenes: [
      { id: 's1', text: '第一段', durationSec: 4, media: { kind: 'none' } },
      { id: 's2', text: '第二段', durationSec: 6, media: { kind: 'image', asset: 'assets/a.png' } },
    ],
  })
  assert.match(html, /data-composition-id="main-video"/u)
  assert.match(html, /data-width="1080"/u)
  assert.match(html, /data-height="1920"/u)
  assert.match(html, /data-duration="10"/u)
  assert.match(html, /data-scene="s1" data-start="0" data-duration="4"/u)
  assert.match(html, /data-scene="s2" data-start="4" data-duration="6"/u)
  assert.match(html, /测试 &lt;项目&gt;/u, 'the title is escaped')
  assert.match(html, /src="assets\/a.png"/u, 'assets are relative to the composition file')
  assert.equal(/https?:\/\//u.test(html), false, 'the scaffold must render offline')
  assert.match(scaffoldCompositionHtml({ title: 't', aspect: '16:9', scenes: [] }), /data-width="1920"/u)
})
test('parseFfprobeJson: reads duration and frame size, ignores junk', () => {
  const ok = parseFfprobeJson(JSON.stringify({
    streams: [{ width: 1080, height: 1920 }],
    format: { duration: '10.000000' },
  }))
  assert.deepEqual(ok, { durationSec: 10, width: 1080, height: 1920 })
  assert.equal(parseFfprobeJson('not json'), undefined)
  assert.equal(parseFfprobeJson(JSON.stringify({ streams: [], format: {} })), undefined)
})

test('scaffoldCompositionHtml: empty scene text falls back to the title, never a blank frame', () => {
  const html = scaffoldCompositionHtml({
    title: 'M1 验收项目',
    aspect: '9:16',
    scenes: [
      { id: 's1', text: '', durationSec: 3, media: { kind: 'none' } },
      { id: 's2', text: '   ', durationSec: 2, media: { kind: 'none' } },
    ],
  })
  assert.match(html, /M1 验收项目/u, 'first empty scene shows the title')
  assert.match(html, /分镜 2/u, 'later empty scenes get a label')
})
