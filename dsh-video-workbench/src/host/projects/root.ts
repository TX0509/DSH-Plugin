// `projectsRoot` resolution: the project feature is all-or-nothing.
//
// A configured filesystem root would expose a whole drive, so it is refused
// instead of silently falling back somewhere else: the user picked the path.

import fs from 'node:fs'
import path from 'node:path'

import { isFilesystemRoot } from '../paths'

/** `ready` = usable; `unset` = not configured; `invalid` = configured but unusable. */
export type ProjectsState = 'ready' | 'unset' | 'invalid'

export interface ProjectsConfig {
  state: ProjectsState
  root?: string
  /** Local-only diagnostic (may contain an absolute path); never sent to a page. */
  detail?: string
}

/**
 * Resolve and create `projectsRoot`.
 * Throws nothing: an unusable root disables the project feature while the
 * media route keeps working.
 */
export function resolveProjectsRoot(configured: string | undefined): ProjectsConfig {
  if (typeof configured !== 'string' || configured.trim().length === 0) {
    return { state: 'unset' }
  }
  const candidate = path.resolve(configured.trim())
  if (isFilesystemRoot(candidate)) {
    return { state: 'invalid', detail: `projectsRoot "${candidate}" 是盘符根目录，项目功能已禁用` }
  }
  try {
    fs.mkdirSync(candidate, { recursive: true })
    if (!fs.statSync(candidate).isDirectory()) {
      return { state: 'invalid', detail: `projectsRoot 不是目录: ${candidate}` }
    }
  } catch (error) {
    return { state: 'invalid', detail: `projectsRoot 不可用: ${candidate}（${String(error)}）` }
  }
  return { state: 'ready', root: candidate }
}
