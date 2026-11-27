/**
 * MANIFEST 用的文件哈希：文本按「CRLF 归一成 LF」后再算 sha256。
 *
 * 为什么不一刀切哈希字节：同一个包在 Windows 上被检出/解压时可能拿到 CRLF，
 * 那样 `assets match MANIFEST` 会整份失配，而内容其实没变。归一化之后：
 *   - LF 文件（macOS / Linux / 已按 .gitattributes 检出的 Windows）哈希不变；
 *   - CRLF 检出的文本文件与 LF 版本哈希一致；
 *   - 图片等二进制、以及非法 UTF-8 的文件仍按原始字节哈希，不会把损坏内容放行。
 * 已知取舍：纯行尾变化（LF↔CRLF）不会再被判成「手改内容」，这是为了让清单跨平台稳定。
 * sync-assets.mjs（写清单）、check-package.cjs 与两个测试（读清单）必须共用这一份，
 * 否则同一台机器上会出现「生成通过、校验失败」。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { isUtf8 } = require('node:buffer')

/** 副本里会出现的文本扩展名；其余按二进制处理。 */
const TEXT_EXTENSIONS = new Set([
  '.md', '.mjs', '.js', '.cjs', '.json', '.sh', '.py', '.txt', '.yml', '.yaml', '.css', '.html', '.svg',
])

/**
 * @param {string} file 绝对路径
 * @returns {string} sha256（hex）
 */
function hashFile(file) {
  const raw = fs.readFileSync(file)
  // 非文本扩展名、或内容根本不是 UTF-8（例如损坏的 .md）时按原始字节算：
  // 有损解码会把不同的坏文件收敛成同一串字符，归一化也会改变它的字节。
  if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()) || !isUtf8(raw)) {
    return createHash('sha256').update(raw).digest('hex')
  }
  const text = raw.toString('utf8')
  const normalized = text.includes('\r\n') ? text.replace(/\r\n/g, '\n') : text
  return createHash('sha256').update(Buffer.from(normalized, 'utf8')).digest('hex')
}

module.exports = { hashFile, TEXT_EXTENSIONS }
