// Project store: create / read / write / list project.json under `projectsRoot`.
//
// Writes are atomic (temp file + rename) so a crash never leaves a half-written
// project.json behind, and reads always migrate before validating.
// Every entry point reports failures as `{ ok: false, errors }`; none of them
// throws at the caller.

import fs from 'node:fs'
import path from 'node:path'

import { writeFileAtomic } from '../atomic'
import { isFilesystemRoot } from '../paths'

import { migrateProject } from './migrate'
import type { Aspect, Fps, ProjectScene, ProjectStyle, ProjectV1 } from './schema'
import { isProjectId, validateProject } from './schema'

export const PROJECT_FILE = 'project.json'

/** Directories created inside every new project. */
export const PROJECT_SUBDIRS = ['composition', 'assets', 'renders'] as const

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
  if (!isProjectId(id)) throw new Error(`项目 id 非法: ${id}`)
  return path.join(root, id)
}

/** Serialize then write atomically: readers see the old or the new file. */
function writeJsonAtomic(target: string, value: unknown): void {
  writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`)
}

/** The directory skeleton every project has, whether it is created or updated. */
function createProjectLayout(dir: string): void {
  for (const sub of PROJECT_SUBDIRS) fs.mkdirSync(path.join(dir, sub), { recursive: true })
}

/**
 * Write project.json into `dir`.
 * When this call created the directory, a failed write removes it again so no
 * empty project directory is left behind.
 * Exported so tests can drive the cleanup path directly.
 */
export function persistProject(dir: string, project: ProjectV1, createdDir: boolean): void {
  try {
    writeJsonAtomic(path.join(dir, PROJECT_FILE), project)
  } catch (error) {
    if (createdDir) fs.rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Allocate `<timestamp>` (or `<timestamp>-2` on collision) and create it. */
function allocateProjectDir(root: string, now: Date): string {
  const base = slugFor(now)
  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
    const id = attempt === 1 ? base : `${base}-${attempt}`
    if (!isProjectId(id)) continue
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
  let resolvedRoot: string
  try {
    resolvedRoot = ensureProjectRoot(root)
  } catch (error) {
    return { ok: false, errors: [errorMessage(error)] }
  }
  const now = options.now ?? new Date()
  let id: string
  try {
    id = allocateProjectDir(resolvedRoot, now)
  } catch (error) {
    return { ok: false, errors: [errorMessage(error)] }
  }
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
  try {
    createProjectLayout(dir)
    persistProject(dir, validated.project, true)
  } catch (error) {
    // `persistProject` already removed a directory it created; this also covers
    // a layout failure that happened before the write.
    fs.rmSync(dir, { recursive: true, force: true })
    return { ok: false, errors: [errorMessage(error)] }
  }
  return { ok: true, project: validated.project }
}

/** Read, migrate and validate one project; `id` must match the directory name. */
export function readProject(root: string, id: string): StoreResult {
  const resolvedRoot = path.resolve(root)
  if (!isProjectId(id)) return { ok: false, errors: [`项目 id 非法: ${id}`] }
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
  const validated = validateProject(value)
  if (!validated.ok) return validated
  let resolvedRoot: string
  try {
    // Same guard as createProject: a filesystem root would write to a drive root.
    resolvedRoot = ensureProjectRoot(root)
  } catch (error) {
    return { ok: false, errors: [errorMessage(error)] }
  }
  const dir = projectDir(resolvedRoot, validated.project.id)
  const createdDir = !fs.existsSync(dir)
  try {
    createProjectLayout(dir)
    persistProject(dir, validated.project, createdDir)
  } catch (error) {
    // Layout creation can fail after some subdirectories exist; remove only the
    // directory this call created, never an existing project.
    if (createdDir) fs.rmSync(dir, { recursive: true, force: true })
    return { ok: false, errors: [errorMessage(error)] }
  }
  return validated
}

/**
 * Newest first. Ids are `<timestamp>` or `<timestamp>-<n>` for same-second
 * collisions, so the collision counter is compared numerically — plain string
 * order would put `…-2` before `…-10`.
 */
function compareNewestFirst(left: string, right: string): number {
  const split = (id: string): { base: string; attempt: number } => {
    const match = /^(.*)-([1-9][0-9]*)$/u.exec(id)
    return match === null
      ? { base: id, attempt: 1 }
      : { base: match[1], attempt: Number(match[2]) }
  }
  const a = split(left)
  const b = split(right)
  if (a.base !== b.base) return a.base < b.base ? 1 : -1
  return b.attempt - a.attempt
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
    if (!entry.isDirectory() || !isProjectId(entry.name)) continue
    const result = readProject(resolvedRoot, entry.name)
    if (result.ok) {
      projects.push({ id: entry.name, title: result.project.title, scenes: result.project.scenes.length })
    } else {
      invalid.push({ id: entry.name, errors: result.errors })
    }
  }
  projects.sort((left, right) => compareNewestFirst(left.id, right.id))
  return { projects, invalid }
}
