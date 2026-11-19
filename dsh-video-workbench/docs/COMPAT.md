# 兼容性矩阵

每次确认可用后更新本文件；升级复测流程见 [UPGRADE-PLAYBOOK.md](UPGRADE-PLAYBOOK.md)。

## 实测组合

| 插件版本 | DSH | 平台 | Node | hyperframes | 结果 |
| --- | --- | --- | --- | --- | --- |
| 0.0.1 | 0.2.2-rc.3 | Windows 11 x64 Desktop | 24.21.0（托管） | 0.6.33 | M0 链路通过（无鉴权） |
| 0.0.2 | 0.2.2-rc.3 | Windows 11 x64 Desktop | 24.21.0（托管） | 0.6.33 | token 注入、206、播放、Esc/焦点通过 |
| 0.0.3 | 0.2.2-rc.3 | Windows 11 x64 Desktop | 24.21.0（托管） | 0.6.33 | 重启后复测：token、206、播放、`ping` 字段精简均通过 |
| 0.0.4 | 0.2.2-rc.3 | Windows 11 x64 Desktop | 24.21.0（托管） | 0.6.33 | 重启后完整复测：token、播放、seek、错误态重试、Esc（视频聚焦）均通过 |
| 0.1.0（M1） | 0.2.2-rc.3 | Windows 11 x64 Desktop | 24.19.0（本机）/ 24.21.0（托管） | 0.6.33 | 构建/类型/DSH 边界/产物一致/65 项测试全绿；运行中的 Desktop 热重载 Host 后启动自检 5/5（含项目路由 200）；**客户端 bundle 重启验收待执行** |
| 0.1.0 + 2026-11-19 修复 | 0.2.2-rc.5 | Windows 11 x64 Desktop | 24.19.0（本机）/ 24.21.0（托管） | 0.6.33 | DSH 升级到 rc.5 后重新安装；升级指引核对无影响条目；**完全重启后** Host 自检 5/5（路由挂载、token、media 206、`projectsRoot` 可写、项目路由 200）且**客户端半区全部通过**（单个 ▶、token、206、播放/拖动、Esc、错误态重试、亮暗/侧栏/窄窗口、无重复浮层） |
| 0.1.1 | 0.2.2-rc.5 | Windows 11 x64 Desktop | 24.19.0（本机）/ 24.21.0（托管） | 0.6.33 | 仅元数据变更：`engines.dsh` 改为 `>=0.2.2-rc.5`（本插件自用，不对外分发）+ 新增 manifest 契约测试。`index.js` / `client.js` 与 0.1.0 逐字节相同，实机验收沿用上一行（rc.5 上插件保持激活，自检仍 5/5）；本地 86 项测试全绿 |
| 0.1.2 | 0.2.2-rc.5 | Windows 11 x64 Desktop | 24.19.0（本机）/ 24.21.0（托管） | 0.6.33 | 回归审查后的修复批次：Range 语义（多段/未知单位改为忽略并回 200）、`createProject` 错误契约、场景 id 唯一性、`dataDir` 盘符根守卫、原子写残留、自检可取消与 `skipped` 语义、`nosniff`、客户端改用共享路由常量、日志脱敏。本地 100 项测试全绿；**实机只验证到 Host 半区（自检 5/5 属 0.1.1 那轮），客户端需重启后复测** |

### `engines.dsh` 判定规则（实测）

DSH 用 `semver.satisfies(runtime, range, { includePrerelease: true })` 判定
（`@deepseek-ai/dsh-app-boot`），**预发布版本参与范围匹配**。本地用 DSH 自带的
`evaluatePluginCompatibility` 跑出的矩阵（当前范围 `>=0.2.2-rc.5`）：

| runtime | 0.2.2-rc.4 | 0.2.2-rc.5 | 0.2.2 | 0.2.3-rc.1 | 0.2.3 | 0.3.0 | 1.0.0 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 结果 | 拒 | 放行 | 放行 | 放行 | 放行 | 放行 | 放行 |

**这是一个刻意的取舍**：范围无上限，所以 DSH 的破坏性升级**不会再自动停用插件**。
代价是"半坏着跑"的风险由人工承担，检测手段是每次启动的自检报告
（`$DSH_HOME/cache/dsh-video-workbench/selfcheck.json`）：升级后先跑
`node scripts/check-selfcheck.mjs`，不过就手动停用插件并按
[UPGRADE-PLAYBOOK](UPGRADE-PLAYBOOK.md) 复测。

## 未验证

| 组合 | 原因 |
| --- | --- |
| DSH Web（`dsh web`） | 未在本轮验证；代码保持两端可移植，但未做浏览器端回归 |
| macOS Desktop | 未验证；窗口拖拽区域规则未适配 |
| DSH `> 0.2.2-rc.5` 的任意版本（含 `0.2.3`、`0.3.x`、`1.x`） | 范围放行但**逐个版本都未实测**；靠启动自检兜底，出现破坏性变更时按 UPGRADE-PLAYBOOK 处理 |
| DSH `<= 0.2.2-rc.4` | 低于下限，插件会拒绝激活（`0.2.2-rc.3` 曾实测通过但不再放行） |

## 环境依赖

| 依赖 | 版本/来源 | 备注 |
| --- | --- | --- |
| Chrome | 系统安装（`C:\Program Files\Google\Chrome\Application\chrome.exe`） | 自动下载在本机网络不可用 |
| FFmpeg / FFprobe | `ffmpeg-static` 5.2.0 / `ffprobe-static` 3.1.0 | 通过 PATH 注入给 hyperframes |
| 运行时目录 | `$DSH_HOME/cache/dsh-video-workbench/runtime` | 约 762 MB（含原生模块） |
| 浏览器/TTS 缓存 | `~/.cache/hyperframes` | hyperframes 自身约定，暂不可整体迁移 |
