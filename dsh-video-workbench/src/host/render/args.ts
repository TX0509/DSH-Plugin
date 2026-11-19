// `hyperframes render` argv construction.
//
// Arguments come from the CLI's own help (v0.6.33) and are always passed as an
// argv array — never as a shell string — so project paths and titles cannot
// inject flags or commands.
//
// Observed help excerpt (v0.6.33):
//   hyperframes render [OPTIONS] [DIR]
//     -c, --composition   composition file instead of index.html
//     -o, --output        output path (renders are written atomically by caller)
//     -f, --fps           1-240, default 30
//     -q, --quality       draft | standard | high (default standard)
//     -w, --workers       parallel workers ('auto' allowed)
//     --format            mp4 (M2 only)
//     --resolution        landscape | portrait | … (must match the composition)

import path from 'node:path'

import type { Aspect } from '../projects/schema'

export type RenderQuality = 'draft' | 'standard' | 'high'
export const RENDER_QUALITIES: readonly RenderQuality[] = ['draft', 'standard', 'high']

/** 9:16 → portrait, 16:9 → landscape (hyperframes preset names). */
export const RESOLUTION_BY_ASPECT: Record<Aspect, string> = {
  '9:16': 'portrait',
  '16:9': 'landscape',
}

const MIN_FPS = 1
const MAX_FPS = 240
const MAX_WORKERS = 8

export interface RenderArgsInput {
  /** Node executable that runs the CLI. */
  nodePath: string
  /** `<runtime>/node_modules/hyperframes/dist/cli.js`. */
  cliPath: string
  /** Project directory; also the child process cwd. */
  projectDir: string
  /** Composition entry, inside `projectDir` (usually `composition/index.html`). */
  compositionPath: string
  /** Output file; must stay inside `<projectDir>/renders`. */
  outputPath: string
  fps: number
  aspect: Aspect
  quality?: RenderQuality
  workers?: number
}

/** Build the render argv; throws on input that would escape the project. */
export function buildRenderArgs(input: RenderArgsInput): string[] {
  for (const [name, value] of Object.entries({
    nodePath: input.nodePath,
    cliPath: input.cliPath,
    projectDir: input.projectDir,
    compositionPath: input.compositionPath,
    outputPath: input.outputPath,
  })) {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`render: ${name} 不能为空`)
  }
  if (!Number.isSafeInteger(input.fps) || input.fps < MIN_FPS || input.fps > MAX_FPS) {
    throw new Error(`render: fps 必须是 ${MIN_FPS}–${MAX_FPS} 的整数`)
  }
  const quality = input.quality ?? 'standard'
  if (!RENDER_QUALITIES.includes(quality)) {
    throw new Error(`render: quality 必须是 ${RENDER_QUALITIES.join(' / ')}`)
  }
  const workers = input.workers ?? 2
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > MAX_WORKERS) {
    throw new Error(`render: workers 必须是 1–${MAX_WORKERS} 的整数`)
  }
  const resolution = RESOLUTION_BY_ASPECT[input.aspect]
  if (resolution === undefined) throw new Error('render: aspect 必须是 9:16 或 16:9')

  const projectDir = path.resolve(input.projectDir)
  const composition = inside(projectDir, input.compositionPath, 'compositionPath')
  const output = inside(path.join(projectDir, 'renders'), input.outputPath, 'outputPath')

  return [
    input.nodePath,
    input.cliPath,
    'render',
    projectDir,
    '--composition', path.relative(projectDir, composition),
    '--output', output,
    '--fps', String(input.fps),
    '--quality', quality,
    '--workers', String(workers),
    '--format', 'mp4',
    '--resolution', resolution,
  ]
}

/** Resolve `candidate` and prove it stays under `root`. */
function inside(root: string, candidate: string, field: string): string {
  const resolved = path.resolve(candidate)
  const relative = path.relative(root, resolved)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`render: ${field} 必须位于 ${root} 之内`)
  }
  return resolved
}
