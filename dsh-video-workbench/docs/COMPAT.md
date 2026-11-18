# 兼容性矩阵

每次确认可用后更新本文件；升级复测流程见 [UPGRADE-PLAYBOOK.md](UPGRADE-PLAYBOOK.md)。

## 实测组合

| 插件版本 | DSH | 平台 | Node | hyperframes | 结果 |
| --- | --- | --- | --- | --- | --- |
| 0.0.1 | 0.2.2-rc.3 | Windows 11 x64 Desktop | 24.21.0（托管） | 0.6.33 | M0 链路通过（无鉴权） |
| 0.0.2 | 0.2.2-rc.3 | Windows 11 x64 Desktop | 24.21.0（托管） | 0.6.33 | token 注入、206、播放、Esc/焦点通过 |
| 0.0.3 | 0.2.2-rc.3 | Windows 11 x64 Desktop | 24.21.0（托管） | 0.6.33 | 重启后复测：token、206、播放、`ping` 字段精简均通过 |
| 0.0.4 | 0.2.2-rc.3 | Windows 11 x64 Desktop | 24.21.0（托管） | 0.6.33 | 重启后完整复测：token、播放、seek、错误态重试、Esc（视频聚焦）均通过 |

## 未验证

| 组合 | 原因 |
| --- | --- |
| DSH Web（`dsh web`） | 未在本轮验证；代码保持两端可移植，但未做浏览器端回归 |
| macOS Desktop | 未验证；窗口拖拽区域规则未适配 |
| DSH > 0.2.2-rc.3 | `engines.dsh` 精确匹配，升级后插件会停用，需按手册复测 |

## 环境依赖

| 依赖 | 版本/来源 | 备注 |
| --- | --- | --- |
| Chrome | 系统安装（`C:\Program Files\Google\Chrome\Application\chrome.exe`） | 自动下载在本机网络不可用 |
| FFmpeg / FFprobe | `ffmpeg-static` 5.2.0 / `ffprobe-static` 3.1.0 | 通过 PATH 注入给 hyperframes |
| 运行时目录 | `$DSH_HOME/cache/dsh-video-workbench/runtime` | 约 762 MB（含原生模块） |
| 浏览器/TTS 缓存 | `~/.cache/hyperframes` | hyperframes 自身约定，暂不可整体迁移 |
