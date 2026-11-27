/**
 * 「STYLES 色卡数据」豁免的共享实现。
 *
 * client.js 里唯一的字面色值是风格/配色表（内容主题的纸色与强调色，用来画预览色块），
 * 它由 `scripts/sync-themes.mjs` 生成在 `mcs:themes` 标记之间。检查「界面不允许写死颜色」
 * 的两处（scripts/check-package.cjs 与 test/client.test.mjs）都走这里，避免各写一份切片、
 * 各换一个锚点，最后悄悄把豁免范围撑大。
 *
 * 标记缺失时返回 ok=false、outside=原文：宁可让检查失败，也不要因为找不到标记就放行整个文件。
 */
'use strict'

const BEGIN = 'mcs:themes:begin'
const END = 'mcs:themes:end'

/**
 * @param {string} source client.js 全文
 * @returns {{ ok: boolean, outside: string, palette: string }} outside 是「不该出现字面色值」的部分
 */
function splitThemes(source) {
  const begin = source.indexOf(BEGIN)
  const end = source.indexOf(END)
  if (begin === -1 || end === -1 || end < begin) {
    return { ok: false, outside: source, palette: '' }
  }
  // 扩到标记所在整行，注释标记本身也归入数据区（否则标记里的 `mcs:themes` 会被误判）。
  const lineStart = source.lastIndexOf('\n', begin) + 1
  const lineEnd = source.indexOf('\n', end)
  const after = lineEnd === -1 ? source.length : lineEnd
  return {
    ok: true,
    outside: source.slice(0, lineStart) + source.slice(after),
    palette: source.slice(lineStart, after),
  }
}

module.exports = { splitThemes, BEGIN, END }
