// Render output naming, retention and export naming.
//
// All string logic is pure so the rules are testable without a filesystem; the
// job manager does the actual renames and deletions.

import path from 'node:path'

const RENDER_FILE = /^v([1-9][0-9]*)\.mp4$/u
/** Windows reserved characters plus control chars. */
const UNSAFE_TITLE = /[<>:"/\\|?*\u0000-\u001f]/gu

/** `v3.mp4` → 3; anything else → undefined. */
export function renderVersionOf(fileName: string): number | undefined {
  const match = RENDER_FILE.exec(fileName)
  if (match === null) return undefined
  const version = Number(match[1])
  return Number.isSafeInteger(version) ? version : undefined
}

/** Next free version: max existing + 1, starting at 1. */
export function nextRenderVersion(fileNames: string[]): number {
  let max = 0
  for (const name of fileNames) {
    const version = renderVersionOf(name)
    if (version !== undefined && version > max) max = version
  }
  return max + 1
}

export function renderFileName(version: number): string {
  return `v${version}.mp4`
}

/**
 * Hidden temp file the renderer writes before the atomic rename.
 * The name keeps the `.mp4` suffix: hyperframes infers the container from the
 * output extension and refuses anything else.
 */
export function tempRenderPath(rendersDir: string, version: number, random: string): string {
  return path.join(rendersDir, `.v${version}.tmp-${random}.mp4`)
}

/** Versions to delete: keep the newest `keep`, drop the rest (only `vN.mp4`). */
export function expiredRenders(fileNames: string[], keep: number): string[] {
  if (keep < 1) return []
  const versioned = fileNames
    .map((name) => ({ name, version: renderVersionOf(name) }))
    .filter((entry): entry is { name: string; version: number } => entry.version !== undefined)
    .sort((left, right) => right.version - left.version)
  return versioned.slice(keep).map((entry) => entry.name)
}

/**
 * `safeTitle`: strip Windows-reserved characters, collapse whitespace to `-`,
 * cap at 40 characters, and fall back to the slug when nothing remains.
 */
export function safeTitle(title: string, fallback: string): string {
  const cleaned = title
    .replace(UNSAFE_TITLE, ' ')
    .replace(/\s+/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '')
  const trimmed = [...cleaned].slice(0, 40).join('').replace(/[-.]+$/gu, '')
  return trimmed === '' ? fallback : trimmed
}

/** Export file name, bumped with `-2`, `-3` … so an existing export is never overwritten. */
export function exportFileName(
  slug: string,
  title: string,
  version: number,
  existing: string[],
): string {
  const base = `${slug}-${safeTitle(title, slug)}-v${version}`
  const taken = new Set(existing.map((name) => name.toLowerCase()))
  let candidate = `${base}.mp4`
  let counter = 2
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${base}-${counter}.mp4`
    counter += 1
  }
  return candidate
}
