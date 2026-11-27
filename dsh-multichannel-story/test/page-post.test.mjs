/**
 * scripts/page-post.mjs：网页后处理必须如实报告“有没有生效”。
 *
 * 这一段以前在 mcs.mjs 里，命中 0 次也打印“页脚已清理 / N 条规则”，
 * 所以这里的重点不是“能删掉页脚”，而是“没删掉时能被发现”。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { escapeAttribute, postProcessPage } from '../assets/multichannel-story/scripts/page-post.mjs'

const FOOTER = '<footer><p>归藏 Page · Built with constrained HTML</p></footer>'
const CAPS = [{ name: 'portrait.jpg', width: '660', height: '840' }]

test('整块页脚被删除，并报告删除数量', () => {
  const result = postProcessPage(`<html><head></head><body><p>x</p>${FOOTER}</body></html>`, [])
  assert.equal(result.footerRemoved, 1)
  assert.equal(result.leftoverFooter, false)
  assert.ok(!result.html.includes('constrained HTML'))
})

test('页脚标签结构变了但品牌串还在时报告 leftoverFooter', () => {
  const raw = '<html><head></head><body><footer class="site"><p>归藏 Page · Built with constrained HTML</p></footer></body></html>'
  const result = postProcessPage(raw, [])
  assert.equal(result.footerRemoved, 0, '不是整块匹配，就不该声称删掉了')
  assert.equal(result.leftoverFooter, true, '品牌串还在时必须报告')
})

test('页面本来就没有页脚：0 次删除，但不算残留', () => {
  const result = postProcessPage('<html><head></head><body><p>x</p></body></html>', [])
  assert.equal(result.footerRemoved, 0)
  assert.equal(result.leftoverFooter, false)
})

test('竖图规则插到 </head> 前面，并报告条数', () => {
  const result = postProcessPage('<html><head><title>t</title></head><body></body></html>', CAPS)
  assert.equal(result.figureRules, 1)
  assert.equal(result.figureCssInjected, true)
  assert.equal(result.headMissing, false)
  assert.match(result.html, /<style id="task-figure-tuning">/u)
  assert.ok(result.html.indexOf('task-figure-tuning') < result.html.indexOf('</head>'))
  assert.match(result.html, /max-width:660px/u)
  assert.match(result.html, /height:840px/u)
})

test('没有 </head> 时报告 headMissing，而不是假装插进去了', () => {
  const result = postProcessPage('<html><body><p>x</p></body></html>', CAPS)
  assert.equal(result.figureRules, 0)
  assert.equal(result.figureCssInjected, false)
  assert.equal(result.headMissing, true)
})

test('文件名里的引号与反斜杠被转义，规则不会被截断', () => {
  const result = postProcessPage('<html><head></head><body></body></html>', [
    { name: 'a"b\\c.jpg', width: '10', height: '20' },
  ])
  assert.match(result.html, /img\[src\*="a\\"b\\\\c\.jpg"\]/u)
})

test('没有竖图时不插入任何 CSS', () => {
  const result = postProcessPage('<html><head></head><body></body></html>', [])
  assert.equal(result.figureRules, 0)
  assert.equal(result.figureCssInjected, false)
  assert.equal(result.headMissing, false)
  assert.ok(!result.html.includes('task-figure-tuning'))
})

test('入参不是字符串时直接报错，避免把 undefined 拼进 HTML', () => {
  assert.throws(() => postProcessPage(undefined, []), /HTML 字符串/u)
  assert.throws(() => postProcessPage('<html></html>', 'nope'), /必须是数组/u)
})

test('文件名里的尖括号与换行被拒绝（否则会逃出 <style>）', () => {
  const html = '<html><head></head><body></body></html>'
  assert.throws(
    () => postProcessPage(html, [{ name: 'x</style><script>alert(1)</script>.jpg', width: '10', height: '20' }]),
    /非法字符/u,
  )
  assert.throws(
    () => postProcessPage(html, [{ name: 'a\nb.jpg', width: '10', height: '20' }]),
    /非法字符/u,
  )
  assert.throws(
    () => postProcessPage(html, [{ name: '', width: '10', height: '20' }]),
    /非空字符串/u,
  )
})

test('宽度/高度必须是像素数，不能把任意 CSS 拼进去', () => {
  const html = '<html><head></head><body></body></html>'
  assert.throws(
    () => postProcessPage(html, [{ name: 'a.jpg', width: '10px;background:url(evil)', height: '20' }]),
    /像素数/u,
  )
})

test('防御性转义：即使绕过上面的校验，尖括号也会被转成 CSS 转义序列', () => {
  assert.equal(escapeAttribute('<style>'), '\\3c style\\3e ')
  assert.equal(escapeAttribute('a\r\nb'), 'ab')
})
