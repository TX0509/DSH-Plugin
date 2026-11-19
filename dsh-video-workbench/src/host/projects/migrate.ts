// Schema-version migration for project.json.
//
// M1 knows only version 1. Files written before versioning (or hand-written by
// an agent) may omit `schemaVersion`; those are treated as v1. Anything newer
// than this build is refused instead of being silently downgraded.

import { SCHEMA_VERSION } from './schema'

export type MigrateResult =
  | { ok: true; value: unknown; from: number }
  | { ok: false; errors: string[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalize `schemaVersion` so the validator only ever sees the current one. */
export function migrateProject(raw: unknown): MigrateResult {
  if (!isRecord(raw)) return { ok: false, errors: ['project.json 必须是 JSON 对象'] }

  const version = raw.schemaVersion
  if (version === undefined) {
    // Pre-versioning file or an agent that omitted the field: assume v1.
    // `from: 0` records "no version was written" instead of claiming v1.
    return { ok: true, value: { ...raw, schemaVersion: SCHEMA_VERSION }, from: 0 }
  }
  if (version === SCHEMA_VERSION) return { ok: true, value: raw, from: SCHEMA_VERSION }
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return { ok: false, errors: [`schemaVersion 必须是整数，收到 ${JSON.stringify(version)}`] }
  }
  return {
    ok: false,
    errors: [`不支持的 schemaVersion ${version}：本插件最高支持 ${SCHEMA_VERSION}，请升级插件或新开项目`],
  }
}
