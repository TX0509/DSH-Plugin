# 升级操作手册（UPGRADE PLAYBOOK）

DSH 升级后，按本手册在 10 分钟内确认插件是否仍然健康，以及需要改哪里。

## 0. 前置记录

每次确认可用后，在 [COMPAT.md](COMPAT.md) 记录：

- DSH 版本：`D:\DeepSeekHarness\resources\app.asar\package.json` 的 `version`（或「设置 → 关于」）
- 插件版本：本仓库 `package.json` 的 `version`
- hyperframes 版本：`<runtime>/node_modules/hyperframes/package.json` 的 `version`
- Windows 版本、Node 版本（托管运行时）

## 1. 升级后先看它是否被自动停用

`package.json` 的 `engines.dsh` 当前是**精确版本**（例如 `0.2.2-rc.5`）。
DSH 升级后，版本不满足会导致插件**拒绝激活**——这是有意的：宁可停用，也不要半坏着跑。
插件管理器 `list_bundles` 里能看到 `error.code: "incompatible-version"` 与两侧版本号。

判断方法：插件管理器里该插件显示未启用/激活失败，或 composer 左侧入口消失。

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
| 9 | 单元测试 | `node --test` 全绿（当前 82 项） |
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

## 5. 放宽版本范围

1. 第 2 节各项全过；
2. 把 `engines.dsh` 从精确版本改成实测范围，例如 `>=0.2.2-rc.3 <0.3.0`；
3. 写入 [COMPAT.md](COMPAT.md)，并在 README 的兼容性矩阵更新；
4. 再跑一次 `node --test`。

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
