# 交接文档（HANDOFF）

> 给下一个会话/下一个人的入口。读完这一页就能继续工作，不必翻历史对话。
> 最后更新：2026-11-19，对应提交 `refactor: 抽取 DSH 适配层`（M1 步骤 2 完成）。

## 1. 这是什么

DSH Desktop 的短视频制作工作台插件（`dsh-video-workbench`），最终目标是：
agent 在对话里出片（素材 → 配音 → HyperFrames 合成 → 本地渲染 → 浮层预览与微调）。

- 仓库：`D:\Terry\Code\DSH-Plugin`（只放插件，不改 DSH 本体）
- 插件目录：`dsh-video-workbench/`
- 当前阶段：**M0 完成；M1 步骤 1–2 完成**（下一步：步骤 3 项目模型与项目路由）
- 版本：`0.0.4`；分支 `main`；远端 `origin/main` 与本地同步
- 验收环境：Windows 11 + DSH Desktop `0.2.2-rc.3`

## 2. 一分钟上手

```powershell
cd D:\Terry\Code\DSH-Plugin\dsh-video-workbench

# 构建（源码 src/ → 根目录 index.js / client.js）
node scripts/build.mjs

# 全量校验：类型 → DSH 边界 → 构建 → 产物一致 → 语法 → 测试
node scripts/verify.mjs

# 只跑测试
node --test

# 安装状态
node scripts/install.mjs --check
```

工具链通过 DSH 托管运行时安装（`pnpm` 在 `%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies`）。
当前 devDependencies：`typescript@7.0.2`、`esbuild@0.28.2`、`@types/node`、`@types/react`。
**`node_modules` 已被仓库根 `.gitignore` 忽略，不要提交。**

## 3. 现状与文件地图

```text
dsh-video-workbench/
├── src/host/index.ts        # 媒体路由、token、Range/ETag、路径校验、apply 组装
├── src/host/adapters/       # web-server.ts（registerRoute / onIndexInject + owner 过滤）、logger.ts
├── src/client/index.tsx     # ▶ 入口、浮层、播放器、错误重试
├── src/client/adapters/     # slots.ts（entry / overlay）、context.ts（token / baseURL / 样式）、loader.ts
├── src/shared/              # dsh.ts（手写 DSH 类型）、routes.ts（路径与 token 全局名）
├── index.js / client.js     # 构建产物（已提交，首行有生成标记）
├── scripts/{build,verify,install}.mjs
├── test/{range,media,guard}.test.mjs   # 36 项
├── docs/{M0-FINDINGS,M1-PLAN,UPGRADE-PLAYBOOK,COMPAT,HANDOFF}.md
└── package.json / cordis.patch.yml / locale / icon.svg / README / INSTALL / LICENSE
```

**DSH 边界规则**：`src/host/` 与 `src/client/` 的业务文件不得直接出现
`webServer`、`slots.`、`__ModuleLoader__`、`__DSH_VIDEO_WORKBENCH__`；
只有 `*/adapters/*` 可以出现，类型声明文件 `shared/dsh.ts`（只命名类型、不发调用）
与线路常量文件 `shared/routes.ts`（持有 token 全局名）例外。`verify` 会自动检查。

M0 已验证：`dsh-app://app` 下路由可达、token 注入、Range 206、播放/拖动、取消渲染无残留。
详见 `docs/M0-FINDINGS.md`。

## 4. 必须知道的 DSH 事实（踩过的坑）

1. **Desktop 页面 origin 是 `dsh-app://app`**。外壳把非静态请求转发到 Host 并注入 cookie，
   同时**剥掉 `origin`、原样转发 `Range`**。所以 Host 侧不要校验 Origin，相对路径能直接用。
2. **插件路由不受 Host 鉴权保护**。`/api/*` 在插件路由未挂载时会落到网关并返回 401；
   插件自己挂上后就必须自己鉴权——当前用随机 token（`?t=` 或 `x-dsh-video-workbench-token`）。
3. **token 通过 `webserver/index-inject` 注入**（`(table, peer)`，只给 `peer.principal.kind === 'owner'` 的页面）。
   该注入**只在应用启动时采集一次**：刷新页面不够，必须完全退出并重开 DSH。
4. **客户端 bundle 图也只在启动时合成**。Host 改动可以热生效，客户端改动必须重启。
5. **`/plugins/<包名>/client.js` 不是可用探测地址**（客户端正常时也可能 404）。
   判断客户端是否加载：看 `conversation.input.left` 是否有 `video-workbench-trigger`。
6. **`shell.overlay` 是 click-through 层**，浮层根节点需要自己 `pointer-events: auto`。
7. **构建约定**：client 必须 classic JSX（`React.createElement`），模块表只提供 `react`，
   没有 `react/jsx-runtime`；产物要包在 `window.__ModuleLoader__.load({ id, factory(require) })` 里。
8. **测试用 `node:http` + `agent:false`**，不要用全局 `fetch`：连接池会与临时端口复用竞争，
   曾出现约 1/50 的偶发失败。
9. **HyperFrames**（M2 起）：固定 `0.6.33`；Chrome 自动下载在本机网络不可用，要用
   `HYPERFRAMES_BROWSER_PATH` 指向系统 Chrome；pnpm 需要 `--allow-build` 才能装好 ffmpeg/onnxruntime。

## 5. 已确认的决定

| 项 | 结论 |
| --- | --- |
| 平台 | Windows + DSH Desktop；Web/macOS 不验收 |
| 项目根 | `projectsRoot` **必填**，默认放 `D:\Terry\Videos\dsh-video\video-projects`（D 盘专用工作区，不占 C 盘）；未配置时项目功能禁用 |
| 导出目录 | `exportDir` 可选，`D:\Terry\Videos\dsh-video\video-exports`；媒体路由不暴露 |
| slug | 时间戳 `YYYYMMDD-HHmmss`，目录创建后不可变；标题存 `project.json` |
| 运行时缓存 | 留默认位置（约 1.8 GB 在 C 盘），M2 不迁移 |
| 生图 / TTS | 火山方舟 Seedream / 火山 TTS + 本地 Kokoro 兜底（M3 实现） |

工作区目录已建好（`video-projects/`、`video-exports/`；`spike-m0/` 是 M0 渲染测试遗留）。

## 6. 接下来做什么（M1 步骤 3–5）

详细方案见 `docs/M1-PLAN.md`。按顺序做，每步一个提交，每步结束 `node scripts/verify.mjs` 必须全绿。

### 步骤 2：抽取 DSH 适配层 ✅ 已完成

提交 `refactor: 抽取 DSH 适配层`：

- `src/host/adapters/web-server.ts`：`withWebServer(ctx, setup)` + `registerRoute` / `onIndexInject`，
  owner 过滤收进适配层（业务只拿到注入表，不再判断 peer）；
- `src/host/adapters/logger.ts`：`ctx.logger` 缺失时 no-op；
- `src/client/adapters/slots.ts`：`registerEntry` / `registerOverlay`；
- `src/client/adapters/context.ts`：token 读取、`document.baseURI` 解析、样式注入；
- `src/client/adapters/loader.ts`：`loadClientModule`（`__ModuleLoader__` 只在这里出现）；
- `src/shared/routes.ts`：路径、token 全局名、token 头名单点定义；
- `scripts/verify.mjs` 新增 `dsh boundary` 检查，防止后续步骤把 DSH 调用写回业务代码。

验收：`node --test` 仍为 36 项全绿；`node scripts/verify.mjs` 全绿。
**未做**：客户端 bundle 有变化，但只在静态层面校验，**尚未实机重启验证**（步骤 5 一并做）。

### 步骤 3：项目模型与项目路由（0.75 人日）

- 新增 `src/host/projects/{schema,migrate,store}.ts`：
  - `project.json` v1（字段表见 M1-PLAN 第 5.1 节），手写校验器，返回 `{ ok, project }` / `{ ok: false, errors }`；
  - 原子写（临时文件 + rename）；`read` 先迁移再校验；
  - slug 时间戳生成，`id` 与目录名一致。
- `Config` 增加 `projectsRoot`（必填）、`exportDir`（可选）。
- 新增路由 `/api/video-workbench/projects`（与 `/media` 共用 token，只读、支持 Range）。
- 测试：schema 合法/非法、迁移、原子写、路由 401/206/404/穿越。
- 提交：`feat: 加入项目模型与项目路由`

### 步骤 4：video_selfcheck（0.25 人日）

5 项检查（见 M1-PLAN 第 7 节）：路由挂载、token 要求、媒体 206、projectsRoot 可写、projects 路由可读。
输出 `{ ok, checks: [{ name, ok, detail }] }`。
提交：`feat: 增加 video_selfcheck`

### 步骤 5：实机验收与文档（0.5 人日）

- 完全重启 DSH，逐项过 M1 DoD（M1-PLAN 第 10 节）。
- 更新 README / COMPAT / 截图。
- 提交：`docs: 更新 M1 验收记录`

## 7. M2 及之后（概要）

见 `PLAN.md` 里程碑表：M2 渲染管线（运行时供给、进度/取消、原子写入）、M3 素材与配音、
M4 Agent 工具主路径、M5 微调工作台、M6 交付打磨。M2 开工前先读 `docs/M0-FINDINGS.md`
里关于 Chrome / ffmpeg / pnpm `--allow-build` 的结论，别重复踩坑。

## 8. 新会话的第一条命令

```powershell
cd D:\Terry\Code\DSH-Plugin
git log --oneline -3
git status --short
cd dsh-video-workbench
node scripts/verify.mjs
```

全绿说明环境正常，直接从「步骤 3」开始；任何一步失败，先修 `verify` 再动业务代码。

## 9. 已知未决/可选

- **客户端 bundle 有双层 `__ModuleLoader__.load`**：`scripts/build.mjs` 用
  `load({ id, factory })` 包住整个 bundle（为了给工厂里的 `require` 提供作用域），
  而 `src/client/index.tsx` 的 `loadClientModule(...)` 在工厂执行时又对同一个 `id`
  注册一次。M0 实机通过说明外壳能容忍这种情况，但这是冗余，正常形态应只注册一次。
  修复需要改构建包装（内层 export 改为 `module.exports` 直接返回插件对象）并**完全重启
  DSH 实机验证**；不要在步骤 3/4 顺手改，留到一次带实机验收的提交。
- `package.json` 的 `files` 目前只含产物，不含 `src/` 与 `tsconfig.json`。link 安装无影响；
  若将来要发布 tgz 并允许他人重建，需要把源码一并纳入。
- `exportDir` 的默认值尚未写进 `Config`（当前只是"可选、未配置不导出"）。
- 工作区目录 `D:\Terry\Videos\dsh-video` 还没在 DSH 里注册成工作区（可选，仅影响浏览体验）。
