// Project store: create / read / write / list project.json under `projectsRoot`.
//
// Writes are atomic (temp file + rename) so a crash never leaves a half-written
// project.json behind, and reads always migrate before validating.

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { isFilesystemRoot } from '../paths'

import { migrateProject } from './migrate'
import type { Aspect, Fps, ProjectScene, ProjectStyle, ProjectV1 } from './schema'
import { validateProject } from './schema'

export const PROJECT_FILE = 'project.json'

/** Directories created inside every new project. */
export const PROJECT_SUBDIRS = ['composition', 'assets', 'renders'] as const

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u
const MAX_SLUG_ATTEMPTS = 1000

export type StoreResult =
  | { ok: true; project: ProjectV1 }
  | { ok: false; errors: string[] }

export interface CreateProjectInput {
  title: string
  aspect?: Aspect
  fps?: Fps
  style?: ProjectStyle
  scenes?: ProjectScene[]
}

export interface CreateProjectOptions {
  /** Injectable clock so tests do not depend on the real time. */
  now?: Date
}

export interface ProjectSummary {
  id: string
  title: string
  scenes: number
}

export interface ListProjectsResult {
  projects: ProjectSummary[]
  invalid: Array<{ id: string; errors: string[] }>
}

/**
 * Project directory name: local-time `YYYYMMDD-HHmmss`.
 * The directory is the immutable internal id; the title lives in project.json,
 * so renaming a project never invalidates composition or asset paths.
 */
export function slugFor(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** A scene that renders nothing; the starting point for a new project. */
export function defaultScene(id = 's1'): ProjectScene {
  return {
    id,
    text: '',
    durationSec: 3,
    media: { kind: 'none' },
    voice: { speed: 1 },
    captions: { enabled: true },
  }
}

/**
 * Resolve and create the project root.
 * Throws when the root is unusable; callers disable project features instead of
 * failing the whole host.
 */
export function ensureProjectRoot(root: string): string {
  const resolved = path.resolve(root)
  if (isFilesystemRoot(resolved)) {
    throw new Error(`projectsRoot 不能是盘符根目录: ${resolved}`)
  }
  fs.mkdirSync(resolved, { recursive: true })
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`projectsRoot 不是目录: ${resolved}`)
  }
  return resolved
}

function projectDir(root: string, id: string): string {
  if (!PROJECT_ID.test(id)) throw new Error(`项目 id 非法: ${id}`)
  return path.join(root, id)
}

/** Temp file + rename: readers see either the old or the new content. */
function writeJsonAtomic(target: string, value: unknown): void {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${randomBytes(6).toString('hex')}`)
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    fs.renameSync(temp, target)
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // The rename failure is the interesting one.
    }
    throw error
  }
}

/** Allocate `<timestamp>` (or `<timestamp>-2` on collision) and create it. */
function allocateProjectDir(root: string, now: Date): string {
  const base = slugFor(now)
  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
    const id = attempt === 1 ? base : `${base}-${attempt}`
    if (!PROJECT_ID.test(id)) continue
    try {
      fs.mkdirSync(path.join(root, id))
      return id
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('无法分配项目目录：同一秒内新建项目过多')
}

export function createProject(
  root: string,
  input: CreateProjectInput,
  options: CreateProjectOptions = {},
): StoreResult {
  const resolvedRoot = ensureProjectRoot(root)
  const now = options.now ?? new Date()
  const id = allocateProjectDir(resolvedRoot, now)
  const candidate: unknown = {
    schemaVersion: 1,
    id,
    title: input.title,
    aspect: input.aspect ?? '9:16',
    fps: input.fps ?? 30,
    style: input.style ?? { theme: 'default', captionStyle: 'default' },
    scenes: input.scenes ?? [defaultScene()],
  }
  const validated = validateProject(candidate)
  if (!validated.ok) {
    fs.rmSync(path.join(resolvedRoot, id), { recursive: true, force: true })
    return validated
  }
  const dir = projectDir(resolvedRoot, id)
  for (const sub of PROJECT_SUBDIRS) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  writeJsonAtomic(path.join(dir, PROJECT_FILE), validated.project)
  return { ok: true, project: validated.project }
}

/** Read, migrate and validate one project; `id` must match the directory name. */
export function readProject(root: string, id: string): StoreResult {
  const resolvedRoot = path.resolve(root)
  if (!PROJECT_ID.test(id)) return { ok: false, errors: [`项目 id 非法: ${id}`] }
  const file = path.join(projectDir(resolvedRoot, id), PROJECT_FILE)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { ok: false, errors: [`项目 ${id} 不存在或 project.json 不可读`] }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, errors: [`项目 ${id} 的 project.json 不是合法 JSON`] }
  }
  const migrated = migrateProject(raw)
  if (!migrated.ok) return migrated
  const validated = validateProject(migrated.value)
  if (!validated.ok) return validated
  if (validated.project.id !== id) {
    return { ok: false, errors: [`project.json 的 id（${validated.project.id}）与目录名（${id}）不一致`] }
  }
  return validated
}

/** Validate then write a project; creates the directory when it is missing. */
export function writeProject(root: string, value: unknown): StoreResult {
  const resolvedRoot = path.resolve(root)
  const validated = validateProject(value)
  if (!validated.ok) return validated
  const dir = projectDir(resolvedRoot, validated.project.id)
  fs.mkdirSync(dir, { recursive: true })
  writeJsonAtomic(path.join(dir, PROJECT_FILE), validated.project)
  return validated
}

/** Newest first; broken projects are reported instead of aborting the list. */
export function listProjects(root: string): ListProjectsResult {
  const resolvedRoot = path.resolve(root)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(resolvedRoot, { withFileTypes: true })
  } catch {
    return { projects: [], invalid: [] }
  }
  const projects: ProjectSummary[] = []
  const invalid: Array<{ id: string; errors: string[] }> = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !PROJECT_ID.test(entry.name)) continue
    const result = readProject(resolvedRoot, entry.name)
    if (result.ok) {
      projects.push({ id: entry.name, title: result.project.title, scenes: result.project.scenes.length })
    } else {
      invalid.push({ id: entry.name, errors: result.errors })
    }
  }
  projects.sort((left, right) => (left.id < right.id ? 1 : left.id > right.id ? -1 : 0))
  return { projects, invalid }
}
