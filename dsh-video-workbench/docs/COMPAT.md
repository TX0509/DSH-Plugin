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

### `engines.dsh` 判定规则（实测）

DSH 用 `semver.satisfies(runtime, range, { includePrerelease: true })` 判定
（`@deepseek-ai/dsh-app-boot`），**预发布版本参与范围匹配**。本地用 DSH 自带的
`evaluatePluginCompatibility` 跑出的矩阵（当前范围 `>=0.2.2-rc.3 <0.2.3`）：

| runtime | 0.2.2-rc.2 | 0.2.2-rc.3 | 0.2.2-rc.4 | 0.2.2-rc.5 | 0.2.2 | 0.2.3-rc.1 | 0.2.3 | 0.3.0 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 结果 | 拒 | 放行 | 放行 | 放行 | 放行 | 放行 | 拒 | 拒 |

## 未验证

| 组合 | 原因 |
| --- | --- |
| DSH Web（`dsh web`） | 未在本轮验证；代码保持两端可移植，但未做浏览器端回归 |
| macOS Desktop | 未验证；窗口拖拽区域规则未适配 |
| DSH `0.2.2-rc.4` | 范围放行但未单独实测；升级指引 `v0.2.2-rc.3` 一节只有 DeepSeek 拒答错误码变更，与本插件无关 |
| DSH `>=0.2.3`（含 `0.2.3-rc.*`） | 当前范围挡在 `0.2.3` 正式版；越过该版本需按 [UPGRADE-PLAYBOOK](UPGRADE-PLAYBOOK.md) 复测后放宽 |

## 环境依赖

| 依赖 | 版本/来源 | 备注 |
| --- | --- | --- |
| Chrome | 系统安装（`C:\Program Files\Google\Chrome\Application\chrome.exe`） | 自动下载在本机网络不可用 |
| FFmpeg / FFprobe | `ffmpeg-static` 5.2.0 / `ffprobe-static` 3.1.0 | 通过 PATH 注入给 hyperframes |
| 运行时目录 | `$DSH_HOME/cache/dsh-video-workbench/runtime` | 约 762 MB（含原生模块） |
| 浏览器/TTS 缓存 | `~/.cache/hyperframes` | hyperframes 自身约定，暂不可整体迁移 |
