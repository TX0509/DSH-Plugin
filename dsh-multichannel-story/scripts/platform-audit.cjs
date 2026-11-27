/**
 * 跨平台（macOS / Windows）静态审计：把「会让 Windows 直接坏掉」的几件事集中成一份实现，
 * 由 scripts/check-package.cjs 与 test/platform.test.mjs 共用，避免两边各维护一份清单和正则。
 *
 * 诚实边界：这里只能证明「代码里没有已知的 POSIX 依赖」，不能证明 Windows 真机跑通。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** 扫描时跳过自己：审计代码里必然包含要搜索的模式（即使做了转义处理）。 */
const SELF = 'platform-audit.cjs'

/** 家目录只能走 node:os 的 homedir()；Windows 上没有 HOME。 */
const HOME_RE = /process\.env\.HOME\b/u

/** 不要打开 shell 选项、也不要用同步 exec 拼命令：Windows 的 cmd 不是 POSIX shell。 */
const SHELL_RE = /\bshell:\s*true\b|\bexecSync\s*\(|\bexecFileSync\s*\(/u

/** Windows 的目录链接必须用 junction。 */
const JUNCTION_RE = /process\.platform === 'win32' \? 'junction' : 'dir'/u

/**
 * 需要跨平台运行的 Node 入口（.sh 薄壳只给 POSIX，不在此列）。
 * 自动遍历目录，新增脚本不需要再改这里。
 * @param {string} pkg 包目录
 * @returns {string[]} 相对路径（正斜杠）
 */
function nodeEntries(pkg) {
  const dirs = [['scripts'], ['assets', 'multichannel-story', 'scripts']]
  const entries = []
  for (const parts of dirs) {
    const abs = path.join(pkg, ...parts)
    if (!fs.existsSync(abs)) continue
    for (const name of fs.readdirSync(abs).sort()) {
      if (name === SELF || !/\.(?:mjs|cjs)$/u.test(name)) continue
      entries.push(parts.concat(name).join('/'))
    }
  }
  return entries
}

/**
 * @param {string} pkg 包目录
 * @returns {{ label: string, ok: boolean, detail?: string }[]}
 */
function auditPlatform(pkg) {
  const read = (relative) => fs.readFileSync(path.join(pkg, relative), 'utf8')
  const exists = (relative) => fs.existsSync(path.join(pkg, relative))
  const results = []
  const push = (label, ok, detail = '') => {
    results.push(detail === '' ? { label, ok } : { label, ok, detail })
  }

  const attributes = exists('.gitattributes') ? read('.gitattributes') : ''
  push('.gitattributes pins text files to LF', /\*\s+text=auto\s+eol=lf/u.test(attributes))
  push(
    '.gitattributes marks screenshots and icons binary',
    /\.png\s+binary/u.test(attributes) && /\.ico\s+binary/u.test(attributes),
  )

  const entries = nodeEntries(pkg)
  const homeMisuse = entries.filter((relative) => HOME_RE.test(read(relative)))
  push('home comes from os.homedir(), not $HOME', homeMisuse.length === 0, homeMisuse.join(', '))

  const shellSpawn = entries.filter((relative) => SHELL_RE.test(read(relative)))
  push('child processes never go through a shell', shellSpawn.length === 0, shellSpawn.join(', '))

  const installer = exists('scripts/install.mjs') ? read('scripts/install.mjs') : ''
  push('installer links with junctions on Windows', JUNCTION_RE.test(installer))

  const readme = exists('README.md') ? read('README.md') : ''
  push('README has a supported-platform section', /^## 支持平台$/mu.test(readme))
  push('README names macOS and Windows', /macOS/u.test(readme) && /Windows/u.test(readme))

  return results
}

module.exports = { auditPlatform, nodeEntries }
