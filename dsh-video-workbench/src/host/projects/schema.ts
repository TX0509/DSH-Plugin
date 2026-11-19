// project.json schema v1: types, defaults and a hand-written validator.
//
// No JSON-schema dependency: the plugin ships zero runtime dependencies, and
// every error string is written to be shown to the user verbatim.

import { FORBIDDEN_NAME, isReservedName, MAX_SEGMENT_LENGTH, MAX_SEGMENTS } from '../paths'

export const SCHEMA_VERSION = 1

export type Aspect = '9:16' | '16:9'
export const ASPECTS: readonly Aspect[] = ['9:16', '16:9']

export const FPS_VALUES = [24, 25, 30, 60] as const
export type Fps = (typeof FPS_VALUES)[number]

export type MediaKind = 'none' | 'image' | 'video'
export const MEDIA_KINDS: readonly MediaKind[] = ['none', 'image', 'video']

export interface ProjectStyle {
  theme: string
  captionStyle: string
}

export interface ProjectMedia {
  kind: MediaKind
  /** Project-relative path; required unless `kind` is `none`. */
  asset?: string
}

export interface ProjectVoice {
  /** Project-relative path; absent means silence. */
  asset?: string
  speed: number
}

export interface ProjectScene {
  id: string
  text: string
  durationSec: number
  media: ProjectMedia
  voice: ProjectVoice
  captions: { enabled: boolean }
}

export interface ProjectV1 {
  schemaVersion: typeof SCHEMA_VERSION
  /** Slug; must equal the project directory name. */
  id: string
  title: string
  aspect: Aspect
  fps: Fps
  style: ProjectStyle
  scenes: ProjectScene[]
}

export type ValidationResult =
  | { ok: true; project: ProjectV1 }
  | { ok: false; errors: string[] }

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u
const SCENE_ID = /^s[0-9]+$/u

/** Project ids double as directory names; the store reuses this rule. */
export function isProjectId(value: string): boolean {
  return PROJECT_ID.test(value)
}

const MAX_TITLE = 80
const MAX_SCENES = 50
const MAX_TEXT = 500
const MAX_DURATION = 600
const MIN_SPEED = 0.5
const MAX_SPEED = 2
const MAX_STYLE_VALUE = 40

type Errors = string[]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Length in code points, so emoji count as one character. */
function textLength(value: string): number {
  return [...value].length
}

/** Three decimals at most; tolerates float noise such as 0.1 * 3. */
function hasAtMostDecimals(value: number, decimals: number): boolean {
  const factor = 10 ** decimals
  return Math.abs(value * factor - Math.round(value * factor)) < 1e-6
}

function readProjectId(value: unknown, errors: Errors): string | undefined {
  if (typeof value !== 'string' || !isProjectId(value)) {
    errors.push('id 必须匹配 ^[a-z0-9][a-z0-9-]{0,63}$')
    return undefined
  }
  return value
}

function readTitle(value: unknown, errors: Errors): string | undefined {
  if (typeof value !== 'string') {
    errors.push('title 必须是字符串')
    return undefined
  }
  const title = value.trim()
  if (title.length === 0 || textLength(title) > MAX_TITLE) {
    errors.push(`title 长度必须为 1–${MAX_TITLE} 个字符`)
    return undefined
  }
  return title
}

function readAspect(value: unknown, errors: Errors): Aspect | undefined {
  if (value === undefined) return '9:16'
  if (typeof value === 'string' && (ASPECTS as readonly string[]).includes(value)) return value as Aspect
  errors.push(`aspect 必须是 ${ASPECTS.join(' 或 ')}`)
  return undefined
}

function readFps(value: unknown, errors: Errors): Fps | undefined {
  if (typeof value === 'number' && (FPS_VALUES as readonly number[]).includes(value)) return value as Fps
  errors.push(`fps 必须是 ${FPS_VALUES.join(' / ')}`)
  return undefined
}

function readStyle(value: unknown, errors: Errors): ProjectStyle | undefined {
  if (!isRecord(value)) {
    errors.push('style 必须是对象')
    return undefined
  }
  const theme = readStyleValue(value.theme, 'style.theme', errors)
  const captionStyle = readStyleValue(value.captionStyle, 'style.captionStyle', errors)
  if (theme === undefined || captionStyle === undefined) return undefined
  return { theme, captionStyle }
}

function readStyleValue(value: unknown, field: string, errors: Errors): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`${field} 必须是字符串`)
    return undefined
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || textLength(trimmed) > MAX_STYLE_VALUE) {
    errors.push(`${field} 长度必须为 1–${MAX_STYLE_VALUE} 个字符`)
    return undefined
  }
  return trimmed
}

function readAssetPath(value: unknown, field: string, errors: Errors): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`${field} 必须是字符串`)
    return undefined
  }
  const raw = value.trim()
  if (raw.length === 0 || raw.length > 512) {
    errors.push(`${field} 必须是项目内相对路径`)
    return undefined
  }
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[a-zA-Z]:/u.test(raw)) {
    errors.push(`${field} 不能是绝对路径`)
    return undefined
  }
  const parts = raw.split(/[\\/]+/u)
  if (parts.length > MAX_SEGMENTS) {
    errors.push(`${field} 层级过深（最多 ${MAX_SEGMENTS} 段）`)
    return undefined
  }
  for (const part of parts) {
    if (part.length === 0 || part === '.' || part === '..' || part.length > MAX_SEGMENT_LENGTH) {
      errors.push(`${field} 不能包含空段、.、.. 或过长段`)
      return undefined
    }
    if (FORBIDDEN_NAME.test(part) || isReservedName(part)
      || part.startsWith('.') || part.endsWith('.') || part.endsWith(' ')) {
      errors.push(`${field} 含非法字符、Windows 保留设备名或隐藏文件名`)
      return undefined
    }
  }
  return parts.join('/')
}

function readMedia(value: unknown, field: string, errors: Errors): ProjectMedia | undefined {
  const kindValue = isRecord(value) ? value.kind : undefined
  if (typeof kindValue !== 'string' || !(MEDIA_KINDS as readonly string[]).includes(kindValue)) {
    errors.push(`${field}.kind 必须是 ${MEDIA_KINDS.join(' / ')}`)
    return undefined
  }
  const kind = kindValue as MediaKind
  if (kind === 'none') {
    if (isRecord(value) && value.asset !== undefined) {
      errors.push(`${field}.asset 在 kind 为 none 时不应设置`)
      return undefined
    }
    return { kind }
  }
  const asset = readAssetPath(isRecord(value) ? value.asset : undefined, `${field}.asset`, errors)
  return asset === undefined ? undefined : { kind, asset }
}

function readVoice(value: unknown, field: string, errors: Errors): ProjectVoice | undefined {
  if (value === undefined) return { speed: 1 }
  if (!isRecord(value)) {
    errors.push(`${field} 必须是对象`)
    return undefined
  }
  const speed = value.speed === undefined ? 1 : value.speed
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED
    || !hasAtMostDecimals(speed, 3)) {
    errors.push(`${field}.speed 必须在 ${MIN_SPEED}–${MAX_SPEED} 之间，最多 3 位小数`)
    return undefined
  }
  const asset = value.asset === undefined
    ? undefined
    : readAssetPath(value.asset, `${field}.asset`, errors)
  if (value.asset !== undefined && asset === undefined) return undefined
  return asset === undefined ? { speed } : { asset, speed }
}

function readCaptions(value: unknown, field: string, errors: Errors): { enabled: boolean } | undefined {
  if (value === undefined) return { enabled: true }
  if (!isRecord(value) || typeof value.enabled !== 'boolean') {
    errors.push(`${field}.enabled 必须是布尔值`)
    return undefined
  }
  return { enabled: value.enabled }
}

function readScenes(value: unknown, errors: Errors): ProjectScene[] | undefined {
  if (!Array.isArray(value)) {
    errors.push('scenes 必须是数组')
    return undefined
  }
  if (value.length < 1 || value.length > MAX_SCENES) {
    errors.push(`scenes 数量必须为 1–${MAX_SCENES}`)
    return undefined
  }
  const scenes: ProjectScene[] = []
  for (const [index, raw] of value.entries()) {
    const field = `scenes[${index}]`
    if (!isRecord(raw)) {
      errors.push(`${field} 必须是对象`)
      continue
    }
    const id = raw.id
    if (typeof id !== 'string' || !SCENE_ID.test(id)) {
      errors.push(`${field}.id 必须匹配 ^s[0-9]+$`)
    }
    const text = raw.text
    if (typeof text !== 'string' || textLength(text) > MAX_TEXT) {
      errors.push(`${field}.text 必须是长度 0–${MAX_TEXT} 的字符串`)
    }
    const duration = raw.durationSec
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0
      || duration > MAX_DURATION || !hasAtMostDecimals(duration, 3)) {
      errors.push(`${field}.durationSec 必须大于 0、不超过 ${MAX_DURATION}，最多 3 位小数`)
    }
    const media = readMedia(raw.media, `${field}.media`, errors)
    const voice = readVoice(raw.voice, `${field}.voice`, errors)
    const captions = readCaptions(raw.captions, `${field}.captions`, errors)
    if (typeof id === 'string' && SCENE_ID.test(id) && typeof text === 'string'
      && typeof duration === 'number' && media !== undefined && voice !== undefined && captions !== undefined) {
      scenes.push({ id, text, durationSec: duration, media, voice, captions })
    }
  }
  return scenes.length === value.length ? scenes : undefined
}

/** Validate and normalize an unknown value into a v1 project. */
export function validateProject(input: unknown): ValidationResult {
  if (!isRecord(input)) return { ok: false, errors: ['project 必须是 JSON 对象'] }

  const errors: Errors = []
  if (input.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须为 ${SCHEMA_VERSION}`)
  }
  const id = readProjectId(input.id, errors)
  const title = readTitle(input.title, errors)
  const aspect = readAspect(input.aspect, errors)
  const fps = readFps(input.fps, errors)
  const style = readStyle(input.style, errors)
  const scenes = readScenes(input.scenes, errors)

  if (errors.length > 0 || id === undefined || title === undefined || aspect === undefined
    || fps === undefined || style === undefined || scenes === undefined) {
    return { ok: false, errors: errors.length > 0 ? errors : ['project 校验失败'] }
  }
  return {
    ok: true,
    project: {
      schemaVersion: SCHEMA_VERSION,
      id,
      title,
      aspect,
      fps,
      style,
      scenes,
    },
  }
}
