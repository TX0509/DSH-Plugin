// Self-check report on disk.
//
// On startup the plugin runs `video_selfcheck` and leaves the latest result in
// the plugin data dir. That makes the M1 acceptance checkable without a token
// and without DevTools: read one JSON file after restarting DSH.

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { SelfcheckResult } from './selfcheck'

export const SELFCHECK_REPORT = 'selfcheck.json'

export interface SelfcheckReport extends SelfcheckResult {
  /** ISO-8601 timestamp of the run. */
  ranAt: string
}

/** Write the report atomically; returns the file path. */
export function writeSelfcheckReport(
  dataDir: string,
  result: SelfcheckResult,
  ranAt: Date = new Date(),
): string {
  const target = path.join(dataDir, SELFCHECK_REPORT)
  fs.mkdirSync(dataDir, { recursive: true })
  const temp = path.join(dataDir, `.${SELFCHECK_REPORT}.tmp-${randomBytes(6).toString('hex')}`)
  const payload: SelfcheckReport = { ranAt: ranAt.toISOString(), ...result }
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
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
  return target
}

/** Read the last report; undefined when missing or unreadable. */
export function readSelfcheckReport(dataDir: string): SelfcheckReport | undefined {
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(dataDir, SELFCHECK_REPORT), 'utf8'),
    )
    if (typeof raw !== 'object' || raw === null) return undefined
    const report = raw as Partial<SelfcheckReport>
    if (typeof report.ranAt !== 'string' || typeof report.ok !== 'boolean'
      || !Array.isArray(report.checks)) {
      return undefined
    }
    return report as SelfcheckReport
  } catch {
    return undefined
  }
}
