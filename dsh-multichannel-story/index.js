/**
 * dsh-multichannel-story — Host half.
 *
 * Registers the bundled `multichannel-story` skill as a skill provider, so every
 * Session in the profile — DSH Desktop and the Web GUI alike — sees the skill in
 * its catalog without a manual copy under `~/.agents/skills/`. Typing
 * `/multichannel-story` in the composer (or asking for 网页 + 小红书 + 公众号 +
 * 抖音) loads it through the shipped skill machinery.
 *
 * Deliberately inert on the Host side:
 * - no `ctx.tools.register`, no prompt section, no event listener, so the
 *   Agent's tool list, system prompt and turn handling are untouched;
 * - no Host state, no config schema and no device API: the browser half adds
 *   only an optional sidebar entry, a main panel and a config card, all of
 *   which disappear when the bundle is disabled;
 * - the provider is registered with the bundled rank (600), below the user
 *   roots (project 100/200, user 400/500), so an existing hand-installed copy in
 *   `~/.agents/skills/multichannel-story` still wins instead of being shadowed.
 *
 * Resources are served straight from this package. A profile-installed bundle is
 * a plain directory (linked checkout or node_modules copy), so external
 * processes started by the Agent can read and execute them; only a package
 * shipped inside ASAR/SEA would need a materialized copy.
 *
 * @module dsh-multichannel-story
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugin identity for cordis rows / diagnostics. */
export const name = 'dsh-multichannel-story'

/** The skill registry is the only required service. */
export const inject = ['skills']

/** Skill name and provider label (both are the skill's kebab-case id). */
export const SKILL_NAME = 'multichannel-story'

/**
 * Bundled precedence: the shipped `BUNDLED_SKILL_RANK`. Project and user roots
 * (100/200/400/500) outrank it, so this plugin never shadows a hand-installed
 * copy of the same skill.
 */
export const BUNDLED_RANK = 600

/** Directory holding the shipped SKILL.md, references/ and scripts/. */
export const ASSET_DIR = fileURLToPath(new URL('./assets/multichannel-story/', import.meta.url))

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Split YAML frontmatter from a SKILL.md body without a YAML dependency. */
function splitFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (match === null) return { frontmatter: '', content: raw }
  return { frontmatter: match[1] ?? '', content: raw.slice(match[0].length) }
}

/**
 * Read one scalar frontmatter field. Supports a plain one-line value and a
 * `>`/`|` block scalar (the two shapes a SKILL.md description is written in);
 * quotes are removed.
 */
function frontmatterField(frontmatter, field) {
  const lines = frontmatter.split(/\r?\n/u)
  const start = lines.findIndex((line) => line.startsWith(`${field}:`))
  if (start === -1) return undefined
  const inline = lines[start].slice(field.length + 1).trim()
  if (inline !== '' && inline !== '>' && inline !== '|' && inline !== '>-' && inline !== '|-') {
    return inline.replace(/^["']|["']$/gu, '')
  }
  const block = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') {
      block.push('')
      continue
    }
    if (!/^\s+/u.test(line)) break
    block.push(line.trim())
  }
  const joined = block.join(' ').replaceAll(/\s+/gu, ' ').trim()
  return joined === '' ? undefined : joined
}

/**
 * Load and validate the shipped skill. Missing assets fail activation loudly:
 * a plugin row that silently provides no skill is worse than a visible error.
 * @param {string} directory - directory containing SKILL.md.
 * @returns {{candidate: object, definition: object}} provider-ready values.
 */
export function loadBundledSkill(directory) {
  const skillPath = join(directory, 'SKILL.md')
  let raw
  try {
    if (!statSync(skillPath).isFile()) throw new Error(`${skillPath} is not a regular file`)
    raw = readFileSync(skillPath, 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`dsh-multichannel-story: missing ${skillPath}; reinstall the bundle (the shipped copy is incomplete)`)
    }
    // Anything else (permissions, a directory in place of the file) keeps its
    // own reason: reporting it as "missing" would send users to the wrong fix.
    throw error
  }
  // Some Windows editors prepend a BOM; the frontmatter fence must be the very
  // first characters, so strip it before parsing instead of failing later.
  raw = raw.replace(/^\uFEFF/u, '')
  const { frontmatter, content } = splitFrontmatter(raw)
  const declaredName = frontmatterField(frontmatter, 'name')
  if (declaredName !== undefined && declaredName !== SKILL_NAME) {
    // The vendored copy is addressed by SKILL_NAME in the bundle name, the
    // locales and the documented `/multichannel-story` gesture. Renaming it here
    // would silently break all three, so refuse loudly instead.
    throw new Error(`dsh-multichannel-story: SKILL.md declares name "${declaredName}" but the bundle ships "${SKILL_NAME}"; revert the rename or update SKILL_NAME, locales and README together`)
  }
  if (!SKILL_NAME_PATTERN.test(SKILL_NAME)) {
    throw new Error(`dsh-multichannel-story: invalid skill name "${SKILL_NAME}"`)
  }
  const description = frontmatterField(frontmatter, 'description')
  if (description === undefined) {
    throw new Error(`dsh-multichannel-story: ${skillPath} has no description in its frontmatter (check the YAML header and any byte-order mark)`)
  }
  const body = content.trim()
  if (body === '') throw new Error(`dsh-multichannel-story: ${skillPath} has an empty body`)

  const shared = {
    name: SKILL_NAME,
    description,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: SKILL_NAME,
    resourceBase: { kind: 'directory', path: directory },
    path: skillPath,
  }
  return {
    candidate: { ...shared, rank: BUNDLED_RANK, locator: skillPath },
    definition: { ...shared, content: body },
  }
}

/**
 * Register the bundled skill provider for this plugin's lifetime.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Context carrying the skill registry.
 */
export function apply(ctx) {
  // `inject: ['skills']` already keeps this plugin inactive when the skill
  // registry is absent. A host older than the provider API would still expose
  // the service without `registerProvider`; degrade to "no skill" with a
  // diagnostic instead of failing the whole profile row.
  if (typeof ctx.skills.registerProvider !== 'function') {
    ctx.logger?.warn?.('dsh-multichannel-story: this DSH does not support skill providers; plugin inactive')
    return
  }
  const { candidate, definition } = loadBundledSkill(ASSET_DIR)
  ctx.effect(
    () => ctx.skills.registerProvider(() => ({
      name: SKILL_NAME,
      list: () => Promise.resolve([candidate]),
      get: () => Promise.resolve(definition),
    })),
    'dsh-multichannel-story: skill provider',
  )
}

/** Test seam: parsing and asset loading without a live Context. */
export const __internals = { splitFrontmatter, frontmatterField, loadBundledSkill }
