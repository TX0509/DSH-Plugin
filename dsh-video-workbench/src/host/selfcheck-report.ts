// Self-check report on disk.
//
// On startup the plugin runs `video_selfcheck` and leaves the latest result in
// the plugin data dir. That makes the M1 acceptance checkable without a token
// and without DevTools: read one JSON file after restarting DSH.

import fs from 'node:fs'
import path from 'node:path'

import { writeFileAtomic } from './atomic'

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
  const payload: SelfcheckReport = { ranAt: ranAt.toISOString(), ...result }
  writeFileAtomic(target, `${JSON.stringify(payload, null, 2)}\n`)
  return target
}

/** Read the last report; undefined when missing or not shaped like one. */
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
    // Validate the entries too: a hand-edited file must not reach consumers
    // shaped like a valid report.
    for (const check of report.checks) {
      if (typeof check !== 'object' || check === null) return undefined
      const entry = check as Partial<SelfcheckReport['checks'][number]>
      if (typeof entry.name !== 'string' || typeof entry.ok !== 'boolean'
        || typeof entry.detail !== 'string') {
        return undefined
      }
    }
    return report as SelfcheckReport
  } catch {
    return undefined
  }
}
