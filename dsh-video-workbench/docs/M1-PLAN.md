# M1 执行计划：骨架与播放

> 状态：**步骤 1–5 已完成，M1 验收全部通过**（构建骨架、DSH 适配层、项目模型与项目路由、
> vvideo_selfcheckv、文档与版本 0.1.0，当前版本 0.1.2）；vverifyv 全绿，测试 161 项（2026-11-19
> 修复客户端 bundle 重复注册等数据完整性问题后从 65 增至 160）。
> 实机：DSH Desktop v0.2.2-rc.5v 完全重启后 Host 自检 5/5；客户端 ▶/token/206/播放拖动/
> Esc/重试、亮暗/侧栏/窄窗口、单次模块注册全部通过（2026-11-19，见第 10 节）。
> 本文替代 [PLAN.md](../PLAN.md) 里 M1 那一行，给出可以照着执行的步骤、目录、命令与验收标准。
> 范围：Windows + DSH Desktop；Web / macOS 不在 M1 验收范围。

## 0. 目标与不做的事

M1 结束时应当：

- 源码移到 vsrc/v，构建产物仍是**根目录** vindex.jsv / vclient.jsv，行为与 M0 一致、不回退；
- DSH 耦合代码收敛到 vhost/adapters/v 与 vclient/adapters/v，业务代码不再直接出现 vwebServerv / vslotsv / v__ModuleLoader__v；
- 有 vprojectsRootv 与 vproject.jsonv（schema v1），能创建 / 读取 / 校验项目；
- 项目文件可通过受 token 保护的路由播放；
- vvideo_selfcheckv 能报告：路由已挂载、token 生效、vprojectsRootv 可写；
- vpnpm verifyv 一条命令完成：类型检查 → 构建 → 产物一致性 → 语法检查 → 单元测试。

**不做**：渲染、Chrome/ffmpeg 供给、供应商 API、完整工作台 UI、结果卡（M2–M5）。

## 1. 起点（M0 现状）

| 项 | 现状 |
| --- | --- |
| Host | 单文件 vindex.jsv：token 媒体路由 + 路径校验 + index 注入 |
| Client | 单文件 vclient.jsv：▶ 入口 + vshell.overlayv 播放器 + 错误重试 |
| 构建 | **无**，手写 JS，vnode --checkv 校验 |
| 数据 | 只有媒体目录；无项目模型 |
| 测试 | 36 项：vrangev / vmediav / vguardv |
| 安装 | 应用内管理器 vlink:v；vscripts/install.mjsv 支持 v--check/--dry-run/--uninstall/--no-backupv |

## 2. 目标目录结构

vvvtext
dsh-video-workbench/
├── src/
│   ├── host/
│   │   ├── index.ts            # 组合入口：apply(ctx, config)
│   │   ├── adapters/
│   │   │   ├── web-server.ts   # register 路由、index-inject（含 owner 过滤）
│   │   │   └── logger.ts       # 可选日志封装
│   │   ├── media/
│   │   │   ├── handler.ts      # 从现 index.js 拆出的 Range/ETag 逻辑
│   │   │   └── token.ts        # token 生成、时序比较、读取
│   │   ├── projects/
│   │   │   ├── schema.ts       # project.json v1 类型与校验
│   │   │   ├── migrate.ts      # schemaVersion 迁移
│   │   │   └── store.ts        # create/read/write/list（原子写）
│   │   └── selfcheck.ts
│   ├── client/
│   │   ├── index.tsx           # __ModuleLoader__.load 的 factory 主体
│   │   ├── adapters/
│   │   │   ├── slots.ts        # slot 注册封装
│   │   │   └── context.ts      # token 全局读取、主题 token 名
│   │   └── components/
│   │       ├── Trigger.tsx
│   │       ├── Dialog.tsx      # 焦点陷阱 / Esc / 焦点归还
│   │       └── Player.tsx      # video + 错误态/重试
│   └── shared/
│       ├── dsh.ts              # 结构化类型（不 import @deepseek-ai/*）
│       ├── project.ts          # 前后端共用的 project 类型
│       └── routes.ts           # 路由常量
├── index.js / client.js        # 构建产物（提交）
├── scripts/build.mjs           # 构建
├── scripts/verify.mjs          # 类型 + 构建 + 一致性 + 语法 + 测试
├── tsconfig.json
├── package.json                # 增加 devDependencies 与 scripts
└── test/                       # 现有 36 项 + 新增
vvv

## 3. 构建方案

### 3.1 依赖（仅构建期，不随包发布）

| 依赖 | 用途 |
| --- | --- |
| vtypescriptv | vtsc --noEmitv 类型检查 |
| vesbuildv | 两个入口打包 |
| v@types/nodev | Host 侧 Node API 类型 |
| v@types/reactv | Client 侧 JSX 类型（运行时不打包 React） |

在插件目录单独安装：vpnpm installv（用 DSH 托管 pnpm）。vfilesv 保持只含产物，不发布 vsrc/v 与 vnode_modules/v。

**同时必须新增仓库根或插件目录的 v.gitignorev**（当前仓库没有），至少忽略 vnode_modules/v、v*.tsbuildinfov。否则 M1 第一次 vpnpm installv 就会把依赖带进提交。

### 3.2 tsconfig.json

vvvjson
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
vvv

v"jsx": "react"v 是 classic transform：产物里是 vReact.createElementv，不会出现 vreact/jsx-runtimev（模块表只提供 vreactv）。

### 3.3 scripts/build.mjs

Host 入口（ESM、Node 平台、外部化内置模块）：

vvvjs
await esbuild.build({
  entryPoints: ['src/host/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: ['node:*'],
  outfile: 'index.js',
})
vvv

Client 入口（CJS bundle → 包一层 v__ModuleLoader__v）：

vvvjs
const result = await esbuild.build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'chrome120',
  external: ['react'],
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  write: false,
})
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const wrapped = [
  "window.__ModuleLoader__.load({",
  v  id: ${JSON.stringify(manifest.name)},v,
  '  factory(require) {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  result.outputFiles[0].text,
  '    var exported = module.exports;',
  '    return exported && exported.__esModule && exported.default !== undefined',
  '      ? exported.default',
  '      : exported;',
  '  },',
  '});',
  '',
].join('\n')
vvv

要点：

- vidv 必须等于包名，由构建脚本从 vpackage.jsonv 读取（不要手写）；
- 包装器要在 bundle 之前定义 vmodulev / vexportsv，bundle 末尾的 vmodule.exports = …v 会写进它；
- vsrc/client/index.tsxv 只 vexport defaultv 插件对象，工厂返回这个 default
  （v0.1.0 曾因同一 id 注册两次导致客户端数据损坏，见 [M0-FINDINGS](M0-FINDINGS.md)）；
- vreactv 保持 external，由 vfactory(require)v 的 vrequirev 解析；
- 产物必须带一个可识别的构建标记（如首行注释），供 verify 与测试断言。

### 3.4 scripts/verify.mjs

vvvtext
tsc --noEmit
checkDshBoundary()                          # DSH 调用只出现在 adapters 与 shared/dsh.ts
node scripts/build.mjs
checkArtifactShape()                        # 构建标记 / classic JSX / 单次注册 / id 与包名 / ESM 可导入
git diff --exit-code HEAD -- index.js client.js   # 产物必须已提交（暂存不算）
node --check index.js client.js
node --test
vvv

（实际实现：边界检查与产物形态检查都内联在 vscripts/verify.mjsv，不单独出脚本；
「产物一致」对 vHEADv 校验，所以未提交产物时 verify 必然报错，属预期。）

vpackage.jsonv 增加：

vvvjson
"scripts": {
  "build": "node scripts/build.mjs",
  "typecheck": "tsc --noEmit",
  "verify": "node scripts/verify.mjs",
  "test": "node --test"
}
vvv

### 3.5 构建风险

| 风险 | 处理 |
| --- | --- |
| 产物与源码漂移 | vverifyv 的 vgit diff --exit-codev；产物必须提交 |
| 误用 automatic JSX runtime | 构建后断言产物不含 vjsx-runtimev（加一条测试） |
| 包装器作用域错误 | 构建后加载冒烟：slot 出现即通过 |
| devDeps 被安装进 profile | 不改 vdependenciesv；devDeps 只在插件目录 |

## 4. adapters 层

只包裹 **DSH 调用**，不抽业务逻辑。规则：vsrc/host/v 与 vsrc/client/v 的其它目录不允许出现 vwebServerv、vslotsv、v__ModuleLoader__v、vwindow.__DSH_VIDEO_WORKBENCH__v。

vvvts
// src/host/adapters/web-server.ts
export interface WebServerAdapter {
  registerRoute(route: { kind: 'exact' | 'prefix'; path: string; handler: (req, res) => void }): () => void
  onIndexInject(listener: (table: unknown[], peer?: { principal?: { kind?: string } }) => void): () => void
}
export function webServerAdapter(ctx: HostContext): WebServerAdapter | undefined
vvv

vvvts
// src/client/adapters/slots.ts
export function registerEntry(ctx: ClientContext, id: string, component: unknown): void
export function registerOverlay(ctx: ClientContext, id: string, component: unknown): void
vvv

vsrc/shared/dsh.tsv 只手写用到的结构类型（vinjectv、vwebServer.registerv、vslots.registerv、vlocalev），**不 import 任何 v@deepseek-ai/*v 包**——这是 M1 避免被 DSH 升级打断的关键。

## 5. 项目模型

### 5.1 project.json（schemaVersion 1）

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| vschemaVersionv | v1v | 固定 |
| vidv | string | v^[a-z0-9][a-z0-9-]{0,63}$v，与目录名一致 |
| vtitlev | string | 1–80 字符 |
| vaspectv | v'9:16' \| '16:9'v | 默认 v9:16v |
| vfpsv | number | 24 / 25 / 30 / 60 |
| vstylev | v{ theme: string; captionStyle: string }v | 字符串枚举，M1 只存储不渲染 |
| vscenesv | array | 1–50 项 |
| vscenes[].idv | string | v^s(0\|[1-9][0-9]{0,2})$v（vs0v–vs999v，无前导零），且**必须唯一**（0.1.2 起） |
| vscenes[].textv | string | 0–500 字符 |
| vscenes[].durationSecv | number | v> 0v，最多 3 位小数 |
| vscenes[].mediav | v{ kind: 'none'\|'image'\|'video'; asset?: string }v | vassetv 必须是项目内相对路径 |
| vscenes[].voicev | v{ asset?: string; speed: number }v | vspeedv 0.5–2 |
| vscenes[].captionsv | v{ enabled: boolean }v | — |

校验器手写（不引 ajv），返回 v{ ok: true, project }v 或 v{ ok: false, errors: string[] }v，错误信息要能直接展示给用户。

### 5.2 目录与根

vvvtext
<projectsRoot>/<slug>/
├── project.json
├── index.html   # M2 起使用
├── assets/
└── renders/
vvv

- **vprojectsRootv 必填，不提供 C 盘默认值**：未配置时插件仍挂载 M0 的媒体路由，但项目功能禁用，
  vvideo_selfcheckv 报 vprojectsRoot: unsetv。这样不会悄悄把项目写到系统盘。
- 推荐放在**专用 DSH 工作区**的子目录，例如把 vD:\Terry\Videos\dsh-videov 注册为工作区，
  项目根用 vD:\Terry\Videos\dsh-video\video-projectsv；**不要放进代码仓库**（素材与成片会污染 git）。
- 启动时若根不存在则创建；visFilesystemRootv 同样拒绝盘符根。
- slug 规则：**创建时间戳 vYYYYMMDD-HHmmssv**（冲突加 v-2v），目录名创建后不再变更；
  标题只存 vproject.json.titlev，UI 与导出文件名使用标题。
  理由：目录是内部 ID，改名会让 composition / asset 路径失效；中文标题不必进路径；
  可读性交给标题、UI 和导出文件名。

**三个根各管什么（最容易混淆）**

vprojectsRootv 是**所有项目的父目录**，不是成片目录；成片在 v<slug>/renders/v 里。

| 位置 | 内容 | 丢了会怎样 |
| --- | --- | --- |
| v<projectsRoot>/<slug>/project.jsonv | 分镜、文案、时长、样式——唯一可编辑真相 | 需要重写，agent 也失去上下文 |
| v<projectsRoot>/<slug>/index.htmlv | HyperFrames 合成，agent 可整份重写 | 可由 project.json 再生成，但手工改动会丢 |
| v<projectsRoot>/<slug>/assets/v | 图片 / 视频 / 配音 / 署名 | 重新下载或重新生成（费时、可能花钱） |
| v<projectsRoot>/<slug>/renders/v1.mp4v | 成片 | 可重渲染，**可以随时删** |
| v$DSH_HOME/cache/dsh-video-workbench/runtime/v | hyperframes、ffmpeg-static | 重新安装即可 |
| v$DSH_HOME/cache/dsh-video-workbench/{chrome,tts}/v | 浏览器、TTS 模型缓存 | 重新下载即可 |

备份策略：**备份 vproject.jsonv + vassets/v 就够**；vrenders/v 与 vcache/v 都可以再生成。

### 5.3 服务与路由

vprojects/store.tsv 提供 vcreatev / vreadv / vwritev / vlistv：

- vwritev 必须**原子写**：临时文件 + vrenamev；
- vreadv 先 vmigrate()v 再 vvalidate()v，失败返回结构化错误；
- 任何路径都经 vsafeResolvev（现有实现，最多 5 段）。

复用现有媒体 handler，再挂一个前缀：

vvvtext
/api/video-workbench/media     → 媒体根（M0 的 test.mp4）
/api/video-workbench/projects  → projectsRoot
vvv

两条路由共用同一个 token；v/projectsv 同样只读、支持 Range。

### 5.4 导出目录（exportDir）

- vConfig.exportDirv 可选；未配置时不导出，成片只留在项目的 vrenders/v 里。
- 推荐与 vprojectsRootv 同一专用工作区，例如 vD:\Terry\Videos\dsh-video\video-exportsv（同盘、同备份范围）。
- 渲染完成后复制成片：v${exportDir}\${slug}-${safeTitle}-${version}.mp4v；
  vsafeTitlev 去掉 Windows 保留字符、空白折叠、截断 40 字符，为空时退回 slug。
- **只写不读**：媒体路由不暴露 vexportDirv；导出失败只记日志，不回滚渲染结果。
- 不覆盖已有导出：同名时版本号递增。

## 6. 客户端改造

拆成 vTriggerv / vDialogv / vPlayerv 三个组件，行为保持 M0 已验收的状态：

- Dialog：varia-modalv、焦点陷阱、Esc（捕获阶段）、关闭后焦点归还；
- Player：v<video>v + 错误态 + "重试"，进入错误态前把焦点移回关闭按钮；
- token 从 vsrc/client/adapters/context.tsv 读取，业务组件不直接碰全局名。

## 7. video_selfcheck

M1 版本只做能在 Host 内完成、不需要渲染的检查：

| 检查 | 判定 |
| --- | --- |
| vrouteMountedv | 未带 token 请求 vpingv，返回本插件 401 JSON |
| vtokenRequiredv | 配置为 vrequireToken: truev（或显式 false） |
| vmediaProbev | 带 token 请求探测样本（默认 vtest.mp4v，可用 vselfcheckMediaPathv 改）的 0–99 字节，返回 206 |
| vprojectsRootWritablev | 在根下写入并删除一个临时文件；vprojectsRootv 未配置时标记 vskippedv |
| vprojectsRoutev | vprojects/<slug>/project.jsonv 可读；无项目或未配置时标记 vskippedv |

输出 v{ ok, checks: [{ name, ok, skipped?, detail }] }v；vskippedv 的检查 vok: truev，不影响
整份报告。渲染、浏览器与 ffmpeg 检查留到 [M2](M2-PLAN.md)（运行时真实性检查 + 手动样例渲染冒烟）。自检可被取消：插件卸载或 v/selfcheckv
调用方断开时，in-flight 探测会 vabortv（0.1.2 起）。

## 8. 测试计划

保留现有 36 项，新增至少 9 项（目标 ≥45）：

- schema 校验：合法 / 缺字段 / 越界 / 非法 slug；
- 迁移：vschemaVersionv 缺失或未知版本；
- 原子写：写入后读取一致，临时文件不残留；
- 项目路由：401 / 200+206 / 404 / 穿越 400；
- 构建产物：不含 vjsx-runtimev、带构建标记、vnode --checkv 通过；
- selfcheck：各检查项字段存在（用一个临时项目根）。

## 9. 实施步骤（建议按提交拆分）

| # | 提交 | 内容 | 完成标准 |
| --- | --- | --- | --- |
| 1 | vchore: 引入 TypeScript 与 esbuild 构建v | devDeps、tsconfig、build/verify、把 M0 代码原样移入 vsrc/v、提交产物、加 v.gitignorev | vpnpm verifyv 全绿；Desktop 重启后行为与 0.0.4 一致 |
| 2 | vrefactor: 抽取 DSH 适配层v | vhost/adaptersv、vclient/adaptersv、vshared/dsh.tsv | 36 项测试不变；业务目录无 DSH 调用 |
| 3 | vfeat: 加入项目模型与项目路由v | schema、migrate、store、v/projectsv 路由、测试 | 新建 → 列表 → 读取 → 播放全通 |
| 4 | vfeat: 增加 video_selfcheckv | 自检实现 + 测试 | 5 项检查全绿 |
| 5 | vdocs: 更新 M1 验收记录v | README / COMPAT / 截图 | 文档状态与实测一致 |

每一步都可单独回滚；第 1 步最容易出错，先只搬代码、不改行为。

## 10. 验收清单（M1 DoD）

自动化项已验证（vnode scripts/verify.mjsv）：

- [x] vpnpm verifyv 全绿（类型、DSH 边界、构建、产物形态、产物一致、语法、测试 161 项）
- [x] vnode --check index.js client.jsv 通过
- [x] 产物已提交，且与源码一致（verify 校验）
- [x] 仓库无 vnode_modulesv 提交

实机项（2026-11-19 在 DSH Desktop v0.2.2-rc.5v 上完全重启后全部通过）：

- [x] Host：启动自检 5/5（vrouteMountedv / vtokenRequiredv / vmediaProbev 206 /
      vprojectsRootWritablev / vprojectsRoutev 200）
- [x] Host：项目路由读取真实项目 v20261119-003934/project.jsonv → 200
- [x] 客户端：完全重启后 ▶ 打开、vtokenPresent: truev、vmedia.status: 206v、播放与拖动、
      Esc（视频聚焦）、错误态 + 重试
- [x] 客户端：只有一个 ▶、无重复浮层、无 vslot entry crashedv（单次模块注册修复生效）
- [x] 亮/暗主题、侧栏展开/收起、窄窗口快速过一遍（完整矩阵留 M6）
- [x] 把客户端结果补进 README / COMPAT / HANDOFF

## 11. 风险

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| 构建产物漂移 | DSH 加载旧代码 | verify 的 vgit diff --exit-codev + 提交产物 |
| classic JSX 配错 | 运行时找不到 vreact/jsx-runtimev | 构建测试断言产物不含该字符串 |
| CJS 包装器作用域 | 白屏 / slot 崩溃 | 第 1 步只搬代码，验收必须重启实机确认 |
| adapters 抽象过度 | 改动扩散、返工 | 只包 DSH 调用；M1 不追求"通用适配层" |
| 无 v.gitignorev | 误提交依赖 | 第 1 步补上 |
| 项目路径与 slug 策略反复 | 返工 | 先定 5.2 的默认根与 slug 规则 |

## 12. 估时（3 人日）

| 步骤 | 人日 |
| --- | --- |
| 构建骨架 + 迁移代码 + verify | 1.0 |
| adapters 抽取 | 0.5 |
| 项目模型 + 路由 + 测试 | 0.75 |
| selfcheck | 0.25 |
| 实机验收 + 文档 | 0.5 |

## 13. 已确认的决定

| 项 | 结论 |
| --- | --- |
| vprojectsRootv | **必填**，放专用 DSH 工作区的子目录（D 盘，不占 C 盘）；未配置时项目功能禁用 |
| vexportDirv | **增加**，可选；成片另存一份，媒体路由不暴露 |
| slug | **时间戳** vYYYYMMDD-HHmmssv，目录创建后不可变；标题存 vproject.jsonv |
| 运行时缓存 | 留在默认位置（v$DSH_HOME/cache/...v 与 v~/.cache/hyperframesv，约 1.8 GB）；M2 不迁移 |

开工前只需确认一件事：专用工作区的**具体路径**（建议 vD:\Terry\Videos\dsh-videov，项目根与导出目录都在它下面）。
