// Filesystem path rules shared by the host routes and the project store.
// Keeping them in one module means the media route and the project root guard
// agree on what "inside the root" means.

import path from 'node:path'

/** Control characters plus the characters Windows reserves in file names. */
export const FORBIDDEN_NAME = /[<>:"|?*\u0000-\u001f]/u
export const MAX_SEGMENTS = 5
export const MAX_SEGMENT_LENGTH = 128

/**
 * Windows device names are unusable as file names anywhere in a path, with or
 * without an extension (`CON`, `con.mp4`, `LPT1.txt`). The console aliases and
 * the superscript device forms are reserved by the same rules.
 */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(\..*)?$/iu

export function isReservedName(segment: string): boolean {
  return WINDOWS_RESERVED.test(segment)
}

/** A configured root of `C:\` or `/` would expose the whole drive. */
export function isFilesystemRoot(candidate: string): boolean {
  const resolved = path.resolve(candidate)
  return path.parse(resolved).root === resolved
}

/** Case-insensitive on Windows; exact elsewhere. */
export function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  if (relative === '') return false
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false
  return true
}

/**
 * Resolve a client-supplied relative name under `root`.
 * Accepts Unicode names, rejects traversal, absolute paths, hidden files,
 * Windows-reserved characters, and names that would escape `root`.
 */
export function safeResolve(root: string, relative: string | null | undefined): string | undefined {
  const raw = String(relative ?? '')
  if (raw.length === 0 || raw.length > 512) return undefined
  const parts = raw.split(/[\\/]+/u).filter((part) => part.length > 0)
  if (parts.length === 0 || parts.length > MAX_SEGMENTS) return undefined
  for (const part of parts) {
    if (part.length > MAX_SEGMENT_LENGTH) return undefined
    if (part.startsWith('.') || part.endsWith('.') || part.endsWith(' ')) return undefined
    if (FORBIDDEN_NAME.test(part) || isReservedName(part)) return undefined
  }
  const resolved = path.resolve(root, ...parts)
  return contains(root, resolved) ? resolved : undefined
}
