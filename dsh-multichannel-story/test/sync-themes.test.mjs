/**
 * `scripts/sync-themes.mjs`：从「歸藏设计」插件的 themes.json 生成 STYLES 表与文档清单。
 *
 * 全部用临时目录里的最小副本跑，不读真实 profile、不改仓库文件：
 * 生成的确定性、标记边界、`--check` 的漂移判定、未知风格与坏输入的失败路径。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(PLUGIN_DIR, 'scripts', 'sync-themes.mjs')

function run(args, env) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: env === undefined ? process.env : { ...process.env, ...env },
  })
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/** 本插件的最小副本：只有脚本会改的三个文件。 */
function makePackage(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mcs-pkg-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'assets', 'multichannel-story', 'references'), { recursive: true })
  cpSync(join(PLUGIN_DIR, 'client.js'), join(dir, 'client.js'))
  cpSync(join(PLUGIN_DIR, 'assets', 'multichannel-story', 'SKILL.md'), join(dir, 'assets', 'multichannel-story', 'SKILL.md'))
  cpSync(
    join(PLUGIN_DIR, 'assets', 'multichannel-story', 'references', 'page.md'),
    join(dir, 'assets', 'multichannel-story', 'references', 'page.md'),
  )
  return dir
}

/** 假的 dsh-guizang-design：只有 page skill 的 themes.json。 */
function makeSource(t, themes) {
  const root = mkdtempSync(join(tmpdir(), 'mcs-gz-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const assets = join(root, 'skills', 'guizang-page-skill', 'assets')
  mkdirSync(assets, { recursive: true })
  writeFileSync(
    join(assets, 'themes.json'),
    typeof themes === 'string' ? themes : JSON.stringify(themes, null, 2),
    'utf8',
  )
  return root
}

const theme = (id, name, en, paper, accent) => ({ id, name, en, scheme: 'light', paper, ink: '#111111', accent })

const FIXTURE = {
  $comment: 'guizang-design 生成，不要手改',
  magazine: {
    default: 'sea-salt',
    colors: [
      theme('ink-classic', '墨水经典', 'Ink Classic', '#f1efea', '#111111'),
      theme('sea-salt', '海盐', 'Sea Salt', '#eef2f4', '#35607a'),
    ],
  },
  swiss: {
    default: 'ikb',
    colors: [theme('ikb', '克莱因蓝', 'IKB', '#fafaf8', '#002FA7')],
  },
}

const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8')

/** 标记之外的文本：用来断言「只改生成块，别的一个字都不动」。 */
function outsideMarkers(text) {
  const begin = text.indexOf('mcs:themes:begin')
  const end = text.indexOf('mcs:themes:end')
  assert.ok(begin !== -1 && end > begin)
  return [
    text.slice(0, text.lastIndexOf('\n', begin) + 1),
    text.slice(text.indexOf('\n', end) + 1),
  ]
}

test('同步：新主题写进 STYLES 与两份文档，标记外一个字不动', (t) => {
  const pkg = makePackage(t)
  const source = makeSource(t, FIXTURE)
  const before = {
    client: read(pkg, 'client.js'),
    skill: read(pkg, 'assets/multichannel-story/SKILL.md'),
    page: read(pkg, 'assets/multichannel-story/references/page.md'),
  }

  // 还没同步时 --check 必须失败，并指出是哪几个文件
  const drift = run(['--package', pkg, '--source', source, '--check'])
  assert.equal(drift.code, 1, drift.output)
  assert.match(drift.output, /client\.js/u)
  assert.match(drift.output, /references\/page\.md/u)

  const written = run(['--package', pkg, '--source', source])
  assert.equal(written.code, 0, written.output)
  assert.match(written.output, /杂志风 2 套，瑞士风 1 套/u)

  const client = read(pkg, 'client.js')
  assert.match(client, /id: 'sea-salt', name: \{ zh: '海盐', en: 'Sea Salt' \}, paper: '#eef2f4', accent: '#35607a' \}/u)
  // 上游的 default 说了算：不是「数组第一个」
  assert.match(client, /defaultTheme: 'sea-salt'/u)
  const skill = read(pkg, 'assets/multichannel-story/SKILL.md')
  assert.match(skill, /- 杂志风 `magazine`：`ink-classic` 墨水经典 \/ `sea-salt` 海盐/u)
  const page = read(pkg, 'assets/multichannel-story/references/page.md')
  assert.match(page, /\| \| `sea-salt` \| 海盐 \| — \|/u, '新主题先留空说明')
  assert.match(page, /没给 `--theme` 时由 render\.mjs 用该风格的默认主题（杂志风 → `sea-salt`，瑞士风 → `ikb`）。/u)

  // 标记外保持原样
  for (const [rel, original] of [
    ['client.js', before.client],
    ['assets/multichannel-story/SKILL.md', before.skill],
    ['assets/multichannel-story/references/page.md', before.page],
  ]) {
    assert.deepEqual(outsideMarkers(read(pkg, rel)), outsideMarkers(original), `${rel} 标记外被改动了`)
  }

  // 再跑一次是幂等的，--check 通过
  const again = run(['--package', pkg, '--source', source])
  assert.equal(again.code, 0, again.output)
  assert.match(again.output, /已是最新/u)
  const clean = run(['--package', pkg, '--source', source, '--check'])
  assert.equal(clean.code, 0, clean.output)
})

test('新主题没有「适合什么内容」时提示去 THEME_NOTES 补一句', (t) => {
  const pkg = makePackage(t)
  const source = makeSource(t, FIXTURE)
  const { code, output } = run(['--package', pkg, '--source', source])
  assert.equal(code, 0, output)
  assert.match(output, /新主题 magazine\/sea-salt 还没有「适合什么内容」的说明/u)
})

test('上游多出第三种骨架时警告并跳过，不写进本插件', (t) => {
  const pkg = makePackage(t)
  const source = makeSource(t, {
    ...FIXTURE,
    brutalist: { default: 'concrete', colors: [theme('concrete', '混凝土灰', 'Concrete', '#d8d8d6', '#4a4a48')] },
  })
  const { code, output } = run(['--package', pkg, '--source', source])
  assert.equal(code, 0, output)
  assert.match(output, /brutalist/u)
  assert.match(output, /还不支持/u)
  assert.ok(!read(pkg, 'client.js').includes('concrete'), '不支持的风格不能混进 STYLES')
})

test('只有不支持的骨架时直接失败，不留半成品', (t) => {
  const pkg = makePackage(t)
  const source = makeSource(t, {
    brutalist: { default: 'concrete', colors: [theme('concrete', '混凝土灰', 'Concrete', '#d8d8d6', '#4a4a48')] },
  })
  const before = read(pkg, 'client.js')
  const { code, output } = run(['--package', pkg, '--source', source])
  assert.equal(code, 2, output)
  assert.match(output, /没有任何本插件支持的风格/u)
  assert.equal(read(pkg, 'client.js'), before)
})

test('缺 themes.json / 坏 JSON / 缺标记都按失败退出，且不改文件', (t) => {
  const pkg = makePackage(t)
  const before = read(pkg, 'client.js')

  const missing = run(['--package', pkg, '--source', join(pkg, '没有这个目录')])
  assert.equal(missing.code, 2, missing.output)
  assert.match(missing.output, /找不到/u)

  const broken = makeSource(t, '{ not json')
  const bad = run(['--package', pkg, '--source', broken])
  assert.equal(bad.code, 2, bad.output)
  assert.match(bad.output, /不是合法 JSON/u)

  // 标记被删掉时不许猜位置
  writeFileSync(join(pkg, 'client.js'), before.replace('mcs:themes:begin', 'mcs-themes-begin'), 'utf8')
  const good = makeSource(t, FIXTURE)
  const noMarker = run(['--package', pkg, '--source', good])
  assert.equal(noMarker.code, 2, noMarker.output)
  assert.match(noMarker.output, /找不到 mcs:themes:begin/u)
})

test('没装上游：--check 默认跳过（0），加 --require-source 才算失败', (t) => {
  const pkg = makePackage(t)
  const home = mkdtempSync(join(tmpdir(), 'mcs-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  mkdirSync(join(home, 'profiles'), { recursive: true })
  const env = { DSH_HOME: home, GZ_ROOT: '' }

  const skipped = run(['--package', pkg, '--check'], env)
  assert.equal(skipped.code, 0, skipped.output)
  assert.match(skipped.output, /跳过/u)
  assert.match(skipped.output, /没有找到已安装的 dsh-guizang-design/u)

  const required = run(['--package', pkg, '--check', '--require-source'], env)
  assert.equal(required.code, 2, required.output)
  assert.match(required.output, /没有找到已安装的/u)
})

test('多 profile：优先用 desktop，并在摘要里注明来源与版本', (t) => {
  const pkg = makePackage(t)
  const home = mkdtempSync(join(tmpdir(), 'mcs-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const makeProfile = (name, themes, version) => {
    const root = join(home, 'profiles', name, 'node_modules', 'dsh-guizang-design')
    mkdirSync(join(root, 'skills', 'guizang-page-skill', 'assets'), { recursive: true })
    writeFileSync(join(root, 'skills', 'guizang-page-skill', 'assets', 'themes.json'), JSON.stringify(themes), 'utf8')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dsh-guizang-design', version }), 'utf8')
  }
  // 故意让 web 的版本「更新」：约定是 desktop 优先，结果必须仍然取 desktop。
  makeProfile('desktop', FIXTURE, '9.9.9')
  makeProfile('web', { magazine: { default: 'only', colors: [theme('only', '唯一', 'Only', '#ffffff', '#000000')] } }, '1.0.0')

  const { code, output } = run(['--package', pkg], { DSH_HOME: home, GZ_ROOT: '' })
  assert.equal(code, 0, output)
  assert.match(output, /profile desktop，v9\.9\.9/u)
  assert.ok(read(pkg, 'client.js').includes("id: 'sea-salt'"), '应写入 desktop 那份主题表')
})

test('写入是原子的：目录里不留 .tmp 残留文件', (t) => {
  const pkg = makePackage(t)
  const source = makeSource(t, FIXTURE)
  const { code, output } = run(['--package', pkg, '--source', source])
  assert.equal(code, 0, output)
  // 临时文件名带 pid/随机后缀，按扩展名递归找，别假定具体命名。
  const leftovers = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.tmp')) leftovers.push(full)
    }
  }
  walk(pkg)
  assert.deepEqual(leftovers, [])
})

test('参数错误与 --help', () => {
  assert.equal(run(['--nope']).code, 2)
  assert.equal(run(['--source']).code, 2)
  const help = run(['--help'])
  assert.equal(help.code, 0, help.output)
  assert.match(help.output, /--check/u)
})

// 真实上游比对默认不在 `node --test` 里跑：装了插件的机器上，上游一升级就会让整个测试套变红，
// 而「同步上游」是 `npm run check-themes` 的职责。要在这里强制校验时设 MCS_REQUIRE_UPSTREAM=1。
test('仓库内的生成块与「歸藏设计」一致（需 MCS_REQUIRE_UPSTREAM=1）', (t) => {
  if (process.env.MCS_REQUIRE_UPSTREAM !== '1') {
    t.skip('未设 MCS_REQUIRE_UPSTREAM=1，跳过真实上游比对（日常用 npm run check-themes）')
    return
  }
  const source = process.env.GZ_ROOT ?? findInstalledGuizang()
  if (source === undefined) {
    t.skip('本机没装 dsh-guizang-design，跳过真实上游比对')
    return
  }
  if (!existsSync(join(source, 'skills', 'guizang-page-skill', 'assets', 'themes.json'))) {
    t.skip('GZ_ROOT 指向的目录里没有 themes.json')
    return
  }
  const { code, output } = run(['--check', '--source', source])
  assert.equal(code, 0, `生成块与上游 themes.json 不一致，跑 node scripts/sync-themes.mjs 同步：\n${output}`)
})

/** 与脚本同样的发现顺序：DSH_HOME（或 homedir）下按 desktop → web → 其余 的顺序找。 */
function findInstalledGuizang() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profiles = join(home, 'profiles')
  if (!existsSync(profiles)) return undefined
  for (const profile of ['desktop', 'web', 'open-design', 'acp']) {
    const candidate = join(profiles, profile, 'node_modules', 'dsh-guizang-design')
    if (existsSync(join(candidate, 'skills', 'guizang-page-skill', 'assets', 'themes.json'))) return candidate
  }
  return undefined
}
