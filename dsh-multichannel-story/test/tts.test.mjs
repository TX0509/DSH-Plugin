/**
 * assets/multichannel-story/scripts/tts.py 的离线行为测试。
 *
 * 不联网、不依赖真实 edge-tts：`PYTHONPATH` 指向临时目录里的 edge_tts 桩模块，
 * 桩只写一段极轻的正弦波（近似静音，lame 对全零样本会命中 psymodel 断言）。
 * 需要本机 ffmpeg / ffprobe 与 libmp3lame 编码器；缺失时整组跳过并说明原因。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TTS = join(PLUGIN_DIR, 'assets', 'multichannel-story', 'scripts', 'tts.py')

/** Windows 上 `python` 往往是 Store 别名，优先 `py -3`；返回绝对解释器路径。 */
function findPython() {
  for (const [command, prefix] of [['py', ['-3']], ['python3', []], ['python', []]]) {
    const probe = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8', windowsHide: true })
    if (probe.status !== 0) continue
    const resolved = spawnSync(command, [...prefix, '-c', 'import sys;print(sys.executable)'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    const exe = resolved.status === 0 ? resolved.stdout.trim() : ''
    return { command, prefix, exe: exe === '' ? command : exe }
  }
  return undefined
}

function probeTools() {
  for (const tool of ['ffmpeg', 'ffprobe']) {
    if (spawnSync(tool, ['-version'], { encoding: 'utf8', windowsHide: true }).status !== 0) {
      return { ok: false, reason: `没有可用的 ${tool}（tts.py 本身要求 ffmpeg/ffprobe）` }
    }
  }
  const encoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true })
  const text = `${encoders.stdout ?? ''}${encoders.stderr ?? ''}`
  if (!/libmp3lame/u.test(text)) return { ok: false, reason: '本机 ffmpeg 没有 libmp3lame 编码器' }
  return { ok: true }
}

const PYTHON = findPython()
const TOOLS = probeTools()

// 桩模块：不联网，写一段 0.8s 的极轻正弦（≈静音）到目标路径。
// EDGE_TTS_FAIL_TIMES / EDGE_TTS_COUNTER 用来模拟前 N 次合成断流，覆盖重试路径。
const STUB_EDGE_TTS = `"""测试用 edge_tts 桩：不联网，只写一段可被 ffprobe 识别的极轻音。"""
import os
import subprocess

DEFAULT_DURATION = 0.8


class Communicate:
    def __init__(self, text, voice, rate="+0%", pitch="+0Hz"):
        self.text = text

    async def save(self, path):
        counter = os.environ.get("EDGE_TTS_COUNTER")
        attempt = 0
        if counter:
            try:
                attempt = int(open(counter, encoding="utf-8").read().strip() or "0")
            except (OSError, ValueError):
                attempt = 0
            with open(counter, "w", encoding="utf-8") as fh:
                fh.write(str(attempt + 1))
        fail_times = int(os.environ.get("EDGE_TTS_FAIL_TIMES", "0") or "0")
        if attempt < fail_times:
            raise RuntimeError("模拟网络断流")
        duration = float(os.environ.get("EDGE_TTS_DURATION", str(DEFAULT_DURATION)))
        wav = path + ".wav"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
             "-i", "sine=frequency=220:sample_rate=24000:duration=" + str(duration),
             "-af", "volume=0.01", wav],
            check=True, capture_output=True)
        os.replace(wav, path)


async def list_voices():
    return [{"ShortName": "zh-CN-YunjianNeural", "Locale": "zh-CN", "Gender": "Male",
             "VoiceTag": {"VoicePersonalities": ["Passion"]}}]
`

const BASE_SPEC = {
  voice: 'zh-CN-YunjianNeural',
  total_duration: 5,
  segments: [
    { id: 's1', start: 0, text: '第一句旁白' },
    { id: 's2', start: 2, text: '第二句旁白' },
  ],
}

function skipReason() {
  if (PYTHON === undefined) return '没有可用的 Python'
  if (!TOOLS.ok) return TOOLS.reason
  return false
}

function makeWorkspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mcs-tts-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const stubDir = join(dir, 'stub')
  mkdirSync(join(stubDir, 'edge_tts'), { recursive: true })
  writeFileSync(join(stubDir, 'edge_tts', '__init__.py'), STUB_EDGE_TTS, 'utf8')
  return { dir, stubDir }
}

function writeSpec(dir, spec, name = 'spec.json') {
  const file = join(dir, name)
  writeFileSync(file, JSON.stringify(spec), 'utf8')
  return file
}

function runTts(workspace, args, env = {}) {
  const result = spawnSync(PYTHON.exe, [TTS, ...args], {
    cwd: workspace.dir,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PYTHONPATH: workspace.stubDir, ...env },
  })
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function readSidecar(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

test('正常生成：退出 0，sidecar 时长与 total_duration 吻合', (t) => {
  const reason = skipReason()
  if (reason !== false) {
    t.skip(reason)
    return
  }
  const workspace = makeWorkspace(t)
  writeSpec(workspace.dir, BASE_SPEC)
  const { code, output } = runTts(workspace, ['spec.json', '--out', 'vo.mp3'])
  assert.equal(code, 0, output)
  assert.ok(existsSync(join(workspace.dir, 'vo.mp3')))
  const sidecar = readSidecar(join(workspace.dir, 'vo.mp3.json'))
  assert.equal(sidecar.segments.length, 2)
  assert.equal(sidecar.total_duration, 5)
  // 混音后时长与 total_duration 的偏差必须落在脚本的 0.15s 容差内。
  assert.ok(Math.abs(sidecar.output_duration - 5) <= 0.15, `output_duration=${sidecar.output_duration}`)
  for (const segment of sidecar.segments) {
    assert.ok(segment.duration > 0)
    assert.ok(Math.abs(segment.end - (segment.start + segment.duration)) < 1e-6)
  }
  // sidecar 不许出现临时目录的绝对路径，只记 basename。
  const text = readFileSync(join(workspace.dir, 'vo.mp3.json'), 'utf8')
  assert.ok(!text.includes(workspace.dir), 'sidecar 里出现了工作目录绝对路径')
  for (const segment of sidecar.segments) {
    assert.ok(!/[\\/]/u.test(segment.file), `segment.file 应为 basename：${segment.file}`)
  }
  assert.ok(!readdirSync(workspace.dir).some((name) => name.endsWith('.tmp')), '失败/成功后不应留下 .tmp')
})

test('--workdir 不存在时自动创建', (t) => {
  const reason = skipReason()
  if (reason !== false) {
    t.skip(reason)
    return
  }
  const workspace = makeWorkspace(t)
  writeSpec(workspace.dir, BASE_SPEC)
  const workdir = join(workspace.dir, 'nested', 'work')
  const { code, output } = runTts(workspace, ['spec.json', '--out', 'vo.mp3', '--workdir', workdir])
  assert.equal(code, 0, output)
  assert.ok(existsSync(workdir), '--workdir 应被自动创建')
})

test('重复 id 直接失败（否则后一句覆盖前一句的 mp3）', (t) => {
  const reason = skipReason()
  if (reason !== false) {
    t.skip(reason)
    return
  }
  const workspace = makeWorkspace(t)
  writeSpec(workspace.dir, {
    ...BASE_SPEC,
    segments: [
      { id: 's1', start: 0, text: '第一句' },
      { id: 's1', start: 2, text: '第二句' },
    ],
  })
  const { code, output } = runTts(workspace, ['spec.json', '--out', 'vo.mp3'])
  assert.equal(code, 1, output)
  assert.match(output, /重复/u)
  assert.ok(!existsSync(join(workspace.dir, 'vo.mp3')), '校验失败不应产出音频')
})

test('id 含 ../ 时直接失败，不会把写入带出临时目录', (t) => {
  const reason = skipReason()
  if (reason !== false) {
    t.skip(reason)
    return
  }
  const workspace = makeWorkspace(t)
  writeSpec(workspace.dir, {
    ...BASE_SPEC,
    segments: [{ id: '../evil', start: 0, text: '越狱' }],
  })
  const { code, output } = runTts(workspace, ['spec.json', '--out', 'vo.mp3'])
  assert.equal(code, 1, output)
  assert.match(output, /id 非法/u)
  assert.ok(!existsSync(join(workspace.dir, 'vo.mp3')))
})

test('缺 total_duration 直接失败，不静默生成过短音轨', (t) => {
  const reason = skipReason()
  if (reason !== false) {
    t.skip(reason)
    return
  }
  const workspace = makeWorkspace(t)
  const spec = { ...BASE_SPEC }
  delete spec.total_duration
  writeSpec(workspace.dir, spec)
  const { code, output } = runTts(workspace, ['spec.json', '--out', 'vo.mp3'])
  assert.equal(code, 1, output)
  assert.match(output, /total_duration/u)
  assert.ok(!existsSync(join(workspace.dir, 'vo.mp3')))
})

test('loudness 超出合理区间时直接失败', (t) => {
  const reason = skipReason()
  if (reason !== false) {
    t.skip(reason)
    return
  }
  const workspace = makeWorkspace(t)
  writeSpec(workspace.dir, { ...BASE_SPEC, loudness: { I: -3 } })
  const { code, output } = runTts(workspace, ['spec.json', '--out', 'vo.mp3'])
  assert.equal(code, 1, output)
  assert.match(output, /loudness\.I/u)
})

test('--out 已存在时默认拒绝，加 --force 才覆盖', (t) => {
  const reason = skipReason()
  if (reason !== false) {
    t.skip(reason)
    return
  }
  const workspace = makeWorkspace(t)
  writeSpec(workspace.dir, BASE_SPEC)
  const first = runTts(workspace, ['spec.json', '--out', 'vo.mp3'])
  assert.equal(first.code, 0, first.output)
  const sidecarBefore = readFileSync(join(workspace.dir, 'vo.mp3.json'), 'utf8')

  const blocked = runTts(workspace, ['spec.json', '--out', 'vo.mp3'])
  assert.equal(blocked.code, 1, blocked.output)
  assert.match(blocked.output, /已存在/u)
  assert.match(blocked.output, /--force/u)
  assert.equal(readFileSync(join(workspace.dir, 'vo.mp3.json'), 'utf8'), sidecarBefore, '被拒绝时不得改动产物')

  const forced = runTts(workspace, ['spec.json', '--out', 'vo.mp3', '--force'])
  assert.equal(forced.code, 0, forced.output)
  assert.ok(readSidecar(join(workspace.dir, 'vo.mp3.json')).segments.length === 2)
})

test('相邻句重叠 / 间隔不足时失败', (t) => {
  const reason = skipReason()
  if (reason !== false) {
    t.skip(reason)
    return
  }
  const workspace = makeWorkspace(t)
  writeSpec(workspace.dir, {
    ...BASE_SPEC,
    segments: [
      { id: 's1', start: 0, text: '第一句' },
      { id: 's2', start: 0.5, text: '第二句' },
    ],
  })
  const { code, output } = runTts(workspace, ['spec.json', '--out', 'vo.mp3'])
  assert.equal(code, 1, output)
  assert.match(output, /时间冲突|间隔不足/u)
  assert.ok(!existsSync(join(workspace.dir, 'vo.mp3')))
})

test('单句首次合成失败会退避重试，重试成功仍退出 0', (t) => {
  const reason = skipReason()
  if (reason !== false) {
    t.skip(reason)
    return
  }
  const workspace = makeWorkspace(t)
  writeSpec(workspace.dir, BASE_SPEC)
  const counter = join(workspace.dir, 'attempts.txt')
  const { code, output } = runTts(
    workspace,
    ['spec.json', '--out', 'vo.mp3'],
    { EDGE_TTS_FAIL_TIMES: '1', EDGE_TTS_COUNTER: counter },
  )
  assert.equal(code, 0, output)
  assert.match(output, /重试/u)
  assert.ok(existsSync(join(workspace.dir, 'vo.mp3')))
})

test('重试 2 次仍失败时退出码非 0，并指出第几句/id 与建议', (t) => {
  const reason = skipReason()
  if (reason !== false) {
    t.skip(reason)
    return
  }
  const workspace = makeWorkspace(t)
  writeSpec(workspace.dir, BASE_SPEC)
  const counter = join(workspace.dir, 'attempts.txt')
  const { code, output } = runTts(
    workspace,
    ['spec.json', '--out', 'vo.mp3'],
    { EDGE_TTS_FAIL_TIMES: '9', EDGE_TTS_COUNTER: counter },
  )
  assert.equal(code, 1, output)
  assert.match(output, /第 1 句/u)
  assert.match(output, /id=s1/u)
  assert.match(output, /建议/u)
  assert.ok(!existsSync(join(workspace.dir, 'vo.mp3')))
  assert.ok(!readdirSync(workspace.dir).some((name) => name.endsWith('.tmp')))
})

test('tts.py 语法可解析（不生成 __pycache__）', (t) => {
  const reason = skipReason()
  if (reason !== false) {
    t.skip(reason)
    return
  }
  const result = spawnSync(PYTHON.exe, ['-c',
    'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())', TTS], {
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
})
