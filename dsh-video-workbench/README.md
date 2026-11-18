# dsh-video-workbench

DSH Desktop 的短视频制作工作台插件。当前处于 **M0（链路验证）完成** 阶段，只包含链路验证所需的最小实现。

![视频工作台浮层](docs/m0-overlay.png)

## 已验证

| 阶段 | 项 | 结果 |
| --- | --- | --- |
| v0.0.1（M0，无 token） | 10s@1080p 渲染（hyperframes 0.6.33） | ✅ 15.2 秒，3.12 MB |
| v0.0.1 | 取消渲染 | ✅ 进程树清理干净，无半成品 |
| v0.0.1 | `dsh-app://app` 下播放与拖动 | ✅ 播放至 1.24s；拖动到 8.00s 渲染末帧 |
| v0.0.2 | token 注入 | ✅ 完全重启后 `tokenPresent: true` |
| v0.0.2 | 带 token 的 `ping` / `media` | ✅ `ping` 200；media 206 + `Content-Range: bytes 0-99/1548444` |
| v0.0.2 | 带 token 的播放 | ✅ 播放至 2.09s，画面推进（见截图） |
| v0.0.2 | Esc 关闭 / 焦点归还 | ✅ 关闭后焦点回到 ▶ 按钮 |
| v0.0.3 | 重启后复测 | ✅ `ping` 不再返回 `node`；token、206、播放至 1.56s 均通过 |
| v0.0.4 | 重启后全链路复测 | ✅ token、206、播放、拖动 seek、错误态与"重试"、视频聚焦时 Esc 关闭 全部通过 |

> 拖动进度条在 v0.0.1 验证；v0.0.2 / v0.0.3 只复测了同一路径的 206 分段读取与播放。
> 详细数据与发现见 [docs/M0-FINDINGS.md](docs/M0-FINDINGS.md)。

## 当前能力

- `GET /api/video-workbench/ping?t=<token>`：健康检查，返回媒体目录存在性与是否要求 token。
- `GET /api/video-workbench/media?path=<name>&t=<token>`：带 Range 的媒体读取。
  - 路径白名单：最多 5 段，拒绝 `..`、绝对路径、隐藏文件、Windows 保留字符；支持中文名。
  - 符号链接逃逸会被拒绝（按 `realpath` 校验真实路径仍在 `mediaRoot` 内）。
  - 支持 `206` / `416` / `304`（`If-None-Match`、`If-Range`）、`HEAD`，其余方法 `405`。
- 客户端：composer 左侧 ▶ 按钮 → `shell.overlay` 浮层 → 播放测试视频 + 诊断信息。

## 鉴权

媒体与健康检查路由都要求 `t` 查询参数（或 `x-dsh-video-workbench-token` 头）。
token 在 Host 启动时随机生成，通过 `webserver/index-inject` 的 `global` 行注入页面
（`window.__DSH_VIDEO_WORKBENCH__.token`）；注入只面向 owner 页面，非 owner 的读者页拿不到。
页面本身需要 Host 鉴权，因此本机其它进程拿不到 token。

两点限制：

- token 放在查询串里（`<video>` 无法设置请求头），因此可能出现在浏览器历史或访问日志中；
- token 每个 Host 进程重新生成，插件热重载后旧页面会失效，需要刷新。

如需临时关闭（不推荐）：在 patch 行配置 `requireToken: false`。

## 安装

见 [INSTALL.md](INSTALL.md)。Desktop 的 profile 由应用独占管理，安装或更新前需要**完全退出 DSH**。

## 数据位置

媒体根目录默认 `$DSH_HOME/cache/dsh-video-workbench/media`，可用配置项 `mediaRoot` 覆盖。

响应带 `Cache-Control: private, max-age=3600` 与 `ETag`。覆盖同名文件后，浏览器可能沿用旧片段，
因此渲染产物建议按版本命名（`v1.mp4`、`v2.mp4`），而不是反复覆盖同一个文件名。

## 兼容性

- DSH：`0.2.2-rc.3`（精确匹配，升级后插件会停用等待复测，见 [docs/UPGRADE-PLAYBOOK.md](docs/UPGRADE-PLAYBOOK.md)）
- 平台：Windows Desktop 实测；Web 与 macOS 未验证
- 运行时（M2 起）：需要可用的 Chrome；本机实测**优先复用系统 Chrome**，自动下载不可用
- Node：`>=20`；实测使用 DSH 托管运行时 `v24.21.0`
- 实测矩阵见 [docs/COMPAT.md](docs/COMPAT.md)

## 已知限制

- 界面文案暂为中文硬编码，未接入 Client locale 服务（仅插件管理器的标题/描述做了中英双语）。
- 浮层是全屏模态；macOS 的窗口拖拽区域尚未适配（`data-window-drag-exclude`）。
- 还没有 `host/adapters`、`client/adapters` 隔离层（M1 建立）。

## 开发

```sh
node --check index.js
node --check client.js
node --test
```

## 未完成

M1–M6 见 [PLAN.md](PLAN.md)。
