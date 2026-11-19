// Atomic file write: temp file in the same directory, then rename.
//
// Readers see either the old content or the new one, and a failed write never
// leaves a temp file behind — including when writing the temp file itself fails
// (ENOSPC, EACCES, quota), which the previous copies of this logic missed.

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Write `text` to `target` atomically; the parent directory must exist. */
export function writeFileAtomic(target: string, text: string): void {
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.tmp-${randomBytes(6).toString('hex')}`,
  )
  try {
    fs.writeFileSync(temp, text, 'utf8')
    fs.renameSync(temp, target)
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // The original failure is the interesting one.
    }
    throw error
  }
}
