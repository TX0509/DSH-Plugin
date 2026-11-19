# M2 执行计划：渲染管线

> 状态：**全部步骤已完成**（2026-11-19，v0.2.0）。步骤 7 的实机验收：`render-smoke.mjs` 通过，
> 渲染 UI 需完全重启 DSH 后确认；执行中被推翻的假设见 §14。v0.2.1 起入口从 composer 移到左侧栏面板。）
> 基线 v0.1.2（M1 完成并通过实机验收，`verify` 全绿、127 项测试）。
> 本文对应 [PLAN.md](../PLAN.md) 里程碑表里「M2 渲染管线」那一行，把它拆成可以照着执行的步骤、
> 接口、命令与验收标准；结构对齐 [M1-PLAN.md](M1-PLAN.md)。
> 范围：Windows + DSH Desktop；Web / macOS 不在 M2 验收范围。
> 开工前先读 [M0-FINDINGS.md](M0-FINDINGS.md)（Chrome / ffmpeg / pnpm `--allow-build` 的坑）
> 与本文第 14 节的三个待确认决定。

## 0. 目标与不做的事

M2 结束时应当：

- 插件能**自己供给渲染运行时**：安装 `hyperframes@0.6.33` 与 ffmpeg/ffprobe，校验二进制真实存在，
  幂等（已装跳过）、失败可读、**不依赖 npx 联网**；
- 能在 **Host 里发起一次渲染**：`composition/` → `renders/vN.mp4`，带进度、可取消、有超时；
- 渲染只走子进程，**并发 1**；取消/超时/进程退出后**无 Chrome 与 node 残留**、无半成品文件；
- 产物原子落地，**保留最近 N 个**（默认 5），`exportDir` 复制一份（失败只记日志）；
- 客户端工作台面板里能点「渲染」看到进度与结果，并能取消；
- `video_selfcheck` 增加运行时/浏览器/ffmpeg 的真实性检查（不信 `hyperframes doctor`）。

**不做**：素材抓取/生图/TTS（M3）、agent 工具与结果卡（M4）、lint 门禁（M4）、
微调工作台（M5）、多轨/转场编辑、Web 验收。

## 1. 起点（M1 现状，可直接复用）

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| Host 组装 + 路由注册 | `apply(ctx, config)`，4 条路由，token 鉴权先于方法检查 | `src/host/index.ts` |
| 文件路由 | `/media`、`/projects` 只读、Range/ETag/`nosniff`；路径白名单最多 5 段 | `src/host/paths.ts` |
| 项目模型 | `project.json` v1 + 校验/迁移/原子写 + `create/read/write/list` | `src/host/projects/*` |
| 自检 | 5 项检查，真实 HTTP 探测，支持 `skipped` 与取消 | `src/host/selfcheck.ts` |
| 生命周期 | `defer`（定时器 + 卸载回调）、`ctx.effect` 清理 | `src/host/adapters/lifecycle.ts` |
| 原子写 | `writeFileAtomic(target, text)` | `src/host/atomic.ts` |
| 日志 | `hostLogger` + `redactPath`（home→`~`） | `src/host/adapters/logger.ts` |
| 构建/校验 | `node scripts/verify.mjs`：类型→边界→构建→产物形态→产物一致→语法→测试 | `scripts/verify.mjs` |
| 客户端 | 左侧栏面板图标（`sidebar.panellist`）+ 主面板页面（`main` key），单次模块注册 | `src/client/index.tsx` |

**可直接落地的目录约定**（M1 已建）：`<projectsRoot>/<slug>/{project.json,composition,assets,renders}`。

## 2. 目标目录结构（M2 新增）

```text
dsh-video-workbench/
├── src/host/
│   ├── runtime/
│   │   ├── supply.ts        # 安装/校验/幂等（pnpm add + 二进制检查）
│   │   ├── locate.ts        # node / pnpm / chrome / ffmpeg 探测链
│   │   └── env.ts           # 子进程最小 env 构造（白名单 + 黑名单）
│   ├── render/
│   │   ├── args.ts          # hyperframes render argv 构造（纯函数）
│   │   ├── progress.ts      # stdout 进度解析（纯函数，ANSI 清洗）
│   │   ├── jobs.ts          # 任务状态机 + 队列（并发 1）+ 超时 + 取消
│   │   ├── process.ts       # 子进程启动/进程树 kill/孤儿扫描
│   │   ├── outputs.ts       # renders 版本递增、原子落地、保留策略、exportDir
│   │   └── routes.ts        # POST /render、GET /render/:id、DELETE /render/:id
│   └── (index.ts 只做组装)
├── test/{runtime,render,progress,retention,env}.test.mjs
└── docs/M2-PLAN.md
```

约束不变：DSH 调用只出现在 `host/adapters/`；`verify` 的 `dsh boundary` 会拦住漏出去的直连。

## 3. 接口与协议

### 3.1 任务状态机

```text
queued ──start──▶ running ──ok────▶ succeeded
                    │  ├─cancel─▶ cancelled
                    │  ├─timeout▶ timedOut
                    │  └─error──▶ failed
```

- 任务 id：`r-<YYYYMMDD-HHmmss>-<4 位随机>`；只存在内存（进程重启即失效，孤儿由启动扫描清理）。
- **并发 1**：全局只跑一个渲染；`running` 时新请求进队列（最多 1 个，再多的返回 409）。
- 终态任务保留 10 分钟供轮询，之后从内存移除。
- 任务对象（对外 JSON）：`{ id, projectId, status, phase, percent, frames, totalFrames, startedAt, finishedAt?, output?, error? }`。

### 3.2 Host 内部服务（单一实现，UI 与 M4 工具共用）

```ts
// src/host/render/jobs.ts
startRender(input: { projectId: string }, options?): RenderJob
getRenderJob(id: string): RenderJob | undefined
cancelRender(id: string): boolean
listRenderJobs(): RenderJob[]
```

M4 的 agent 工具只包这层，不再写第二套逻辑（AGENTS.md §5 要求）。

### 3.3 HTTP 路由（客户端 UI 用，沿用同一 token）

| 方法 + 路径 | 作用 | 响应 |
| --- | --- | --- |
| `POST /api/video-workbench/render` | 发起渲染 | `202 { job }` / `409 { error: 'busy' }` / `400 { error }` |
| `GET /api/video-workbench/render/<id>` | 轮询进度 | `200 { job }` / `404` |
| `DELETE /api/video-workbench/render/<id>` | 取消 | `202 { job }` / `404` / `409 { error: 'finished' }` |

- **进度通道 = 轮询**（已确认，§14-A）：1000 ms 间隔，UI 侧 `GET`；不做 SSE/WS。
- 写操作只接受 `POST/DELETE + token`；仍不校验 Origin（Desktop 转发会剥掉），但**只允许本插件路由做这几件事**，
  不开放任意路径/命令。token 只注入 owner 页面（M1 已实现）。
- 请求体限制 16 KB，只接受 `{ projectId }`；`projectId` 必须过 `isProjectId` 且项目存在。

### 3.4 错误分类（回传可展示文案，细节只进日志）

| code | 场景 | 用户可见文案 |
| --- | --- | --- |
| `runtime-missing` | 运行时未安装/不完整 | 首次使用需要安装渲染运行时（可提供一键入口或命令） |
| `browser-missing` | 找不到 Chrome | 未找到 Chrome，请在配置里指定 `chromePath` |
| `project-invalid` | 项目不存在/校验失败 | 项目不可用：<第一条错误> |
| `composition-missing` | `index.html` 不存在 | 项目缺少 index.html |
| `render-failed` | CLI 退出码非 0 | 渲染失败（code），日志见 <相对路径> |
| `timeout` / `cancelled` | 超时 / 主动取消 | 渲染超时/已取消 |

## 4. 运行时供给（runtime）

### 4.1 目录与版本锁

```text
$DSH_HOME/cache/dsh-video-workbench/runtime/     # 可用 Config.runtimeDir 覆盖
├── package.json          # 固定版本清单（下文）
├── node_modules/         # hyperframes + ffmpeg-static + ffprobe-static
└── supplied.json         # 供给结果：版本、二进制绝对路径、完成时间、校验结果
```

`package.json` 固定版本（不跟随 DSH 升级）：

```json
{ "dependencies": { "hyperframes": "0.6.33", "ffmpeg-static": "5.2.0", "ffprobe-static": "3.1.0" } }
```

### 4.2 安装命令（M0 实测结论）

- 用**托管 node + 托管 pnpm**（`<runtime>/dependencies/node/bin/node.exe` + `.../pnpm/bin/pnpm.mjs`）。
- 必须逐包放行构建脚本，M0 证明 `onlyBuiltDependencies` 在 pnpm 11.28 不生效：

  ```text
  pnpm add hyperframes@0.6.33 ffmpeg-static@5.2.0 ffprobe-static@3.1.0 \
    --allow-build=hyperframes --allow-build=esbuild --allow-build=ffmpeg-static \
    --allow-build=ffprobe-static --allow-build=onnxruntime-node --allow-build=sharp
  ```

- **装完再跑一次同一条命令**（M0 结论：第一次可能跳过 postinstall），然后校验二进制。
- 二进制路径用包 API 解析，不硬编码目录：
  `require('ffmpeg-static')` → 路径字符串；`require('ffprobe-static').path` → 路径。
- 校验标准：`fs.existsSync` + 真实执行 `-version`（超时 10 s）+ 解析出版本号；写进 `supplied.json`。

### 4.3 幂等与互斥

- `supplied.json` 的版本与 `package.json` 一致、且所有二进制校验通过 → 直接复用（启动时 0 网络）。
- 安装过程写 `runtime/.install.lock`（含 pid/时间）；启动发现锁且 pid 不存活 → 清掉重来。
- 安装失败保留 `install.log`（在 `runtime/`），自检报 `runtime-missing` 并附最后 20 行。

### 4.4 首次安装 UX（M2 形态，已确认 §14-C）

M2 先做**最小可用**：

1. 自检/`GET /runtime` 返回 `{ state: 'ready' | 'missing' | 'installing' | 'failed', ... }`；
2. UI 在状态非 ready 时把「渲染」按钮改为「安装运行时」，点击触发 `POST /runtime/install`（同一 token）；
3. 安装期间按钮禁用 + 文案显示"正在安装（首次约 2–10 分钟）"，每 2 s 轮询状态；
4. 失败显示错误码 + "查看日志"（只显示相对路径与最后几行）。

不做：下载进度百分比（pnpm 不提供可靠进度）、断点续传、离线包。

## 5. 环境探测（node / pnpm / Chrome / ffmpeg）

探测顺序写死并在自检里回报**实际选中的路径**（日志脱敏，接口只回 `source` 名称）：

| 项 | 顺序 | 校验 |
| --- | --- | --- |
| node | ① `$DSH_HOME/dsh-runtimes/*/dependencies/node/bin/node.exe` ② `ELECTRON_RUN_AS_NODE=1 DSH_NODE_EXECUTABLE` ③ `PATH` 里的 node | `node --version` 且 **major ≥ 22**（hyperframes 要求 `engines.node >= 22`）。②是 Electron 二进制，**探测与启动都必须带 `ELECTRON_RUN_AS_NODE=1`**，否则会拉起 GUI |
| pnpm | 托管运行时 `dependencies/pnpm/bin/pnpm.mjs`（用上面的 node 执行） | 文件存在 |
| Chrome | ① `Config.chromePath` ② `%ProgramFiles%\Google\Chrome\Application\chrome.exe` ③ `%ProgramFiles(x86)%\…` ④ `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe` | `existsSync` + `isFile`；命中后设 `HYPERFRAMES_BROWSER_PATH` |
| ffmpeg/ffprobe | 运行时里的 `ffmpeg-static` / `ffprobe-static` | 执行 `-version` |

- 选择结果缓存到进程内（启动时算一次，`installing` 后重算）。
- 绝不使用 `hyperframes doctor` / `browser path` 的"看起来正常"输出（M0 已证明会假成功）。

## 6. 渲染调用

### 6.1 命令与参数（`hyperframes render --help`，v0.6.33 实测）

```text
<node> <runtime>/node_modules/hyperframes/dist/cli.js render <projectDir> \
  -o <projectDir>/renders/.v<N>.mp4.tmp-<rand> \
  -f <fps> -q <quality> -w <workers> --format mp4 \
  --resolution <portrait|landscape>            # 9:16→portrait，16:9→landscape
```

- `quality`: `draft | standard | high`（默认 `standard`，M2 用 `standard`；M4 可让 agent 选 `draft`）。
- `workers`: 默认 `2`（每个 worker 一个 Chrome，约 256 MB）；`Config.renderWorkers` 可覆盖。
- 不加 `--quiet`（需要进度行）；不加 `--strict`（lint 门禁留给 M4）。
- `-c` 只在项目没有 `index.html` 但指定了别的合成时使用；M2 约定入口固定为 `index.html`，
  通过 `-c` 指向它（`index.html` 由 M2 的脚手架写入，见步骤 2）。
- 工作目录 = 项目目录；argv 数组传参，**不拼命令行字符串**（PLAN §4.5）。

### 6.2 进度解析（纯函数，`render/progress.ts`）

M0 日志实测形态（含 ANSI 转义与 `\r`）：

```text
[2K  ████████░░░░  43%  Capturing frame 120/300 (2 workers)
[2K  ██████████████████░░░░░  75%  Encoding video
[2K  ██████████████████████░░░  90%  Assembling final video
[2K  █████████████████████████  100%  Render complete
```

规则：先剥 ANSI（`\x1b\[[0-9;?]*[A-Za-z]`）、按 `\r`/`\n` 切行，再匹配：

| 模式 | phase | percent |
| --- | --- | --- |
| `Capturing frame (\d+)/(\d+)` | `capturing` | `frames/total` |
| `Encoding video` | `encoding` | 75 |
| `Assembling final video` | `assembling` | 90 |
| `Render complete` | `done` | 100 |
| `Rendering <name> → <path>` | `preparing` | 5 |

- 只单调递增（回退忽略）；最多 4 行/秒写状态（避免高频刷新）。
- 行 `⚠ [compositions/…] …` 视为 **warning**：计入 `warnings[]`，不影响成功（M4 才做门禁）。
- 进程退出后以 `◇ <path>` + `… completed` 作为产物就绪的辅助证据，但**以文件校验为准**。

### 6.3 超时 / 取消 / 进程树 / 孤儿

- 超时：`Config.renderTimeoutMs`（默认 `600000` = 10 分钟，PLAN §4.4）。到时先 `SIGTERM`，5 s 后强杀。
- 取消：`cancelRender(id)` → 标记 `cancelling` → 杀进程树 → 任务转 `cancelled`，清理 `.tmp` 产物。
- Windows 用 `taskkill /T /F /PID <pid>`（`/T` 连子进程，杀掉 Chrome）；POSIX 用 `process.kill(-pid)`（detached + 进程组）。
- 启动时**孤儿扫描**：任务登记文件 `dataDir/render-jobs/<id>.json`（pid、startedAt、projectId）；
  发现 pid 存活且命令行含 `hyperframes`/`chrome-headless-shell` → `taskkill` 并删除登记；否则直接删登记。
- 插件卸载（`ctx.effect` disposer）时：杀当前进程树、清 `.tmp`、删登记文件。

## 7. 产物、保留与导出

- **版本递增**：扫描 `renders/v*.mp4` 取最大 N → 新文件 `v(N+1).mp4`；`v1` 起步。并发 1 下无竞争。
- **原子落地**：渲染直接输出到 `renders/.vN.mp4.tmp-<rand>`；校验通过后 `rename` 为 `vN.mp4`。
  校验：文件存在、大小 > 0、`ffprobe` 读出 `duration > 0` 且宽高匹配 aspect（失败 → `render-failed`）。
- **保留策略**：`Config.keepRenders`（默认 5）——按版本号 **从新到旧** 保留 5 个，删除更旧的 `vN.mp4`；
  不删非 `v<数字>` 命名文件，不删 `.tmp`（由失败清理负责）。删除失败只记日志。
- **exportDir**（`Config.exportDir`，可选，M1 已解析、M2 生效）：
  - 渲染成功后复制：`${exportDir}\${slug}-${safeTitle}-v<N>.mp4`；
  - `safeTitle`：去 Windows 保留字符（`<>:"/\|?*`）、空白折叠为 `-`、截断 40 字符、空则退回 slug；
  - 同名已存在 → 追加 `-2`、`-3`…，**绝不覆盖**；
  - 失败只记日志，不改变渲染结果；媒体/项目路由**不暴露** `exportDir`。
- **渲染结果存哪**（已确认，§14-B）：新增 `renders/index.json`（`{ version, file, bytes, durationSec, width, height, fps, createdAt }`，
  按版本倒序），**不改 `project.json` schema**。写入用 `writeFileAtomic`。

## 8. 配置项（M2 新增，写进 INSTALL 配置表）

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `runtimeDir` | `$DSH_HOME/cache/dsh-video-workbench/runtime` | 渲染运行时安装目录 |
| `chromePath` | 自动探测 | 指定浏览器可执行文件（覆盖探测链） |
| `renderTimeoutMs` | `600000` | 单次渲染超时 |
| `renderWorkers` | `2` | hyperframes worker 数 |
| `renderQuality` | `standard` | `draft` / `standard` / `high` |
| `keepRenders` | `5` | 每个项目保留的最新成片数 |
| `autoInstallRuntime` | `false` | 为 `true` 时启动后尝试自动安装（默认交给用户点按钮） |

## 9. 步骤（每步一个提交，结束时 `node scripts/verify.mjs` 必须全绿）

| # | 提交 | 内容 | 完成标准 |
| --- | --- | --- | --- |
| 0 | `docs: 记录 M2 运行时与 CLI 实测` | 本文件 + `hyperframes render --help` 结论 + 本机清单（node/pnpm/chrome/ffmpeg 实际路径，脱敏） | 文档合入 |
| 1 | `feat: 增加运行时探测与渲染参数构造` | `locate.ts`、`env.ts`、`args.ts` + 纯函数测试（探测顺序、env 白名单、argv 形状、node≥22 拒绝） | 无副作用、可在 CI 跑 | ✅ 已完成（27 项用例，测试 100→127） |
| 2 | `feat: 增加运行时供给与校验` | `supply.ts`：安装、二次重跑、二进制校验、`supplied.json`、锁与日志；`GET /runtime` | ✅ 从零安装成功（约 840 MB）；`Emitted ERR_PNPM_IGNORED_BUILDS` 不算失败，最终以二进制校验为准 |
| 3 | `feat: 增加渲染任务服务` | `jobs.ts`：状态机、并发 1、队列、超时；`render/routes.ts` 三个接口 | ✅ fake CLI 跑通成功/取消/超时/队列满；真机走通全链路 |
| 4 | `feat: 增加进度解析与取消清理` | `progress.ts`、`process.ts`、孤儿扫描、卸载清理 | ✅ 真实格式进度解析、取消/超时杀进程树、启动孤儿清理 |
| 5 | `feat: 增加产物落地与保留策略` | `outputs.ts`：版本递增、原子 rename、ffprobe 校验、保留 N、exportDir 复制与 `safeTitle` | ✅ 真机产物 `10.000000s / 1080×1920`，`index.json` 与导出副本正确 |
| 6 | `feat: 客户端渲染入口与进度 UI` | 工作台面板加「渲染 / 取消」+ 状态行 + 结果 `<video>`（复用现有播放器） | ✅ 真机跑通 10s 成片；v0.2.1 入口改到左侧栏 |
| 7 | `docs: 更新 M2 验收记录` | README / INSTALL / COMPAT / HANDOFF / 截图 | ✅ 文档与实测一致（截图留待 UI 实机验收后补） |

每一步都必须先写测试再动实现（纯函数优先）；步骤 3–5 用**假 CLI**（`test/fixtures/fake-hyperframes.mjs`）
驱动，不依赖真渲染。

## 10. 测试计划（目标 ≥120 项）

新增纯函数/集成用例：

- `locate`：node 版本拒绝（21）、chrome 候选顺序、显式 `chromePath` 优先、全部缺失时的错误码；
- `env`：白名单保留（`PATH`/`SYSTEMROOT`/`TEMP`）、黑名单剔除（`ELECTRON_*`/`NODE_OPTIONS`/`npm_*`）、
  `HYPERFRAMES_*` 注入值；
- `args`：aspect→resolution、quality/fps/workers 透传、输出路径在 `renders/.tmp`、不允许路径拼接注入；
- `progress`：ANSI/`\r` 清洗、单调性、阶段阈值、warning 收集、空输出；
- `jobs`：并发 1 与队列满 409、超时、取消（含已结束 409）、终态保留 10 分钟；
- `outputs`：版本递增、`.tmp` 残留清理、保留策略（6→5、忽略非 v 命名）、`safeTitle` 边界（全非法字符/超长/中文）、
  导出不覆盖；
- 路由：401 / 409 / 404 / 成功 202+200；`dsh boundary` 仍为空。

## 11. 验收清单（M2 DoD）

- [ ] `node scripts/verify.mjs` 全绿（含新增测试），`node --check index.js client.js` 通过
- [ ] 从零供给：删 `runtime/` 后点一次安装，`supplied.json` 生成、三个二进制 `-version` 通过
- [ ] 幂等：再次启动 0 网络、0 重装（日志可证）
- [ ] UI 内跑完 **10 s@1080p** 片：进度从 preparing → capturing → encoding → assembling → 100%
- [ ] 产物：`renders/v1.mp4` 可播放、时长/宽高正确；`renders/index.json` 正确
- [ ] 取消：渲染中点取消，5 s 内 `chrome-headless-shell` 与 node 子进程归零、无 `.tmp` 残留
- [ ] 超时：把 `renderTimeoutMs` 设 5000，任务转 `timedOut` 且进程清干净
- [ ] 保留：连渲 6 次后只剩最新 5 个；`exportDir` 有副本且命名正确、不覆盖
- [ ] 进程退出后重启 DSH：孤儿扫描清掉上次遗留（可用强杀模拟）
- [ ] 自检：新增 `runtimeReady` / `browserFound` / `ffmpegReady`（缺一即 `failed`，未配置项目仍 `skipped`）
- [ ] 亮/暗、窄窗口下进度 UI 可用；停用/卸载后无残留进程、定时器、`.tmp`

## 12. 风险

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| 首次安装失败（网络/权限/硬盘） | 功能不可用 | 失败码可读 + `install.log`；不自动重试，给按钮 |
| `pnpm --allow-build` 清单变化 | ffmpeg 缺失 → 渲染失败 | 安装后**执行**二进制校验，不只看文件存在 |
| Chrome 版本/GPU 差异 | 渲染崩溃或慢 | `HYPERFRAMES_BROWSER_PATH` + 失败归类；不支持则提示换 `--no-browser-gpu` |
| 长任务阻塞 Host | UI 卡顿 | 并发 1 + 全异步 + 进度节流（≤4 行/秒） |
| 进程残留 | 用户机器变慢 | 进程组/taskkill + 孤儿扫描 + 卸载清理，三处都测 |
| 磁盘增长 | 占满磁盘 | 保留 N + 只清 `v<数字>.mp4`；不碰用户其它文件 |
| `hyperframes` 输出文案变化 | 进度失效 | 解析器容错 + 失败时降级为"运行中"，产物校验兜底 |

## 13. 估时（5 人日，含测试）

| 步骤 | 人日 |
| --- | --- |
| 0 文档 + 实测记录 | 0.2 |
| 1 探测 + env + argv | 0.6 |
| 2 供给 + 校验 + 自检项 | 0.8 |
| 3 任务服务 + 路由 | 0.9 |
| 4 进度 + 取消 + 清理 | 0.8 |
| 5 产物 + 保留 + 导出 | 0.7 |
| 6 客户端 UI | 0.6 |
| 7 实机验收 + 文档 | 0.4 |

## 14. 已确认决定

**已确认（来自 PLAN / M0-FINDINGS，不再讨论）**

| 项 | 结论 |
| --- | --- |
| hyperframes 版本 | 固定 `0.6.33`，不跟随 DSH |
| 浏览器 | 优先复用系统 Chrome（`HYPERFRAMES_BROWSER_PATH`），下载只作后备 |
| 供给 | 托管 node + 托管 pnpm；`--allow-build` 逐包；装完重跑一次；执行校验 |
| 并发/超时 | 并发 1；单次 10 分钟 |
| 进程清理 | 子进程树 kill + 卸载清理 + 启动孤儿扫描 |
| 产物 | `renders/vN.mp4` 原子落地；保留最近 5 个；`exportDir` 只写不读、不覆盖、失败只记日志 |
| 环境变量 | 显式最小 env；剔除 `ELECTRON_*` / `NODE_OPTIONS` 等继承变量 |
| 路由安全 | 沿用单一 token；只暴露只读文件 + 本插件的渲染控制接口 |

**2026-11-19 拍板（原"待确认"3 项，按建议采纳）**

| # | 决定 | 结论 | 落地位置 |
| --- | --- | --- | --- |
| A | 进度通道 | **HTTP 轮询，1 s 间隔**；不做 SSE/WS（不引入 `registerUpgrade` 的不确定性） | §3.3 三个路由 + 步骤 6 UI 轮询 |
| B | 渲染结果存哪 | **新增 `renders/index.json`**（倒序数组），`project.json` **保持 schemaVersion 1**，不写 migrate | §7 产物、步骤 5 |
| C | 首次安装 UX | **M2 最小可用**：`安装运行时` 按钮 + 状态轮询 + 失败码 + `install.log` 入口；百分比/预估/断点留 M4 | §4.4、步骤 2 + 6 |

三项均已并入上面的正文，不再有待确认项。

**执行中被实测推翻/修正的假设（重要，M3 起沿用）**

| 原假设 | 实测结论 | 影响 |
| --- | --- | --- |
| 合成入口是 `<project>/composition/index.html` | **错误**：`hyperframes render <DIR>` 只认 `<DIR>/index.html`，`-c` 只能选择 DIR 内的文件 | 布局改为 `<project>/index.html` 为入口；`composition/` 保留给 M4 子合成 |
| 临时产物 `.vN.mp4.tmp-<rand>` | **错误**：CLI 按扩展名推断容器，`.tmp` 直接失败 | 临时文件改为 `.vN.tmp-<rand>.mp4`，成功后 rename 成 `vN.mp4` |
| 由调用方负责生成合成 | 只写脚手架还不够：必须在页面里注册 `window.__timelines[id]` | 脚手架内置最小 timeline 契约对象；未注册时渲染器空等 45 秒 |
| Chrome 能自动找到 | **错误**：hyperframes 在 Windows 不扫描系统 Chrome，会尝试联网下载 | 渲染 env 必须带 `HYPERFRAMES_BROWSER_PATH`（已由 `chromePick` 注入） |
| 任何时长都能精确 | `totalFrames = ceil(duration × fps)` | 想精确到 `10.000s` 必须让 `duration × fps` 为整数（脚手架按分镜时长求和） |
| 用命名 web 字体 | 非通用字族会联网抓 Google Fonts | 脚手架只用 `sans-serif`；自定义字体需本地 `@font-face` |
| 项目一定已有文案 | M1 示例项目分镜文案为空 → 成片全黑 | 脚手架对空文案兜底（首镜用项目标题、其余用「分镜 N」） |
| 播放器按宽度自适应即可 | 9:16 成片按宽度铺满会有 1900+ px 高，弹层超出屏幕 | 成片限高（`max-height:min(52vh,460px)`），弹层用 `100dvh` 封顶 |
| 项目由用户自己创建 | UI 里没有创建入口，无法在应用内完成 10s 验收 | 新增 `POST /projects-create`（2 分镜/合计 10s 示例）+「新建 10 秒示例」按钮 |

## 15. 开工前的一次性核对（步骤 0 内容预告）

- 记下本机：托管 node 路径与版本、托管 pnpm 路径、系统 Chrome 路径、`hyperframes render --help` 输出；
- 跑一次 `pnpm add hyperframes@0.6.33 …--allow-build` 的完整命令与耗时，写进文档（供首次安装文案用）；
- 确认 `taskkill /T /F` 能杀掉 hyperframes 拉起的 `chrome-headless-shell`（M0 已验证，记结论）。
