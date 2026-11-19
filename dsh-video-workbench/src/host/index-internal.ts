// Host-only helpers that the route modules need from the plugin entry point.
//
// `tokenEquals` lives in index.ts (it is re-exported for tests). Importing it
// from there would create a cycle (index → routes → index), so routes import it
// from this leaf module and index re-exports it.

import { timingSafeEqual } from 'node:crypto'

export function tokenEquals(supplied: string | undefined, expected: string): boolean {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false
  if (supplied.length === 0 || expected.length === 0) return false
  const left = Buffer.from(supplied)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}
