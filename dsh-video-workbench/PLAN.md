# dsh-video-workbench · MVP 计划（v4）

> 状态：计划稿。本目录在 M0 开始前**不是**可安装插件，只有本文件。
> 平台范围：**Windows + DSH Desktop 优先**；Web 与 macOS 未验证，README 必须写明。
> 当前 DSH：`0.2.2-rc.5`；渲染器：HyperFrames `0.6.33`（固定，不跟随 DSH 升级）。
> M0 状态：**已完成**——渲染 10s@1080p = 15.2s、路由 206、`dsh-app://app` 下播放与拖动通过、取消无残留。结论见 [docs/M0-FINDINGS.md](docs/M0-FINDINGS.md)。
> M1 状态：**已完成**（v0.1.0：构建、适配层、项目模型/路由、`video_selfcheck`；`verify` 全绿 + 82 项测试；
> 2026-11-19 修复客户端 bundle 重复注册等数据完整性问题）；
> 桌面端完全重启后的实机验收**全部通过**（DSH `0.2.2-rc.5`：Host 自检 5/5 +
> 客户端 ▶/token/206/播放拖动/Esc/重试，单次模块注册生效），明细见
> [docs/M1-PLAN.md](docs/M1-PLAN.md) 第 10 节。
> M1 执行细节（目录、构建、schema、步骤、DoD）见 [docs/M1-PLAN.md](docs/M1-PLAN.md)。

## 0. 决策记录

| 项 | 结论 | 备注 |
| --- | --- | --- |
| 生图 | 火山方舟 Seedream，`/images/generations` | model ID 走配置不写死（`250828` 即将下线，新版为 `20260415`），约 0.2 元/张 |
| TTS | 火山引擎语音合成为主，本地 Kokoro `zf_xiaobei` 兜底 | 火山支持时间戳字幕；两套凭据体系需分别存 |
| 项目根目录 | `projectsRoot` **必填**，放专用 DSH 工作区子目录（D 盘） | 不提供 C 盘默认值；未配置时项目功能禁用；路径经白名单校验 |
| 导出目录 | `exportDir` 可选，渲染后另存一份成片 | 媒体路由不暴露；同名按版本递增，不覆盖已有导出 |
| 项目 ID | slug 用创建时间戳 `YYYYMMDD-HHmmss`，目录创建后不可变 | 标题存 `project.json`，UI 与导出文件名使用标题 |
| 构建 | TypeScript + esbuild，提交 `index.js` / `client.js` 产物 | `react` 外部化；`tsc --noEmit` 只做类型检查 |
| 平台 | Windows + Desktop only | 不写 desktop 专属分支，保持两端可移植 |

## 1. MVP 定义

在 Desktop 里，agent 用一句话产出 15–60 秒短视频：搜图/生图 → TTS 配音 → HyperFrames 合成 → 本地渲染 → 浮层预览 → 微调 → 重渲染 → 导出 mp4。

**不做**：生视频 API、Remotion、多轨时间线、模板市场、批量渲染、Web 验收、macOS 验收、字幕烧录。

### 1.1 可编辑字段白名单（M5 只做这 8 项）

`scene.text`、`scene.durationSec`、`scene.media.asset`、`scene.voice.speed`、`scene.captions.enabled`、`project.aspect`、`style.theme`、`style.captionStyle`。超出白名单的微调走「让 agent 改 composition」，不进 UI。

## 2. 架构

```text
<专用工作区>/video-projects/<slug>/
├── project.json           # 结构化数据（唯一可编辑真相，带 schemaVersion）
├── composition/index.html # HyperFrames 合成，agent 可整份重写
├── assets/                # 素材 + attribution.json
└── renders/v1.mp4 ...
$DSH_HOME/cache/dsh-video-workbench/
├── runtime/               # 懒装 hyperframes + ffmpeg-static（固定版本）
└── chrome/                # headless shell、TTS 模型
```

- `projectsRoot` 由 `Config` 提供，默认指向专用工作区下的 `video-projects/`；**不依赖会话 cwd**，工具描述里说明这一点。
- 数据目录沿用本机插件惯例 `$DSH_HOME/cache/<包名>/`（先例：`cache/dsh-opencode-go`）。属社区惯例而非文档契约，允许 `Config.dataDir` 覆盖。
- **Host**（`index.js` + `host/`）：`projects`、`runtime`（探测 + 供给）、`render`（子进程 + 进度 + 取消）、`media`（HTTP 路由，Range）、`providers`、`tools`、`adapters`（DSH 耦合层）。
- **Client**（`client.js`，esbuild 构建，`react` 外部化）：入口按钮 + `shell.overlay` 工作台 + 播放器 + 结果卡。
- **状态不进 session log**；**插件包零 `dependencies`**。

## 3. 里程碑（30 人日 + 20% 缓冲 ≈ 36 人日 ≈ 7 周）

| 里程碑 | 内容 | 人日 | 验收标准 |
| --- | --- | --- | --- |
| **M0 隔离与链路验证** | ① `api/...` 路由 + `<video>` 拖拽（206）；② 托管 Node 探测链 + 本地 hyperframes 安装/运行 + 缓存目录 + **子进程 env 清理**；③ 取消/退出无 Chrome 残留；④ overlay 窗口区域声明（读 `v0.2.2-rc.1/window-drag-regions`）；⑤ `docs/UPGRADE-PLAYBOOK.md` | 2 | 四条链路全绿；安装耗时可接受（≤15 分钟）；playbook 有可执行步骤 |
| **M1 骨架与播放** | TS/esbuild 脚手架、包结构、`adapters/` 层、`projectsRoot` + `project.json`、媒体路由（Range + 路径校验）、overlay + 播放器、composer 入口、`video_selfcheck` 骨架、构建可复现校验——**执行细节见 [docs/M1-PLAN.md](docs/M1-PLAN.md)** | 3 | 手工 mp4 能播能拖、亮暗正常、Esc 焦点归位；`build` 后产物与提交一致 |
| **M2 渲染管线** | 运行时供给与**首次下载 UX**、渲染任务/进度/取消/超时、进程树清理、原子写入、保留策略（最近 5 个 render） | 5 | UI 内跑完 10s 片；取消无残留进程与半成品；磁盘不无限增长 |
| **M3 素材与配音** | Pixabay、Seedream 生图、火山 TTS（含 word timings）+ Kokoro 兜底、失败降级（无声也可出片）、素材缓存与署名、scenes → composition 脚手架 | 5 | 3 图 + 1 配音进片并渲染成功；无 key 时 Kokoro 出片；TTS 全失败时出无声片 |
| **M4 Agent 主路径** | 9 个工具、结果卡、合成模板、`hyperframes lint` 门禁与失败修复回路、错误分类回传 | 6 | 固定 prompt 回归集 ≥2/3 出片；lint 不过不进入渲染 |
| **M5 微调工作台** | 白名单 8 字段、分镜列表、属性面板、素材替换、预览 seek、重渲染、键盘与焦点 | 6 | 改文案后重渲染成功且 project.json 不被破坏；Tab/Esc 完整 |
| **M6 交付打磨** | 隔离审计、`node --test`、截图、README/INSTALL、卸载脚本、`COMPAT.md` | 3 | 通过隔离验收与兼容矩阵；卸载后 DSH 正常启动、项目文件保留 |

**最小可用切点**：M4 完成（21 人日 ≈ 4 周）。

## 4. 跨里程碑工程约束

### 4.1 版本护栏

- `engines.dsh` 首发用精确版本 `0.2.2-rc.3`：升级后插件拒绝激活，逼一次自检。
- 实测通过后再放宽（如 `>=0.2.2-rc.3 <0.3.0`），并写入 `docs/COMPAT.md`。
- 升级流程：读 `$DSH_INSTALL_DIR/docs/upgrade-guide/README.md` 对应版本段 → 跑 selfcheck → 必要时只改 `adapters/`。

### 4.2 结构隔离

- DSH 相关代码只出现在 `host/adapters/` 与 `client/adapters/`（slot 注册、`host.call`、媒体 URL、主题 token）。
- 目标：DSH 耦合代码 < 15% LOC；不 `require` 任何 `@deepseek-ai/*` 客户端包，不读其它插件 DOM，不改全局。

### 4.3 资产隔离

- 项目是明文 `project.json` + `index.html` + `assets/`：插件报废也能手动 `hyperframes render` 出片。
- `schemaVersion` + `host/projects/migrate.js` 负责迁移。

### 4.4 不干扰 DSH

| 维度 | 机制 |
| --- | --- |
| 主进程 | 渲染只走子进程；并发 1；单次超时 10 分钟；进度流式 |
| 子进程环境 | 显式构造最小 env，剔除 `ELECTRON_*`、`NODE_OPTIONS` 等继承变量 |
| 进程残留 | 取消/退出进程树 kill；启动扫孤儿；Windows 用 `taskkill /T /F` |
| 全局 UI | 浮层仅点击打开；Esc 关闭并归还焦点；不自动弹、不抢焦点 |
| 样式 | 统一 `dshvw-` 前缀；只用 `--dsw-alias-*`；无全局选择器 |
| 路由 | 只读项目目录白名单；`../` 被拒；不校验 `Origin`（Desktop 转发会剥离） |
| 网络 | 仅用户显式触发；请求前显示目标与预估 |
| 存储 | 只写 `projectsRoot` 与插件数据目录；不碰 profile 与包目录 |
| 安装 | 零依赖；patch id 唯一；`--check/--dry-run/--uninstall` |
| 降级 | 可选服务走 `inject`；缺服务降级而非抛错；`apply()` 防御式 |

### 4.5 安全

- 素材下载 URL 仅允许 `https:`，拒绝回环/内网/`file:`/重定向到私网。
- 文件名与路径不进 ffmpeg 命令行拼接；用 argv 数组 + 固定参数模板。
- provider key 只经 `ctx.credentials`：`volc.ark.apiKey`（Seedream）、`volc.tts.appId` / `volc.tts.token`（或统一用 `ark-` 套餐域 key）；日志与错误信息脱敏。

### 4.6 自检（smoke）

`video_selfcheck`：运行时探测 → 路由 206 → 3 秒样例渲染 → 产物校验 → 清理。`node --test` 覆盖纯函数：路径校验、Range 解析、`project.json` 迁移、provider 适配器（fixture）、时长计算。

### 4.7 构建

- `src/host/index.ts` → `index.js`（ESM，platform node，外部化内置模块）；`src/client/index.tsx` → `client.js`（CJS bundle，`react` 外部化，再包一层 `window.__ModuleLoader__.load({ id, factory })`）。
- JSX 必须用 **classic transform**（`React.createElement`）：模块表只提供 `react`，没有 `react/jsx-runtime`。
- `pnpm verify` = `tsc --noEmit` + build + `git diff --exit-code` + `node --check` + `node --test`。

## 5. 停止条件（kill criteria）

- M0：10s@1080p 渲染在目标机 > 3 分钟，或失败率 > 20% → 暂停，评估替代渲染方案。
- M0：首次安装（含 Chrome）> 15 分钟且无可用加速 → 重新评估供给策略。
- M1：`<video>` 在 `dsh-app:` 下拿不到 206 → 退回 blob 方案，预览降级为帧序列。
- M4：固定 prompt 回归 < 2/3 → 收缩为「模板填空」模式。
- M5：白名单外需求超过 3 个 → 不扩 UI，改为 agent 编辑 composition。

## 6. 交付物

`package.json` / `cordis.patch.yml` / `index.js` / `client.js`（构建产物）/ `locale/{zh,en}.json` / `icon.svg` / `README.md` / `INSTALL.md` / `docs/{COMPAT.md,UPGRADE-PLAYBOOK.md}` / `scripts/{install.mjs,smoke.mjs,build.mjs}` / `test/`。

## 7. 节奏

v0.1（M6 完成）后**冻结 4 周**：只修 bug，不加功能。用满 4 周再决定是否进 v0.2（Remotion / 生视频 / 模板）。
