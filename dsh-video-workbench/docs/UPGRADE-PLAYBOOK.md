# 升级操作手册（UPGRADE PLAYBOOK）

DSH 升级后，按本手册在 10 分钟内确认插件是否仍然健康，以及需要改哪里。

## 0. 前置记录

每次确认可用后，在 [COMPAT.md](COMPAT.md) 记录：

- DSH 版本：`D:\DeepSeekHarness\resources\app.asar\package.json` 的 `version`（或「设置 → 关于」）
- 插件版本：本仓库 `package.json` 的 `version`
- hyperframes 版本：`<runtime>/node_modules/hyperframes/package.json` 的 `version`
- Windows 版本、Node 版本（托管运行时）

## 1. 升级后先看插件是否还正常

本插件**自用、不对外分发**，`engines.dsh` 是无上限的 `>=0.2.2-rc.5`：
DSH 升级后插件**不会**被版本门禁停用，所以"还活着"不等于"还好用"。
升级后请立刻看启动自检（第 2 节第 1 步）——自检失败说明有 DSH 接口变了，先手动停用插件再排查。

> 0.1.0 曾经精确锁版本，DSH 从 rc.3 升到 rc.5 时插件被自动停用
> （插件管理器 `list_bundles` 里 `error.code: "incompatible-version"`）。
> 那种保护现在被有意放弃，换取"升级不再打断使用"。

## 2. 10 分钟自检清单

> 开始前先确认：**已完全退出并重开 DSH**。只刷新页面不够——token 只在应用启动时注入，
> 旧页面会一直显示"未获取到访问令牌"。

| # | 检查 | 通过标准 |
| --- | --- | --- |
| 1 | Host 路由已挂载 | 未带 token 请求 `ping`，返回**本插件自己的** `{"error":"unauthorized"}` |
| 2 | 带 token 的健康检查 | 浮层诊断 `ping.ok: true`、`tokenPresent: true` |
| 3 | Range | 浮层诊断 `media.status: 206`，`contentRange: bytes 0-99/<size>` |
| 4 | 客户端入口 | composer 左侧出现 ▶ 按钮，控制台无 `slot entry crashed` |
| 5 | 浮层交互 | 点击打开、Esc 关闭、焦点回到触发按钮 |
| 6 | 播放 | 视频能播；聚焦视频后按 Esc 仍能关闭 |
| 7 | 渲染（M2 起） | 跑一次 3 秒样例渲染，产物可播放 |
| 8 | 进程（M2 起） | 取消渲染后无 `chrome-headless-shell` 残留 |
| 9 | 单元测试 | `node --test` 全绿（当前 160 项） |
| 10 | 卸载 | 卸载后 DSH 正常启动、无 patch 行残留 |

### 第 1 项的命令

端口每次启动可能不同，不要写死；从启动日志或 `DSH_WEB_URL` 取。

```powershell
$base = $env:DSH_WEB_URL      # 例如 http://127.0.0.1:2788
curl.exe -s "$base/api/video-workbench/ping"
# 期望：{ "error": "unauthorized" }   ← 本插件的 401
# 若得到 404，或网关那种不同的 401，说明插件行没挂载
```

**2、3、6 项只能在页面里测**：token 由 Host 注入到页面，命令行拿不到，
所以 200 / 206 要看浮层里的诊断区，而不是用 curl。

## 3. 读升级指南

DSH 随安装包发布逐版本破坏性变更清单：

```text
$DSH_INSTALL_DIR/docs/upgrade-guide/README.md
```

流程：

1. 找到「从哪个版本升到哪个版本」，例如从 `0.2.2-rc.3` 升到 `0.2.3`，读 `v0.2.2-rc.3/` 目录下所有条目；
2. 只看**影响本插件用到的界面**的条目：Client slots、Web 路由、`host.call`、Desktop 外壳与窗口区域；
3. 每条 guide 有中英文版本与迁移步骤，通常是改名、新增必填字段、换声明方式，改动量 1 小时内。

## 4. 改哪里

DSH 耦合代码集中在两层适配器；升级时优先只改那一层（`verify` 的 `dsh boundary`
会拦住漏到业务代码里的直连）：

- `src/host/adapters/`：`webServer.register` / `getOrigin` 的调用形态、`webserver/index-inject`
  契约、路由注册与生命周期、logger
- `src/client/adapters/`：slot 注册、页面全局（token）与 baseURL 读取、样式注入

`src/client/index.tsx` 只 `export default` 插件对象；模块注册由 `scripts/build.mjs`
统一完成（单次注册，`id` 取自 `package.json`）。

如果改动扩散到业务代码，说明 adapters 层没拦住，需要重构后再继续。

## 5. `engines.dsh` 版本门禁

当前策略（2026-11-19 决定）：**本插件自用、不对外分发，范围不设上限**。

```json
"dsh": ">=0.2.2-rc.5"
```

- 下限 = 当时实测通过的版本；DSH 升级到任何更新的版本（含正式版与大版本）都会**继续激活**，
  不会因为 nightly 升版被停用。
- **代价**：DSH 的破坏性变更**不再自动拦住**插件，可能"半坏着跑"。
  **唯一的检测手段是启动自检**：升级后先 `node scripts/check-selfcheck.mjs`；
  不过就手动在插件管理器里停用，按第 2 节排查。
- 若某次升级自检不过：先停用插件 → 按第 2 节逐项排查 → 修好后把下限提到新版本，
  同步改 `test/manifest.test.mjs` 里的 `TESTED_DSH_RANGE` 与 [COMPAT.md](COMPAT.md)。

**判定语义（实测，别凭直觉）**：DSH 用
`semver.satisfies(runtime, range, { includePrerelease: true })` 判定
（`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`），
**预发布版本参与范围匹配**。`>=0.2.2-rc.5` 的实际效果：

| 放行 | 拒绝 |
| --- | --- |
| `0.2.2-rc.5` 及其后一切版本（`0.2.2`、`0.2.3-rc.*`、`0.2.3`、`0.3.x`、`1.0.0`…） | `< 0.2.2-rc.5`（含 `0.2.2-rc.3` / `rc.4`） |

改范围前用下面的脚本复核（用 DSH 自带的判定函数，不要装额外 semver）：

```powershell
# 用 DSH 运行时（Electron）执行，路径按当前安装调整
$env:ELECTRON_RUN_AS_NODE = '1'
& $env:DSH_NODE_EXECUTABLE -e "import('file:///D:/DSH/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js').then(m => console.log(m.evaluatePluginCompatibility({ name: 'dsh-video-workbench', version: '0.1.1', engines: { dsh: '>=0.2.2-rc.5' } }, {}, '0.2.2-rc.5')))"
```

> 历史：0.1.0 曾精确锁 `0.2.2-rc.3`，DSH 升到 rc.5 时插件被停用；0.1.1 先改为
> `>=0.2.2-rc.3 <0.2.3`（当时争取"升级自动停用"的检查点），随后按"不对外分发"的决定
> 改为无上限的 `>=0.2.2-rc.5`。

## 6. 回滚

- 停用：插件管理器关闭该插件（不改任何文件）。
- 彻底移除：`plugin_manager` 卸载，或删除 profile `package.json` 中 `dsh-video-workbench` 依赖与 `dsh.profile.bundles` 条目后重启 DSH。
- 数据不随插件删除：项目在 `projectsRoot`，缓存/运行时在 `$DSH_HOME/cache/dsh-video-workbench/`，需要手动清理。

## 7. 已知高风险面（升级时优先复查）

1. `shell.overlay` 与桌面窗口拖拽区域：macOS 需要 `data-window-drag-exclude`（Windows 不适用）。
2. `conversation.input.left` 的 slot 是否存在（改名会导致入口消失）。
3. 客户端 lazy-CJS 入口约定：每个 `id` **只能注册一次**，工厂返回插件对象；
   `scripts/build.mjs` 与 `test/client-bundle.test.mjs` 会校验。
   **不要**用 `/plugins/<id>/client.js` 判断客户端是否加载：
   该路径在客户端正常工作时也会 404，应看 slot 占用（`video-workbench-trigger`）或界面。
4. `webserver/index-inject` 的 `(table, peer)` 契约：token 注入依赖它，且必须只给 owner Peer。
5. Desktop 外壳对 `dsh-app://app/*` 的转发范围（插件路由与媒体播放依赖它）；
   外壳在应用启动时缓存 `injections`，因此 token 只在**完全重启**后更新，刷新页面不够。
6. 托管运行时的路径结构（`$DSH_HOME/dsh-runtimes/*/dependencies/node`）。
