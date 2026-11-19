// Default composition scaffold.
//
// M2 only needs *a* composition that renders: scenes become time windows inside
// one composition element, which is the contract hyperframes 0.6.33 accepted in
// the M2 probe (`data-composition-id/width/height/start/duration` on the root
// and `data-start`/`data-duration` windows inside it). No CDN scripts, so the
// render works fully offline.
//
// M3/M4 replace this with a real HyperFrames composition; the agent may rewrite
// `composition/index.html` at any time, so this file is only a starting point.

import path from 'node:path'

/**
 * Entry file hyperframes looks for: `index.html` at the project root.
 * Verified with hyperframes 0.6.33 — `render <DIR>` rejects a project whose root
 * has no index.html, and `-c` only selects a file *inside* that directory.
 * `composition/` stays reserved for sub-blocks (M4).
 */
export const COMPOSITION_FILE = 'index.html'

export interface ScaffoldScene {
  id: string
  text: string
  durationSec: number
  media?: { kind: 'none' | 'image' | 'video'; asset?: string }
}

export interface ScaffoldInput {
  title: string
  aspect: '9:16' | '16:9'
  scenes: ScaffoldScene[]
}

/** 1080×1920 portrait, 1920×1080 landscape. */
export const SIZE_BY_ASPECT = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
} as const

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Asset path relative to the project-root `index.html`. */
function assetUrl(asset: string): string {
  return asset.split('/').map(encodeURIComponent).join('/')
}

/** Render the scaffold HTML for a project. Deterministic: same input → same output. */
export function scaffoldCompositionHtml(input: ScaffoldInput): string {
  const size = SIZE_BY_ASPECT[input.aspect]
  const scenes = input.scenes.length === 0
    ? [{ id: 's1', text: input.title, durationSec: 3, media: { kind: 'none' as const } }]
    : input.scenes
  const duration = scenes.reduce((total, scene) => total + scene.durationSec, 0)
  let cursor = 0
  const windows = scenes.map((scene) => {
    const start = cursor
    cursor += scene.durationSec
    const media = scene.media?.kind === 'image' && scene.media.asset !== undefined
      ? `<img class="media" src="${escapeHtml(assetUrl(scene.media.asset))}" alt="" />`
      : scene.media?.kind === 'video' && scene.media.asset !== undefined
        ? `<video class="media" src="${escapeHtml(assetUrl(scene.media.asset))}" muted></video>`
        : ''
    return [
      `      <section class="scene clip" id="scene-${escapeHtml(scene.id)}" data-scene="${escapeHtml(scene.id)}" data-start="${start}" data-duration="${scene.durationSec}">`,
      media,
      `        <p class="text">${escapeHtml(scene.text)}</p>`,
      '      </section>',
    ].join('\n')
  })

  const DURATION = Number(duration.toFixed(3))
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${size.width}, height=${size.height}" />
    <title>${escapeHtml(input.title)}</title>
    <style>
      html, body { margin: 0; padding: 0; width: ${size.width}px; height: ${size.height}px; overflow: hidden; }
      /* Generic family only: a named web font makes hyperframes fetch Google Fonts. */
      body { background: #101418; color: #f5f5f5; font-family: sans-serif; }
      .scene { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 48px; animation: sceneIn .45s ease-out both;
               align-items: center; justify-content: center; padding: 96px; box-sizing: border-box; }
      .media { max-width: 100%; max-height: 70%; object-fit: contain; }
      .text { margin: 0; font-size: 72px; line-height: 1.3; text-align: center; white-space: pre-wrap; }
      /* CSS animations are seeked deterministically by hyperframes.' css adapter;
         data-start shifts the animation origin per scene. */
      @keyframes sceneIn { from { opacity: 0; transform: translateY(40px); } to { opacity: 1; transform: translateY(0); } }
    </style>
  </head>
  <body>
    <div
      data-composition-id="main-video"
      data-width="${size.width}"
      data-height="${size.height}"
      data-start="0"
      data-duration="${Number(duration.toFixed(3))}"
    >
${windows.join('\n')}
    </div>
    <script>
      // hyperframes requires every composition id to register a paused timeline;
      // without one the renderer waits 45s before giving up on it. CSS animations
      // are seeked by its own adapter, so a minimal contract object is enough.
      window.__timelines = window.__timelines || {};
      var DURATION = ${Number(duration.toFixed(3))};
      window.__timelines["main-video"] = {
        duration: function () { return DURATION },
        totalDuration: function () { return DURATION },
        time: function () { return 0 },
        totalTime: function () { return this },
        seek: function () { return this },
        pause: function () { return this },
        play: function () { return this }
      };
    </script>
  </body>
</html>
`
}
