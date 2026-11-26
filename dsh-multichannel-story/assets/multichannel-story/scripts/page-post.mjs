/**
 * 网页后处理：删除工具品牌页脚、按栏宽收窄竖幅人像。
 *
 * 单独成文件是为了能单测：这段逻辑以前写在 mcs.mjs 里，命中 0 次也照样打印
 * “页脚已清理 / N 条规则”，把“没做”说成“做了”。现在它只返回事实
 * （删了几处、CSS 有没有真插进去、页脚是不是还残留），由调用方决定失败还是警告。
 *
 * 纯函数：不读盘、不打印、不改入参。
 */

/** 渲染器输出的工具页脚整块标签（中英文各一份），整块删除。 */
const TOOL_FOOTER_BLOCKS = [
  '<footer><p>归藏 Page · Built with constrained HTML</p></footer>',
  '<footer><p>歸藏 Page · Built with constrained HTML</p></footer>',
]

/** 页脚品牌串：即使标签结构变了，只要还能看到这个串就说明没清干净。 */
const TOOL_FOOTER_MARKERS = [
  '归藏 Page · Built with constrained HTML',
  '歸藏 Page · Built with constrained HTML',
]

/** CSS 属性选择器里的双引号与反斜杠必须转义，否则文件名会把规则截断。 */
function escapeAttribute(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

/**
 * 对渲染结果做两条后处理，并如实报告是否生效。
 * @param {string} html - 渲染器写出的完整 HTML。
 * @param {ReadonlyArray<{name: string, width: string, height: string}>} [figureCaps] - 需要收窄的竖图。
 * @returns {{html: string, footerRemoved: number, leftoverFooter: boolean, figureRules: number, figureCssInjected: boolean, headMissing: boolean}}
 *   `leftoverFooter` 为 true 表示页脚还留在页面里；`headMissing` 为 true 表示有规则但页面没有 `</head>`，
 *   CSS 无处可插。两种都需要调用方按失败处理，而不是继续打印成功。
 */
export function postProcessPage(html, figureCaps = []) {
  if (typeof html !== 'string') throw new TypeError('postProcessPage 需要 HTML 字符串')
  if (!Array.isArray(figureCaps)) throw new TypeError('postProcessPage 的 figureCaps 必须是数组')

  let next = html
  let footerRemoved = 0
  for (const block of TOOL_FOOTER_BLOCKS) {
    const parts = next.split(block)
    const hits = parts.length - 1
    if (hits === 0) continue
    footerRemoved += hits
    next = parts.join('')
  }
  const leftoverFooter = TOOL_FOOTER_MARKERS.some((marker) => next.includes(marker))

  let figureRules = 0
  let figureCssInjected = false
  if (figureCaps.length > 0 && next.includes('</head>')) {
    const rules = []
    for (const cap of figureCaps) {
      const attribute = escapeAttribute(cap?.name ?? '')
      const width = String(cap?.width ?? '').trim()
      const height = String(cap?.height ?? '').trim()
      rules.push(`.section > .figure-card:has(img[src*="${attribute}"]){max-width:${width}px;margin-left:auto;margin-right:auto}`)
      rules.push(`.section > .figure-card:has(img[src*="${attribute}"]) img{width:100%;height:${height}px;object-fit:cover;object-position:center 18%}`)
    }
    const css = `<style id="task-figure-tuning">\n${rules.join('\n')}\n</style>\n`
    next = next.replace('</head>', `${css}</head>`)
    figureRules = figureCaps.length
    figureCssInjected = true
  }

  return {
    html: next,
    footerRemoved,
    leftoverFooter,
    figureRules,
    figureCssInjected,
    headMissing: figureCaps.length > 0 && !figureCssInjected,
  }
}
