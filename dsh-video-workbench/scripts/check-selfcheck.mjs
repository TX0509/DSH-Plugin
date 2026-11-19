#!/usr/bin/env node
/**
 * Print the last startup `video_selfcheck` report and exit non-zero unless it
 * passed. Run it after a full DSH restart: the plugin writes the report about
 * three seconds after the web listener binds.
 */
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
  ? path.resolve(process.env.DSH_HOME)
  : path.join(os.homedir(), '.dsh')
const file = path.join(home, 'cache', 'dsh-video-workbench', 'selfcheck.json')

let report
try {
  report = JSON.parse(readFileSync(file, 'utf8'))
} catch {
  console.error(`没有找到自检报告：${file}`)
  console.error('先完全退出并重新打开 DSH，等约 3 秒后再运行本脚本。')
  process.exit(1)
}

console.log(`报告：${file}`)
const checks = Array.isArray(report.checks) ? report.checks : []
const skipped = checks.filter((check) => check.skipped === true).length
console.log(`时间：${report.ranAt ?? '?'}    结果：${report.ok === true ? 'ok' : 'FAILED'}`
  + `${skipped === 0 ? '' : `    （${skipped} 项跳过）`}`)
for (const check of checks) {
  const mark = check.skipped === true ? '–' : check.ok === true ? '✔' : '✖'
  console.log(`${mark} ${check.name} - ${check.detail}`)
}
process.exit(report.ok === true ? 0 : 1)
