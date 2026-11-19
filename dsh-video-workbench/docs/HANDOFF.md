# 交接文档（HANDOFF）

> 给下一个会话/下一个人的入口。读完这一页就能继续工作，不必翻历史对话。
> 最后更新：2026-11-19，**M2 已完成**（版本 `0.2.0`，真实渲染冒烟通过；浮层 UI 待重启确认）；下一步 M3。

## 1. 这是什么

DSH Desktop 的短视频制作工作台插件（`dsh-video-workbench`），最终目标是：
agent 在对话里出片（素材 → 配音 → HyperFrames 合成 → 本地渲染 → 浮层预览与微调）。

- 仓库：`D:\Terry\Code\DSH-Plugin`（只放插件，不改 DSH 本体）
- 插件目录：`dsh-video-workbench/`
- 当前阶段：**M2 完成**（渲染运行时供给、渲染任务/进度/取消/超时、产物保留与导出、浮层渲染 UI）；
  M2 的执行文档与被推翻的假设见 [M2-PLAN.md](M2-PLAN.md)
- 已实机验证：DSH Desktop `0.2.2-rc.5` 完全重启后 Host 自检 **5/5** + 客户端半区**全部通过**（2026-11-19）
- 待办：浮层 UI 实机确认 + M3（素材与配音）；Web / macOS 仍未验证
- 版本：`0.2.0`（M2；`index.js` / `client.js` 均已变更，需重启验证 UI）；分支 `main`
- 验收环境：Windows 11 + DSH Desktop `0.2.2-rc.5`（2026-11-19 从 `0.2.2-rc.3` 升级）

## 2. 一分钟上手

```powershell
cd D:\Terry\Code\DSH-Plugin\dsh-video-workbench

# 构建（源码 src/ → 根目录 index.js / client.js）
node scripts/build.mjs

# 全量校验：类型 → DSH 边界 → 构建 → 产物形态 → 产物一致 → 语法 → 测试（158 项）
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

注意：`verify` 的「产物一致」是拿工作树和 **HEAD** 比的——`index.js` / `client.js`
还没提交时必然报 `artifact consistency failed`（只 `git add` 不算）。改完源码后
"先构建、再提交产物、最后看到 verify 全绿"是预期流程。

## 3. 现状与文件地图

```text
dsh-video-workbench/
├── src/host/index.ts            # apply 组装、ping/media/projects/selfcheck 路由、token、Range/ETag
├── src/host/atomic.ts           # 原子写（临时文件 + rename，失败连临时文件一起清）
├── src/host/paths.ts            # safeResolve / isFilesystemRoot / contains / Windows 保留名
├── src/host/adapters/           # web-server.ts（registerRoute / onIndexInject / getOrigin + owner 过滤）
│                                # logger.ts（+ redactPath 日志脱敏）、lifecycle.ts（defer + 卸载清理）
├── src/host/projects/           # schema.ts（v1 校验）、migrate.ts、store.ts（原子写、slug、CRUD）、root.ts
├── src/host/selfcheck.ts        # video_selfcheck 的 8 项检查（HTTP 探测 + 运行时/浏览器/ffmpeg）
├── src/host/selfcheck-report.ts # 启动自检结果写盘 / 读取（逐项校验）
├── src/host/http.ts             # sendJson / readToken / rejectRequest（所有路由共用）
├── src/host/projects/routes.ts  # projects-list 路由
├── src/host/runtime/            # locate.ts（node/pnpm/Chrome 探测）、env.ts（子进程最小 env）、
│                                # supply.ts（安装/校验/幂等/锁）、status.ts、routes.ts
├── src/host/render/             # args.ts（argv）、progress.ts（ANSI + 阶段）、process.ts（进程树/孤儿）、
│                                # jobs.ts（状态机/队列/超时/产物）、outputs.ts（版本/保留/导出）、
│                                # scaffold.ts（离线合成脚手架）、routes.ts（渲染三接口）
├── src/client/index.tsx         # ▶ 入口、浮层、播放器、错误重试；export default 插件对象
├── src/client/adapters/         # slots.ts（entry / overlay）、context.ts（token / baseURL / 样式）
├── src/shared/                  # dsh.ts（手写 DSH 类型）、routes.ts（路径与 token 全局名）
├── index.js / client.js         # 构建产物（已提交，首行有生成标记）
├── scripts/{build,verify,install,check-selfcheck,render-smoke}.mjs
├── test/{range,media,guard,projects,selfcheck,client-bundle,install,manifest,runtime,env,render,supply,render-pipeline}.test.mjs   # 158 项
├── docs/{M0-FINDINGS,M1-PLAN,M2-PLAN,UPGRADE-PLAYBOOK,COMPAT,HANDOFF}.md
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
   没有 `react/jsx-runtime`；产物要包在 DSH 的 lazy-CJS loader 调用里，**每个 id 只注册一次**。
   - `id` 由 `scripts/build.mjs` 从 `package.json` 的 `name` 读取，不要再手写；
   - `src/client/index.tsx` 只 `export default` 插件对象，构建脚本的工厂返回这个 default，
     **源码里不允许再调用 loader**（v0.1.0 期间出现过 DSH 客户端数据损坏；重复注册是本次
     修复中的关键一项，不要再引入）。
   - 两道自动防线：`verify` 的 `artifact shape`（`loadCount === 1`）与
     `test/client-bundle.test.mjs`（真实产物进 VM，工厂执行后再断言只注册一次）。
8. **测试用 `node:http` + `agent:false`**，不要用全局 `fetch`：连接池会与临时端口复用竞争，
   曾出现约 1/50 的偶发失败。（`video_selfcheck` 走真实 `fetch` 是产品行为，测试里可注入 fake fetch。）
9. **HyperFrames**（M2 起）：固定 `0.6.33`；Chrome 自动下载在本机网络不可用，要用
   `HYPERFRAMES_BROWSER_PATH` 指向系统 Chrome；pnpm 需要 `--allow-build` 才能装好 ffmpeg/onnxruntime。
10. **`webServer.getOrigin()` 能拿到真实 `http://127.0.0.1:<port>`**：监听绑定后才可用，之前会 throw。
    `video_selfcheck` 用它做真实 HTTP 自检（而不是只调 handler），访问器在
    `src/host/adapters/web-server.ts` 里包了 try/catch，绑定前返回 `undefined`。
11. **启动自检靠定时器**：`apply` 里 `defer(ctx, 3000, ...)`（`adapters/lifecycle.ts`）在监听绑定后跑自检，
    结果写到 `dataDir/selfcheck.json` 并打日志；`selfcheckOnStartup: false` 可关闭。
    0.1.2 起 `defer` 支持卸载回调：插件卸载/热重载会 `abort` 正在跑的自检，不会再写旧报告；
    `projectsRoot` 未配置时两项项目检查是 `skipped`（`ok: true`）而不是失败。
12. **profile 侧配置按 id 覆盖**：profile 的 `cordis.patch.yml` 写
    `- id: video-workbench` / `name: dsh-video-workbench` / `config: {...}` 即可覆盖插件 Config；
    运行中手改可能被应用回写覆盖，改动前后都确认一次（备份在 profile 目录）。
13. **改 profile 的 `cordis.patch.yml` 会热重载插件 Host 半区**（2026-11-19 实测：写入配置后
    约 3 秒，启动自检自动重跑；再追加一行注释又重跑一次）。Host 改动/配置不用重启就生效，
    但**客户端 bundle 仍只在启动时合成**，所以客户端验收必须完全重启。
    热重载会重新生成 token，旧页面要刷新或重启后才拿到新 token。
14. **`engines.dsh` 用 `semver.satisfies(runtime, range, { includePrerelease: true })` 判定**
    （`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`），即**预发布版本参与范围匹配**。
    当前范围是无上限的 `>=0.2.2-rc.5`：`0.2.2-rc.5` 及以后全部放行，`rc.4` 及更早拒绝。
    **代价与检测**：不再有"版本不匹配自动停用"的保护，DSH 破坏性升级会照常加载插件；
    检测手段是启动自检（`node scripts/check-selfcheck.mjs`），失败就手动停用并复测。
    改范围前用该函数实测，别凭直觉；`test/manifest.test.mjs` 会锁定当前范围。
15. **文件路由的 `Range` 语义**（0.1.2 起）：只处理单个 `bytes` 段。多段（`bytes=0-1,3-4`）、
    未知单位、语法不认识的头**忽略并回 200 整文件**（RFC 9110 §14.2）；只有合法但取不到的
    单个范围才回 `416`。旧实现把所有不认识的头都当 `416`，会打断多段下载器。
16. **写盘统一走 `src/host/atomic.ts`**：临时文件也在 try 里，写临时文件本身失败（ENOSPC/EACCES）
    不会再残留 `.tmp-*`。`project.json` 与 `selfcheck.json` 都用它。
17. **日志里的路径要脱敏**：`adapters/logger.ts` 的 `redactPath` 把 home 前缀换成 `~`，其它绝对
    路径只留最后两段（`…\video-projects`）。不要再把 `mediaRoot` / `projectsRoot` 原样打日志。

18. **hyperframes 0.6.33 的渲染契约（实测，M2 踩坑）**：`render <DIR>` 只认 `<DIR>/index.html`
    （必须是完整文档，根元素带 `data-composition-id` + `data-width/height/duration`；`-c` 只能选 DIR 内文件）；
    每个合成必须注册 `window.__timelines[id]`，否则渲染器空等 45 秒；CSS 动画会被 css adapter
    按 `(t - data-start)` 精确 seek（**可用，且不需要 GSAP**）；`setTimeout` 不被虚拟化，别用来做动画；
    非通用字体会联网抓 Google Fonts，CDN 脚本会被编译期抓取 → 离线合成只能用 `sans-serif` + 本地资源。
19. **Windows 上必须显式给 Chrome**：hyperframes 不会扫描系统 Chrome，找不到就尝试联网下载；
    渲染 env 里必须有 `HYPERFRAMES_BROWSER_PATH`（由 `chromePick` 注入）。
20. **时长精度**：`totalFrames = ceil(duration × fps)`；要 `10.000s` 就必须让 `duration × fps` 是整数。
21. **临时产物必须带 `.mp4` 后缀**：CLI 按扩展名推断容器，`.vN.mp4.tmp-x` 会直接失败；用 `.vN.tmp-x.mp4`。
22. **`pnpm add` 的 `ERR_PNPM_IGNORED_BUILDS` 会以 exit 1 结束**：不能只看退出码，最终以「执行二进制
    `-version`」为准（`supply.ts` 已这样处理）。
## 5. 已确认的决定

| 项 | 结论 |
| --- | --- |
| 平台 | Windows + DSH Desktop；Web/macOS 不验收 |
| 项目根 | `projectsRoot` **必填**，放 `D:\Terry\Videos\dsh-video\video-projects`（D 盘专用工作区，不占 C 盘）；未配置时项目功能禁用 |
| 导出目录 | `exportDir` 可选，`D:\Terry\Videos\dsh-video\video-exports`；媒体/项目路由都不暴露 |
| slug | 时间戳 `YYYYMMDD-HHmmss`，目录创建后不可变；标题存 `project.json` |
| 自检报告 | `dataDir/selfcheck.json`，`dataDir` 默认 `$DSH_HOME/cache/dsh-video-workbench` |
| `engines.dsh` | `>=0.2.2-rc.5`（自用、不对外分发 → **不设上限**；升级不再被门禁停用，破坏性变更靠启动自检发现，详见 §4 第 14 条与 [COMPAT](COMPAT.md)） |
| 运行时缓存 | 留默认位置（约 1.8 GB 在 C 盘），M2 不迁移 |
| 生图 / TTS | 火山方舟 Seedream / 火山 TTS + 本地 Kokoro 兜底（M3 实现） |

工作区目录已建好（`video-projects/`、`video-exports/`；`spike-m0/` 是 M0 渲染测试遗留）。
Desktop profile 的配置（`cordis.patch.yml` 里的 `projectsRoot` / `exportDir`）在应用运行期间
写入，可能被退出时回写覆盖；**profile 被重置后需要按 [INSTALL.md](../INSTALL.md)「配置」重新加一次**。
当前 profile 状态见 §6 末尾「环境现状」。

## 6. M1 验收记录（已完成）

M1 五个步骤全部完成（提交见 `git log --oneline`）：

| # | 提交 | 内容 |
| --- | --- | --- |
| 1 | `chore: 引入 TypeScript 与 esbuild 构建` | src/ 迁移、build/verify、产物提交 |
| 2 | `refactor: 抽取 DSH 适配层` | host/client adapters、`shared/routes.ts`、`dsh boundary` 检查 |
| 3 | `feat: 加入项目模型与项目路由` | schema/migrate/store、`projectsRoot`/`exportDir`、`/projects` 路由 |
| 4 | `feat: 增加 video_selfcheck` | 5 项检查、`/selfcheck` 路由、`getOrigin()` |
| 5 | `docs: 更新 M1 验收记录` | README/INSTALL/COMPAT/HANDOFF/M1-PLAN、版本 0.1.0、启动自检报告 |

自动化验收已通过（`node scripts/verify.mjs`：类型、边界、构建、产物形态、产物一致、语法、158 项测试）。

### 2026-11-19 数据完整性修复（M1 之后、客户端重启验收之前）

v0.1.0 接入客户端时出现 DSH 客户端数据损坏（已由用户修复）。修复已落到代码，作为
客户端验收前的一部分；这些修复随后随 **`0.1.1`** 一起发版（0.1.0 未单独发布过带修复的构建）：

| 问题 | 修复 | 守护 |
| --- | --- | --- |
| 客户端 bundle 对同一 `id` 注册两次 | 构建脚本只注册一次并返回 `export default` 插件对象；删除 `client/adapters/loader.ts` | `verify` 产物形态 + `test/client-bundle.test.mjs` |
| `If-None-Match` 未先于 `Range` 评估 | 先判 `If-None-Match`，匹配即 304（RFC 7232 §6） | 304-over-Range / 304-over-416 用例 |
| Windows 设备名（`con`/`aux`/`com1`…）可被放行 | `paths.ts` 新增 `isReservedName`，媒体与项目资产校验共用 | 设备名用例（含 `com10`/`console` 反例） |
| 写 `project.json` 失败会留下空项目目录；`writeProject` 不建子目录 | 抽 `createProjectLayout` / `persistProject`，失败只清理本次新建的目录 | `writeProject` 布局与根目录守卫用例 |
| `install.mjs` 直写 profile `package.json`，可能被截断 | 临时文件 + `rename` 原子写；卸载也读回校验 | `test/install.test.mjs`（临时 `DSH_HOME`：`--check`/`--dry-run`/安装/卸载/路径逃逸） |

测试从 65 项增至 158 项（新增客户端 bundle 契约、安装脚本 `--check`/`--dry-run`/安装/卸载、
项目写入失败路径、manifest 元数据等用例）。

Host 半区已在**运行中的 Desktop** 上实测（改 profile 配置触发热重载，插件自动跑启动自检）：

- 5/5 全绿，报告 `$DSH_HOME/cache/dsh-video-workbench/selfcheck.json`：
  `routeMounted`（匿名 401 / 带 token 200）、`tokenRequired`、`mediaProbe`（206，
  `bytes 0-99/1548444`）、`projectsRootWritable`、`projectsRoute`（读取
  `20261119-003934/project.json` → 200）。
- 示例项目已建：`D:\Terry\Videos\dsh-video\video-projects\20261119-003934\`
  （`project.json` + `renders/v1.mp4` 样例），可直接用于播放验收。
- 复跑命令：`node scripts/check-selfcheck.mjs`（退出码 0 表示全绿）。

### M1 客户端验收结论（2026-11-19，完全重启后**全部通过**）

在 DSH Desktop `0.2.2-rc.5` 上完全退出并重新打开后逐项实测：

- 单个 ▶ 入口；`tokenPresent: true`、`ping.ok: true`、`media.status: 206`；
- 播放、拖动 seek、视频聚焦时 Esc 关闭、错误态"重试"；
- 亮/暗主题、侧栏展开/收起、窄窗口正常；
- 无重复浮层、DevTools 无 `slot entry crashed` —— **单次模块注册修复生效**。

Host 自检报告（完全重启后 16:32:16）：5/5，即 §6 上面那份 `selfcheck.json`。
**M1 至此全部完成**，剩余验收项清空；下一步是 M2（见 §7）。

⚠️ 环境现状（2026-11-19）：desktop profile 在修复数据损坏后重置过一次，现已重新装好——
插件已 link 安装并登记在 `dsh.profile.bundles` / `dependencies`；`cordis.patch.yml` 已补
`video-workbench` 配置（`projectsRoot` / `exportDir` / `selfcheckOnStartup`，备份
`cordis.patch.yml.bak-video-workbench-20261119-075340`）。

DSH Desktop 已从 `0.2.2-rc.3` 升级到 **`0.2.2-rc.5`**：升级后插件一度因 `engines.dsh`
精确匹配 `0.2.2-rc.3` 被 **拒绝激活**（`incompatible-version`，无路由、无 `selfcheck.json`）。
现已把 `engines.dsh` 改为 `0.2.2-rc.5`；升级指引核对过（`v0.2.2-rc.3` / `v0.2.2-rc.4`
两节都没有影响本插件的条目），并用 Inspect 在 rc.5 上核对了 `webServer.register` /
`getOrigin`、`webserver/index-inject`、`conversation.input.left`、`shell.overlay`。
首轮启动自检 4/5：`mediaProbe` 404——修复 profile 时
`$DSH_HOME/cache/dsh-video-workbench/media/` 目录丢了；已把示例项目的
`renders/v1.mp4` 复制回 `media/test.mp4`（1 548 444 字节）。之后完全重启，自检 5/5、
客户端验收全部通过。

也可以在页面 DevTools 控制台手动复跑：

```js
const t = window.__DSH_VIDEO_WORKBENCH__.token
const r = await fetch(`/api/video-workbench/selfcheck?t=${t}`).then((x) => x.json())
console.table(r.checks); r.ok
```

## 7. M2 完成记录与 M3 交接

**M2 渲染管线已完成（v0.2.0）**，执行细节与被推翻的假设见 [M2-PLAN.md](M2-PLAN.md)。

实机结果（2026-11-19）：

| 项 | 结果 |
| --- | --- |
| 运行时供给 | 从零安装 `hyperframes@0.6.33` + ffmpeg/ffprobe（约 840 MB），`supplied.json` 生成，两个二进制 `-version` 通过 |
| 渲染 | `node scripts/render-smoke.mjs` → **300/300 帧 · 10.000000s · 1080×1920**，约 13 秒（draft/2 workers） |
| 产物 | `renders/v1.mp4` + `renders/index.json`（时长/宽高/字节数）+ `exportDir` 副本（`<slug>-<标题>-v1.mp4`） |
| 取消/超时/孤儿 | 单元与集成用例覆盖（假 CLI + 真实进程树 kill）；启动时清理上次遗留的渲染进程 |
| 自检 | 8 项：路由/token/media/项目×2 + 运行时/浏览器/ffmpeg |

**剩余一步（需要人做）**：浮层 UI 的实机确认 —— 完全退出并重开 DSH，打开 ▶ 后应能看到
「安装运行时（已就绪）/ 选项目 / 渲染 / 取消 / 播放成片」，进度从 5% 走到 100%。截图补进 `docs/`。

M3 素材与配音开工前：读 [PLAN.md](../PLAN.md) 的 M3 一行 + [M0-FINDINGS.md](M0-FINDINGS.md)
的环境变量结论；合成脚手架在 `src/host/render/scaffold.ts`，M3/M4 会把它换成真正的 HyperFrames 模板
（agent 可整份重写 `<project>/index.html`）。

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

- **客户端 bundle 的双重注册已修复**（v0.1.0 事故）：现在只注册一次，`id` 由构建脚本从
  `package.json` 读取，源码只 `export default` 插件对象。改动这块时先看 §4 第 7 条；
  回归由 `verify` 的产物形态检查与 `test/client-bundle.test.mjs` 双重防线拦住。
- Desktop profile 的 `cordis.patch.yml` 配置是**应用运行期间**写进去的；如果应用退出时回写覆盖，
  需要按 §4 第 12 条重新加一次（内容见 [INSTALL.md](../INSTALL.md)「配置」）。
- `package.json` 的 `files` 不含 `src/` 与 `tsconfig.json`（`scripts`/`test`/`docs` 已包含）。link 安装无影响；
  若将来要发布 tgz 并允许他人重建，需要把源码一并纳入。
- `exportDir` 目前只有配置与日志，写入逻辑在 M2；工作区目录 `D:\Terry\Videos\dsh-video`
  还没在 DSH 里注册成工作区（可选，仅影响浏览体验）。
- **0.2.0（M2）浮层 UI 仍待实机确认**：`index.js` / `client.js` 都变了（渲染 UI、Range 语义、nosniff、
  客户端改用共享路由常量、面板标题去掉 M0），Host 侧行为已由 158 项测试覆盖；完全重启后
  请再跑一次 `node scripts/check-selfcheck.mjs` 并点开 ▶ 复看一遍。
- 未做的低优先项：`createProject` 并发同名竞态（`listProjects` 轮询时可能短暂看到半个项目）、
  项目 `project.json` 未知字段静默忽略（有意为之，保持向前兼容）、面板文案未接 Client locale。
