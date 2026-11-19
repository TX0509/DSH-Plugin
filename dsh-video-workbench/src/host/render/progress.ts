// `hyperframes render` progress parsing.
//
// Observed output (M0, v0.6.33) mixes ANSI cursor control, carriage returns and
// a percentage bar; the phases are:
//   Rendering <name> → <path>            (start)
//   … Capturing frame 120/300 (2 workers)
//   … Encoding video
//   … Assembling final video
//   … Render complete
// Anything unrecognised is ignored: a wording change must never fail a render.

export type RenderPhase = 'preparing' | 'capturing' | 'encoding' | 'assembling' | 'done'

export interface ProgressUpdate {
  phase: RenderPhase
  /** Monotonic 0–100. */
  percent: number
  frames?: number
  totalFrames?: number
  /** A non-fatal `⚠` line from hyperframes (lint warnings). */
  warning?: string
}

/** Percent floors per phase, so the bar never jumps backwards. */
const PHASE_FLOOR: Record<RenderPhase, number> = {
  preparing: 5,
  capturing: 0,
  encoding: 75,
  assembling: 90,
  done: 100,
}

// CSI sequences (colors, erase-line, cursor show/hide) plus a leading BOM.
const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])/gu

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(/^\uFEFF/u, '')
}

/** Parse one cleaned line; undefined when it carries no progress information. */
export function parseProgressLine(input: string): ProgressUpdate | undefined {
  const line = stripAnsi(input).trim()
  if (line === '') return undefined

  const warning = /^[⚠!]\s*(?:\[[^\]]*\]\s*)?(.+)$/u.exec(line)
  if (warning !== null) return { phase: 'capturing', percent: 0, warning: warning[1].trim() }

  if (/^Rendering\b/u.test(line)) return { phase: 'preparing', percent: PHASE_FLOOR.preparing }

  const capturing = /Capturing frame\s+(\d+)\s*\/\s*(\d+)/u.exec(line)
  if (capturing !== null) {
    const frames = Number(capturing[1])
    const totalFrames = Number(capturing[2])
    if (!Number.isSafeInteger(frames) || !Number.isSafeInteger(totalFrames) || totalFrames <= 0) return undefined
    // Capturing covers 5–74%, leaving room for the two encode phases.
    const percent = Math.min(74, PHASE_FLOOR.preparing + Math.floor((frames / totalFrames) * 69))
    return { phase: 'capturing', percent, frames, totalFrames }
  }
  if (/Encoding video/iu.test(line)) return { phase: 'encoding', percent: PHASE_FLOOR.encoding }
  if (/Assembling final video/iu.test(line)) return { phase: 'assembling', percent: PHASE_FLOOR.assembling }
  if (/Render complete/iu.test(line)) return { phase: 'done', percent: PHASE_FLOOR.done }
  return undefined
}

/**
 * Stateful parser for a streaming stdout: buffers partial lines, splits on CR/LF,
 * and only reports forward progress.
 */
export function createProgressParser(): {
  feed(chunk: string): ProgressUpdate[]
  last(): ProgressUpdate | undefined
  warnings(): string[]
} {
  let buffer = ''
  let current: ProgressUpdate | undefined
  const warnings: string[] = []

  const accept = (update: ProgressUpdate): ProgressUpdate | undefined => {
    if (update.warning !== undefined) {
      warnings.push(update.warning)
      return { phase: current?.phase ?? 'capturing', percent: current?.percent ?? 0, warning: update.warning }
    }
    if (current !== undefined) {
      if (update.phase === current.phase && update.percent <= current.percent) return undefined
      if (update.percent < current.percent) return undefined
    }
    current = update
    return update
  }

  return {
    feed(chunk) {
      buffer += chunk
      const parts = buffer.split(/\r\n|\n|\r/u)
      buffer = parts.pop() ?? ''
      const updates: ProgressUpdate[] = []
      for (const part of parts) {
        const parsed = parseProgressLine(part)
        if (parsed === undefined) continue
        const accepted = accept(parsed)
        if (accepted !== undefined) updates.push(accepted)
      }
      return updates
    },
    last: () => current,
    warnings: () => [...warnings],
  }
}
