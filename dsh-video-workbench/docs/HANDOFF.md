# 交接文档（HANDOFF）

> 给下一个会话/下一个人的入口。读完这一页就能继续工作，不必翻历史对话。
> 最后更新：2026-11-19，**M1 代码与文档完成**（版本 `0.1.0`）；仅剩桌面端重启验收。

## 1. 这是什么

DSH Desktop 的短视频制作工作台插件（`dsh-video-workbench`），最终目标是：
agent 在对话里出片（素材 → 配音 → HyperFrames 合成 → 本地渲染 → 浮层预览与微调）。

- 仓库：`D:\Terry\Code\DSH-Plugin`（只放插件，不改 DSH 本体）
- 插件目录：`dsh-video-workbench/`
- 当前阶段：**M0 完成；M1 代码/文档完成**（构建、适配层、项目模型与路由、`video_selfcheck`、文档）
- 待办：**桌面端完全重启后的实机验收**（清单见 [README](../README.md)「M1 验收」与本文件 §6）
- 版本：`0.1.0`；分支 `main`（本轮提交尚未 push）
- 验收环境：Windows 11 + DSH Desktop `0.2.2-rc.3`

## 2. 一分钟上手

```powershell
cd D:\Terry\Code\DSH-Plugin\dsh-video-workbench

# 构建（源码 src/ → 根目录 index.js / client.js）
node scripts/build.mjs

# 全量校验：类型 → DSH 边界 → 构建 → 产物一致 → 语法 → 测试（65 项）
node scripts/verify.mjs

# 只跑测试
node --test

# 安装状态
node scripts/install.mjs --check

# 重启后的启动自检结果（需要先重启过 DSH）
Get-Content "$env:USERPROFILE\.dsh\cache\dsh-video-workbench\selfcheck.json" -Raw
```

工具链通过 DSH 托管运行时安装（`pnpm` 在 `%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies`）。
当前 devDependencies：`typescript@7.0.2`、`esbuild@0.28.2`、`@types/node`、`@types/react`。
**`node_modules` 已被仓库根 `.gitignore` 忽略，不要提交。**

## 3. 现状与文件地图

```text
dsh-video-workbench/
├── src/host/index.ts            # apply 组装、ping/media/projects/selfcheck 路由、token、Range/ETag
├── src/host/paths.ts            # safeResolve / isFilesystemRoot / contains
├── src/host/adapters/           # web-server.ts（registerRoute / onIndexInject / getOrigin + owner 过滤）
│                                # logger.ts、lifecycle.ts（随插件生命周期清理的定时器）
├── src/host/projects/           # schema.ts（v1 校验）、migrate.ts、store.ts（原子写、slug、CRUD）、root.ts
├── src/host/selfcheck.ts        # video_selfcheck 的 5 项检查（真实 HTTP 探测）
├── src/host/selfcheck-report.ts # 启动自检结果写盘 / 读取
├── src/client/index.tsx         # ▶ 入口、浮层、播放器、错误重试
├── src/client/adapters/         # slots.ts（entry / overlay）、context.ts（token / baseURL / 样式）、loader.ts
├── src/shared/                  # dsh.ts（手写 DSH 类型）、routes.ts（路径与 token 全局名）
├── index.js / client.js         # 构建产物（已提交，首行有生成标记）
├── scripts/{build,verify,install}.mjs
├── test/{range,media,guard,projects,selfcheck}.test.mjs   # 65 项
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
2. **插件路由不受 Host 鉴权保护**。`/api/*` 在插件路由未挂载时会落到网关并返回
   **纯文本 `unauthorized`**；插件自己挂上后返回的是本插件的 pretty JSON 401
   （`{\n  "error": "unauthorized"\n}`）。这个差异可以判断路由是否真的挂载。
3. **token 通过 `webserver/index-inject` 注入**（`(table, peer)`，只给 `peer.principal.kind === 'owner'` 的页面）。
   该注入**只在应用启动时采集一次**：刷新页面不够，必须完全退出并重开 DSH。
4. **客户端 bundle 图也只在启动时合成**。Host 改动可以热生效，客户端改动必须重启。
5. **`/plugins/<包名>/client.js` 不是可用探测地址**（客户端正常时也可能 404）。
   判断客户端是否加载：看 `conversation.input.left` 是否有 `video-workbench-trigger`。
6. **`shell.overlay` 是 click-through 层**，浮层根节点需要自己 `pointer-events: auto`。
7. **构建约定**：client 必须 classic JSX（`React.createElement`），模块表只提供 `react`，
   没有 `react/jsx-runtime`；产物要包在 `window.__ModuleLoader__.load({ id, factory(require) })` 里。
8. **测试用 `node:http` + `agent:false`**，不要用全局 `fetch`：连接池会与临时端口复用竞争，
   曾出现约 1/50 的偶发失败。（`video_selfcheck` 走真实 `fetch` 是产品行为，测试里可注入 fake fetch。）
9. **HyperFrames**（M2 起）：固定 `0.6.33`；Chrome 自动下载在本机网络不可用，要用
   `HYPERFRAMES_BROWSER_PATH` 指向系统 Chrome；pnpm 需要 `--allow-build` 才能装好 ffmpeg/onnxruntime。
10. **`webServer.getOrigin()` 能拿到真实 `http://127.0.0.1:<port>`**：监听绑定后才可用，之前会 throw。
    `video_selfcheck` 用它做真实 HTTP 自检（而不是只调 handler），访问器在
    `src/host/adapters/web-server.ts` 里包了 try/catch，绑定前返回 `undefined`。
11. **启动自检靠定时器**：`apply` 里 `defer(ctx, 3000, ...)`（`adapters/lifecycle.ts`）在监听绑定后跑自检，
    结果写到 `dataDir/selfcheck.json` 并打日志；`selfcheckOnStartup: false` 可关闭。
12. **profile 侧配置按 id 覆盖**：profile 的 `cordis.patch.yml` 写
    `- id: video-workbench` / `name: dsh-video-workbench` / `config: {...}` 即可覆盖插件 Config；
    运行中手改可能被应用回写覆盖，改动前后都确认一次（备份在 profile 目录）。

## 5. 已确认的决定

| 项 | 结论 |
| --- | --- |
| 平台 | Windows + DSH Desktop；Web/macOS 不验收 |
| 项目根 | `projectsRoot` **必填**，放 `D:\Terry\Videos\dsh-video\video-projects`（D 盘专用工作区，不占 C 盘）；未配置时项目功能禁用 |
| 导出目录 | `exportDir` 可选，`D:\Terry\Videos\dsh-video\video-exports`；媒体/项目路由都不暴露 |
| slug | 时间戳 `YYYYMMDD-HHmmss`，目录创建后不可变；标题存 `project.json` |
| 自检报告 | `dataDir/selfcheck.json`，`dataDir` 默认 `$DSH_HOME/cache/dsh-video-workbench` |
| 运行时缓存 | 留默认位置（约 1.8 GB 在 C 盘），M2 不迁移 |
| 生图 / TTS | 火山方舟 Seedream / 火山 TTS + 本地 Kokoro 兜底（M3 实现） |

工作区目录已建好（`video-projects/`、`video-exports/`；`spike-m0/` 是 M0 渲染测试遗留）。
Desktop profile 已写入上面的 `projectsRoot` / `exportDir`（备份：profile 目录下
`cordis.patch.yml.bak-video-workbench-*`）。

## 6. M1 状态与剩余验收

M1 五个步骤全部完成（提交见 `git log --oneline`）：

| # | 提交 | 内容 |
| --- | --- | --- |
| 1 | `chore: 引入 TypeScript 与 esbuild 构建` | src/ 迁移、build/verify、产物提交 |
| 2 | `refactor: 抽取 DSH 适配层` | host/client adapters、`shared/routes.ts`、`dsh boundary` 检查 |
| 3 | `feat: 加入项目模型与项目路由` | schema/migrate/store、`projectsRoot`/`exportDir`、`/projects` 路由 |
| 4 | `feat: 增加 video_selfcheck` | 5 项检查、`/selfcheck` 路由、`getOrigin()` |
| 5 | `docs: 更新 M1 验收记录` | README/INSTALL/COMPAT/HANDOFF/M1-PLAN、版本 0.1.0、启动自检报告 |

自动化验收已通过（`node scripts/verify.mjs`：类型、边界、构建、产物一致、语法、65 项测试）。

**剩余：桌面端完全重启后的实机验收**（本轮会话运行在 DSH 内部，重启会终止会话，因此未执行）：

1. 完全退出 DSH（含托盘图标），重新打开；
2. 等 3 秒后读 `$DSH_HOME\cache\dsh-video-workbench\selfcheck.json`，确认 `"ok": true`、5 项全绿；
3. 点开 composer 左侧 ▶：`tokenPresent: true`、`media.status: 206`、播放/拖动、Esc、错误态重试；
4. 项目路由：`/projects?path=<slug>/project.json` 200、`renders/` 下的 mp4 206；
5. 亮/暗主题、侧栏展开/收起、窄窗口快速过一遍；
6. 把结果补进 `README.md` 的「已验证」表与 `docs/COMPAT.md`。

也可以在页面 DevTools 控制台手动复跑：

```js
const t = window.__DSH_VIDEO_WORKBENCH__.token
const r = await fetch(`/api/video-workbench/selfcheck?t=${t}`).then((x) => x.json())
console.table(r.checks); r.ok
```

## 7. M2 及之后（概要）

见 `PLAN.md` 里程碑表：M2 渲染管线（运行时供给、进度/取消、原子写入）、M3 素材与配音、
M4 Agent 工具主路径、M5 微调工作台、M6 交付打磨。M2 开工前先读 `docs/M0-FINDINGS.md`
里关于 Chrome / ffmpeg / pnpm `--allow-build` 的结论，别重复踩坑。

## 8. 新会话的第一条命令

```powershell
cd D:\Terry\Code\DSH-Plugin
git log --oneline -5
git status --short
cd dsh-video-workbench
node scripts/verify.mjs
Get-Content "$env:USERPROFILE\.dsh\cache\dsh-video-workbench\selfcheck.json" -Raw
```

`verify` 全绿说明环境正常；`selfcheck.json` 存在且 `ok: true` 说明实机验收已过。
任何一步失败，先修 `verify` 再动业务代码。

## 9. 已知未决/可选

- **客户端 bundle 有双层 `__ModuleLoader__.load`**：`scripts/build.mjs` 用
  `load({ id, factory })` 包住整个 bundle（为了给工厂里的 `require` 提供作用域），
  而 `src/client/index.tsx` 的 `loadClientModule(...)` 在工厂执行时又对同一个 `id`
  注册一次。M0 实机通过说明外壳能容忍这种情况，但这是冗余，正常形态应只注册一次。
  修复需要改构建包装（内层 export 改为直接返回插件对象）并**完全重启 DSH 实机验证**；
  建议和 M1 实机验收一起做。
- Desktop profile 的 `cordis.patch.yml` 配置是**应用运行期间**写进去的；如果应用退出时回写覆盖，
  需要按 §4 第 12 条重新加一次（内容见 [INSTALL.md](../INSTALL.md)「配置」）。
- `package.json` 的 `files` 目前只含产物，不含 `src/` 与 `tsconfig.json`。link 安装无影响；
  若将来要发布 tgz 并允许他人重建，需要把源码一并纳入。
- `exportDir` 目前只有配置与日志，写入逻辑在 M2；工作区目录 `D:\Terry\Videos\dsh-video`
  还没在 DSH 里注册成工作区（可选，仅影响浏览体验）。
