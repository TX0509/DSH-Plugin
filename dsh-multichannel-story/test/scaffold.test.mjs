/**
 * assets/multichannel-story/scripts/scaffold-video.py 的行为测试。
 *
 * 重点两条：`--force` 必须保护逐场手改过的 compositions/sN.html；
 * `--check` 找不到/跑不通校验时不能静默“跳过并退 0”。
 * 没有 Python 的环境整组跳过（脚本本身要靠它跑）。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS = join(PLUGIN_DIR, 'assets', 'multichannel-story', 'scripts')
const SCAFFOLD = join(SCRIPTS, 'scaffold-video.py')

/** Windows 上 `python` 往往是 Store 别名，优先 `py -3`。 */
function findPython() {
  for (const [command, prefix] of [['py', ['-3']], ['python3', []], ['python', []]]) {
    const probe = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8', windowsHide: true })
    if (probe.status === 0) return { command, prefix }
  }
  return undefined
}

const PYTHON = findPython()

function runScaffold(args, env) {
  const result = spawnSync(PYTHON.command, [...PYTHON.prefix, SCAFFOLD, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: env === undefined ? process.env : { ...process.env, ...env },
  })
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

const SCENES = {
  title: '测试短片',
  width: 1080,
  height: 1920,
  fps: 30,
  scenes: [
    { id: 's1', start: 0, duration: 3, title: ['第一场'] },
    { id: 's2', start: 3, duration: 2, title: ['第二场'] },
  ],
}

function makeProject(t, scenes = SCENES) {
  const dir = mkdtempSync(join(tmpdir(), 'mcs-scaffold-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'gsap.min.js'), '// gsap\n', 'utf8')
  writeFileSync(join(dir, 'scenes.json'), JSON.stringify(scenes, null, 2), 'utf8')
  return dir
}

const skipNoPython = () => (PYTHON === undefined ? '没有可用的 Python' : false)

test('首次生成：index.html 与每场子合成都在', (t) => {
  const reason = skipNoPython()
  if (reason !== false) {
    t.skip(reason)
    return
  }
  const dir = makeProject(t)
  const { code, output } = runScaffold(['--dir', dir, '--scenes', join(dir, 'scenes.json')])
  assert.equal(code, 0, output)
  assert.ok(existsSync(join(dir, 'index.html')))
  assert.ok(existsSync(join(dir, 'compositions', 's1.html')))
  assert.ok(existsSync(join(dir, 'compositions', 's2.html')))
})

test('不加 --force 时拒绝覆盖逐场手改的 compositions', (t) => {
  const reason = skipNoPython()
  if (reason !== false) {
    t.skip(reason)
    return
  }
  const dir = makeProject(t)
  const sceneFile = join(dir, 'compositions', 's1.html')
  assert.equal(runScaffold(['--dir', dir, '--scenes', join(dir, 'scenes.json')]).code, 0)
  const edited = readFileSync(sceneFile, 'utf8') + '\n<!-- 手改标记 -->\n'
  writeFileSync(sceneFile, edited, 'utf8')

  const blocked = runScaffold(['--dir', dir, '--scenes', join(dir, 'scenes.json')])
  assert.equal(blocked.code, 1, blocked.output)
  assert.match(blocked.output, /compositions\/s1\.html/u)
  assert.match(blocked.output, /--force/u)
  assert.equal(readFileSync(sceneFile, 'utf8'), edited, '手改的场景文件不得被覆盖')

  const forced = runScaffold(['--dir', dir, '--scenes', join(dir, 'scenes.json'), '--force'])
  assert.equal(forced.code, 0, forced.output)
  assert.ok(!readFileSync(sceneFile, 'utf8').includes('手改标记'), '--force 才允许覆盖')
})

test('缺旁白音频时直接失败，不写出指向空文件的音轨', (t) => {
  const reason = skipNoPython()
  if (reason !== false) {
    t.skip(reason)
    return
  }
  const scenes = { ...SCENES, voice: { src: 'assets/imported/vo.mp3' } }
  const dir = makeProject(t, scenes)
  const { code, output } = runScaffold(['--dir', dir, '--scenes', join(dir, 'scenes.json')])
  assert.equal(code, 1, output)
  assert.match(output, /旁白音频/u)
  assert.ok(!existsSync(join(dir, 'index.html')), '失败时不应留下半个工程')
})

test('场景 id 会被写进文件名：白名单外的 id 直接失败', (t) => {
  const reason = skipNoPython()
  if (reason !== false) {
    t.skip(reason)
    return
  }
  const dir = makeProject(t, {
    ...SCENES,
    scenes: [{ id: '../escape', start: 0, duration: 3, title: ['x'] }],
  })
  const { code, output } = runScaffold(['--dir', dir, '--scenes', join(dir, 'scenes.json')])
  assert.equal(code, 1, output)
  assert.match(output, /场景 id/u)
  assert.ok(!existsSync(join(dir, 'index.html')))
})

test('--check 走 mcs.mjs：校验跑不通时以非 0 退出', (t) => {
  const reason = skipNoPython()
  if (reason !== false) {
    t.skip(reason)
    return
  }
  const dir = makeProject(t)
  const stubDir = mkdtempSync(join(tmpdir(), 'mcs-scaffold-cli-'))
  t.after(() => rmSync(stubDir, { recursive: true, force: true }))
  const stub = join(stubDir, 'hyperframes.mjs')
  writeFileSync(stub, 'console.log("definitely not json")\nprocess.exit(0)\n', 'utf8')

  const { code, output } = runScaffold(
    ['--dir', dir, '--scenes', join(dir, 'scenes.json'), '--check'],
    { HYPERFRAMES_CLI: stub },
  )
  assert.equal(code, 1, output)
  assert.match(output, /hyperframes check/u)
})

test('scaffold-video.py 语法可解析（不生成 __pycache__）', (t) => {
  const reason = skipNoPython()
  if (reason !== false) {
    t.skip(reason)
    return
  }
  const result = spawnSync(PYTHON.command, [...PYTHON.prefix, '-c',
    'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())', SCAFFOLD], {
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
})
