/**
 * dsh-multichannel-story 单元测试：不启动 DSH，用最小假 Context 验证
 * frontmatter 解析、provider 注册、资源副本与清单是否可用。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ASSET_DIR,
  BUNDLED_RANK,
  SKILL_NAME,
  __internals,
  apply,
  loadBundledSkill,
} from '../index.js'

const { frontmatterField, splitFrontmatter } = __internals

/** 建一个用完就删的临时目录。 */
function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function fakeContext() {
  const providers = []
  const effects = []
  return {
    providers,
    effects,
    ctx: {
      skills: {
        registerProvider(create) {
          providers.push(create({ signal: new AbortController().signal, invalidate() {} }))
          return () => {}
        },
      },
      effect(fn, label) {
        effects.push(label)
        return fn()
      },
    },
  }
}

test('splitFrontmatter 去掉 frontmatter，保留正文', () => {
  const { frontmatter, content } = splitFrontmatter('---\nname: x\ndescription: y\n---\n\n# 标题\n\n正文\n')
  assert.match(frontmatter, /name: x/u)
  assert.equal(content.trim(), '# 标题\n\n正文')
})

test('frontmatterField 支持单行、引号与块标量', () => {
  assert.equal(frontmatterField('name: demo\ndescription: 一行说明\n', 'description'), '一行说明')
  assert.equal(frontmatterField('description: "带引号"\n', 'description'), '带引号')
  assert.equal(frontmatterField('description: >\n  第一行\n  第二行\nname: x\n', 'description'), '第一行 第二行')
  assert.equal(frontmatterField('description: |\n  甲\n  乙\n', 'description'), '甲 乙')
  assert.equal(frontmatterField('name: x\n', 'description'), undefined)
})

test('loadBundledSkill 读出的候选与定义互相匹配', () => {
  const { candidate, definition } = loadBundledSkill(ASSET_DIR)
  assert.equal(candidate.name, SKILL_NAME)
  assert.equal(candidate.provider, SKILL_NAME)
  assert.equal(candidate.source, 'bundled')
  assert.equal(candidate.rank, BUNDLED_RANK)
  assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
  assert.equal(candidate.resourceBase.kind, 'directory')
  assert.equal(candidate.resourceBase.path, ASSET_DIR)
  assert.equal(definition.name, candidate.name)
  assert.ok(definition.content.length > 1000, 'skill 正文应该不是空壳')
  assert.ok(definition.content.includes('多平台'), '正文应该是 multichannel-story 的 SKILL.md')
  assert.ok(existsSync(join(ASSET_DIR, 'references', 'setup.md')), 'references 应该随包提供')
  assert.ok(existsSync(join(ASSET_DIR, 'scripts', 'mcs.mjs')), 'scripts/mcs.mjs 应该随包提供')
})

test('loadBundledSkill 在资源缺失时给出可读错误', (t) => {
  const empty = tempDir(t, 'mcs-missing-')
  assert.throws(() => loadBundledSkill(empty), /missing .*SKILL\.md/u)
})

test('apply 只注册一个 skill provider', async () => {
  const { ctx, providers, effects } = fakeContext()
  apply(ctx)
  assert.equal(providers.length, 1)
  assert.deepEqual(effects, ['dsh-multichannel-story: skill provider'])
  const provider = providers[0]
  assert.equal(provider.name, SKILL_NAME)
  const candidates = await provider.list()
  assert.equal(candidates.length, 1)
  const loaded = await provider.get(candidates[0])
  assert.equal(loaded.name, SKILL_NAME)
  assert.match(loaded.content, /多平台内容流水线/u)
})

test('apply 不改动任何其它注册面', () => {
  const { ctx } = fakeContext()
  // 假 Context 只提供 skills 与 effect：apply 若去注册工具、监听事件、写提示词，
  // 就会访问不存在的成员并抛错，所以这里能通过就说明它只碰了 skills。
  apply(ctx)
  assert.ok(true)
})

test('宿主没有 registerProvider 时降级为不激活，而不是抛错', () => {
  const warned = []
  const ctx = {
    skills: {},
    effect() {
      throw new Error('不应注册任何 effect')
    },
    logger: { warn: (message) => warned.push(message) },
  }
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(warned.length, 1)
  assert.match(warned[0], /does not support skill providers/u)
})

test('SKILL.md 允许块标量的 description', (t) => {
  const dir = tempDir(t, 'mcs-block-')
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: multichannel-story\ndescription: >\n  块标量写法\n  也能解析\n---\n\n# 正文\n', 'utf8')
  const { candidate, definition } = loadBundledSkill(dir)
  assert.equal(candidate.description, '块标量写法 也能解析')
  assert.equal(definition.content, '# 正文')
})

test('SKILL.md 带 BOM 仍能加载', (t) => {
  const dir = tempDir(t, 'mcs-bom-')
  writeFileSync(join(dir, 'SKILL.md'), '\uFEFF---\nname: multichannel-story\ndescription: 带 BOM 也能读\n---\n\n# 正文\n', 'utf8')
  const { candidate } = loadBundledSkill(dir)
  assert.equal(candidate.description, '带 BOM 也能读')
})

test('SKILL.md 改名后 fail-fast，而不是静默换名字注册', (t) => {
  const dir = tempDir(t, 'mcs-rename-')
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: other-name\ndescription: 改名了\n---\n\n# 正文\n', 'utf8')
  assert.throws(() => loadBundledSkill(dir), /declares name "other-name"/u)
})

test('资源副本与 MANIFEST.json 完全一致', () => {
  const manifestPath = join(ASSET_DIR, 'MANIFEST.json')
  assert.ok(existsSync(manifestPath), 'MANIFEST.json 应该随包提供（先跑 node scripts/sync-assets.mjs）')
  const recorded = JSON.parse(readFileSync(manifestPath, 'utf8')).files
  const names = Object.keys(recorded)
  assert.deepEqual(names, [...names].sort(), '清单键应排序，保证重跑同步产生同样内容')
  // ASSET_DIR 由 new URL(...) 得来，末尾带分隔符；比较相对路径前先归一化。
  const root = ASSET_DIR.replace(/[\\/]+$/u, '')
  const actual = {}
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      const relative = full.slice(root.length + 1).split('\\').join('/')
      if (relative === 'MANIFEST.json') continue
      actual[relative] = createHash('sha256').update(readFileSync(full)).digest('hex')
    }
  }
  walk(root)
  assert.deepEqual(Object.keys(actual).sort(), names, '清单必须覆盖全部副本文件')
  for (const name of names) assert.equal(actual[name], recorded[name], `${name} 被手改过，重跑 sync-assets.mjs`)
})
