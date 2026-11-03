# AGENTS.md

本文件面向在本仓库工作的 AI 与人类开发者，约定 **DeepSeek Harness（DSH）插件** 的开发方式。

UI/UX 的视觉与交互决策见 [DESIGN.md](DESIGN.md)：本文负责工程约束与双端技术适配，`DESIGN.md` 负责界面设计契约。

## 1. 仓库定位

- 本仓库**只用于开发和维护 DSH 插件 / bundle**，不是 DSH 本体。不要在这里修改 DSH 的安装目录、`app.asar`、Electron 外壳或官方包源码。
- 每个插件必须是**独立、自包含、可单独安装和卸载**的 npm 包；插件之间不要互相 `import` 源码，也不要依赖本仓库根目录的私有工具。
- 现有插件是 `dsh-peak-hours-1.0.0/dsh-peak-hours/`，可作为纯 JavaScript、无构建插件的参考实现。
- 注意：现有 `dsh-peak-hours` 尚未补齐本文要求的 `locale/`、`icon`、`engines.dsh` 等元数据；新插件按本文标准执行，不要把它当成完整合规模板。补齐现有插件也属于允许的改进范围。
- 新增插件优先使用 `<plugin-name>/` 作为包根；现有发布目录结构 `<name>-<version>/<name>/` 保持不变，除非用户明确要求统一迁移。
- 不提交 `node_modules`、构建缓存、`.DS_Store`、profile 备份（如 `package.json.bak-*`）、个人绝对路径、密钥或 token。

## 2. 最高优先级：同时适配 DSH Web 与 DSH Desktop

**每个插件都必须把 DSH Web 和 DSH Desktop 当作一等公民。只在一端验证通过，不算完成。**

### 2.1 两端是什么关系

- Desktop 不是另一套前端。官方 Electron 外壳加载的仍是同一套 Web GUI 和同一份插件 `client.js`；`dsh.client.platform` 仍然写 `"web"`，不要发明 `"desktop"` 平台，也不要维护两份客户端代码。
- 两端的差异主要在**外壳、加载方式、宿主能力和 profile 管理**，不在 React / Slot / 主题体系。
- Desktop 可能通过自定义 scheme（例如 `dsh-app://app/`）加载页面，也可能由外壳通过 `fetchBundle()` 分派与 Web 完全相同的 bundle。不要假设页面一定运行在 `http://` 下。

### 2.2 必须处理的差异

| 维度 | Web | Desktop | 对插件的要求 |
| --- | --- | --- | --- |
| 页面来源 | `http://` / `https://`，可能带反向代理前缀 | 可能是 `dsh-app://` 等自定义 scheme | 不要硬编码 `location.origin`、`location.host` 或 `ws://`；见 2.3 |
| 宿主能力 | 浏览器 + Web Host | 额外可能有原生目录选择、open-in-app、文档预览、内嵌浏览器/终端、窗口控制等 | 桌面专属能力必须**能力探测**；Web 上缺失时隐藏入口或降级，不能抛错、白屏或留下死按钮 |
| 窗口 chrome | 普通浏览器标签页 | macOS 红绿灯 / hiddenInset、Windows 标题栏、无边框拖拽区 | 不要占用或覆盖窗口 chrome；贴顶内容使用框架发布的 clearance 变量；交互控件避开拖拽区 |
| 快捷键 | 保留浏览器缩放快捷键 | 可能接管 `Cmd/Ctrl` + `+` / `-` 等 | 不要拦截全局快捷键；需要快捷键时使用 DSH 的 shortcuts 能力并避让宿主 |
| profile | `$DSH_HOME/profiles/web` | `$DSH_HOME/profiles/desktop`，由 Electron 独占管理 | 安装、升级、卸载必须分别覆盖两个 profile；不要假设两端共享配置或数据 |
| 安装方式 | `dsh plugin --profile web add ...` 可用 | npm CLI 会拒绝 `--profile desktop` 的插件管理；应使用应用内插件管理、Desktop 内置命令或受支持的链接方式 | 安装文档和脚本必须给出桌面端可行路径，不能只写 Web 命令就宣称双端支持 |
| 运行时 | 可独立启动的 Node + 浏览器 | 打包后的 Electron + 内置 runtime；renderer 无 Node 权限 | 客户端半区只能用浏览器 API；文件系统、进程、网络等能力放到 Host 半区 |
| 验证 | 浏览器刷新即可（视 HMR 而定） | 通常需要**完全退出并重新打开应用**，仅刷新页面不够 | 文档中明确写出重启要求 |

### 2.3 地址、传输与桌面环境

- 访问 Host 的普通 HTTP 路由时，优先使用文档自身的 base（`document.baseURI`），它能保留反向代理目录前缀；不要从 `location.origin` 拼绝对地址。
- 建立 WebSocket / 流式连接时，如果存在 `globalThis.__DSH_TRANSPORT__?.streamBaseUrl`，优先使用它；它才是 Desktop 外壳公布的真实 Host 地址。直接拿 `location.host` 拼 `ws://` 在 `dsh-app://app/` 下会得到无法解析的 `ws://app/...`。
- 不要用 User-Agent 猜测“是不是桌面端”。需要区分时，读取明确的环境标记或能力接口：
  - `html[data-platform='darwin']`：仅由 macOS 桌面 preload 设置。
  - `html[data-windows-titlebar]`：Windows 桌面标题栏相关。
  - `--dsh-frame-top-clearance`、`--dsh-frame-leading-clearance`、`--dsh-frame-overlay-top`、`--dsh-frame-chrome-top`、`--dsh-windows-menu-start`：框架发布的窗口 chrome 几何变量，普通浏览器通常不发布或为 0。
- 桌面窗口的拖拽区会吞掉指针事件。位于顶栏或 `data-window-drag` 区域的交互控件必须显式 `-webkit-app-region: no-drag`，或移到非拖拽区。
- 桌面端可能存在刘海、红绿灯、Windows 标题栏等安全区。固定定位的弹层要预留边距，不能假设 `top: 0` 就是可用区域。

### 2.4 硬性编码规则

1. **不假设 origin / scheme / 端口**：所有 Host 请求都通过相对路径、`document.baseURI` 或 DSH 提供的 transport 解析。
2. **不假设桌面能力一定存在**：可选服务写进 `inject` 或用 `ctx.inject([...], ...)`，缺失时插件保持不激活或降级，而不是启动失败。
3. **不写死颜色**：容器和控件只使用 `--dsw-alias-*` 等主题 token；亮色、暗色和第三方主题都要能跟随。字面色只允许出现在插件自己的图标/插画中。
4. **不假设布局尺寸**：侧边栏会折叠成窄栏、窗口会变窄、桌面端有标题栏；组件必须在展开/收起、宽/窄、有无 chrome 的情况下都可用。
5. **不依赖桌面专属路径**：插件代码里不要写 `~/.dsh/profiles/desktop` 之类的路径；profile 路径由安装脚本或 Host 服务解析。
6. **不把 Web 上不存在的入口画出来**：例如“在文件管理器中显示”“用本机应用打开”等按钮，在 Web 上必须隐藏或禁用并说明原因。
7. **两端都要验证**：至少完成 Web 的亮/暗主题、展开/收起侧栏、窄窗口，以及 Desktop 的实际安装与重启验证。无法验证 Desktop 时，必须在交付说明中明确标注“未验证”，不能默认它可用。

### 2.5 安装与 profile

- DSH 的 profile 位于 `$DSH_HOME/profiles/<name>`，默认 `$DSH_HOME` 是 `~/.dsh`。
- 插件安装的本质是两件事：把包放进 profile 的 `node_modules`，并把包名加入该 profile `package.json` 的 `dsh.profile.bundles`。
- **Web 和 Desktop 是两个独立 profile**。安装脚本默认应同时处理 `web` 和 `desktop`；只装一个 profile 时必须显式说明。
- Desktop profile 由 Electron 应用独占管理，`dsh plugin --profile desktop ...` 会被拒绝。桌面端应使用：
  - DSH Desktop 的应用内插件管理；或
  - Desktop 自带的命令运行时；或
  - 在**完全退出应用**后，用受支持的链接/安装脚本写入 profile（避免应用退出时回写覆盖）。
- 修改 profile 的 `package.json` 前先备份；写入后读回校验；安装脚本应支持 `--check`、`--uninstall`、`--dry-run`，并在 Windows 上使用 junction、macOS/Linux 上使用 symlink。
- 安装/升级后通常需要**完全重启 DSH**。仅刷新浏览器可能不会重新合成 bundle 列表；Desktop 必须退出应用再打开。

## 3. 插件的最小形态

一个标准 bundle 至少包含：

```text
<plugin-name>/
├── package.json          # 声明 dsh.bundle.patch / dsh.client
├── cordis.patch.yml      # 向 loader 插入插件行
├── index.js              # Host 半区（可为空实现）
├── client.js             # 浏览器半区（可选，但 UI 插件必须有）
├── locale/zh.json        # 插件管理器中显示的标题/描述
├── locale/en.json
├── icon.svg              # 插件图标
├── README.md
├── INSTALL.md            # 安装/迁移/排障（可选但推荐）
├── scripts/install.mjs   # 双端安装脚本（可选但推荐）
├── docs/                 # 截图等
└── test/                 # node:test 用例
```

`package.json` 的关键字段：

```json
{
  "name": "dsh-example",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "files": [
    "index.js",
    "client.js",
    "cordis.patch.yml",
    "locale/*.json",
    "icon.svg",
    "README.md",
    "LICENSE"
  ],
  "engines": {
    "node": ">=20",
    "dsh": ">=0.2.1-rc.1"
  },
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  }
}
```

- `engines.dsh` 写你**实际测试过**的 SemVer 范围；不要不写，也不要把范围写得比实测更宽。
- `dsh.client.platform` 统一写 `"web"`；`immediately`、`inject`、`external` 按实际需要添加。
- `files` 必须覆盖所有运行时文件。通过 `link:` 安装时 npm 不会用 `files` 过滤目录，但仍要保证发布 tgz 时不缺文件。
- `window.__ModuleLoader__.load({ id })` 的 `id` 必须与包名一致；patch 行 `id` 只需在 loader 中全局唯一，可以与包名不同（现有插件的 `id: peak-hours` 对应包名 `dsh-peak-hours`）。两者都不能与其他插件冲突。

`cordis.patch.yml` 最小内容：

```yaml
- insert:
    - id: example
      name: dsh-example
```

需要覆盖已有行或按条件禁用时，使用 Loader 的 YAML 语法（包括 `!!js`），但必须确认目标行确实存在，并避免重复挂载。

## 4. 客户端（浏览器半区）规则

- 入口必须是 DSH 的 lazy-CJS 形态：

  ```js
  window.__ModuleLoader__.load({
    id: 'dsh-example',
    factory(require) {
      const React = require('react')
      return {
        inject: ['slots'],
        apply(ctx) {
          // 在这里注册 slot、样式、监听器
        },
      }
    },
  })
  ```

- `factory` 本身不要产生副作用；真正的注册、定时器、事件监听、样式注入放在 `apply` 中，并用 `ctx.effect` / `ctx.on` 返回清理函数。插件被停用或 HMR 替换后不能留下计时器和 DOM。
- React 从模块表 `require('react')` 获取；**不要重复打包 React**，不要引入第二份 ReactDOM，也不要从 CDN 加载。
- 不要 `require('@deepseek-ai/dsh-client-ui-primitives')` 或其他 DSH 内部 Client 包；这些接口会变，且普通 JS 插件没有类型检查。需要控件时，用自己的实现 + 主题 token 模仿宿主样式，或复制有许可的控件实现并重命名 CSS class。
- UI 应通过 slot 渲染：
  - 用 `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))` 注册，选择**已经分配空间**的 slot；不要自己往 `document.body` 追加根节点，也不要替换应用根节点。
  - 先用当前 DSH 的 slot 查询确认 slot 名称、props 和 options；不要凭记忆写 slot 名。
  - 插件被折叠、slot 消失或插件卸载时，注册项应自动清理。
- 不要用 iframe 承载插件页面。iframe 拿不到宿主主题 token、亮暗切换和 `ctx.locale`，会与宿主界面脱节；用 React 组件渲染在 slot 中。
- 需要访问 Host 时，使用 DSH 提供的服务或受支持的 Host 路由；不要在客户端直接读文件、起进程或绕过权限。
- 所有用户可见文案尽量走 Client locale 服务；至少提供中文和英文。插件管理器里的 `meta.title` / `meta.description` 必须有实际含义，不能留模板文案。
- 主题：只使用 `--dsw-alias-*` / `--dsw-*` token；需要状态色时使用 `--dsw-alias-state-*`。不要写死 `#fff`、`#000` 或固定 rgba 背景。
- 响应式：侧边栏收起为窄栏时，文字徽章要退化为图标/缩写；弹层最大宽度用 `calc(100vw - ...)`，避免超出窗口。

## 5. Host 半区规则

- `index.js` 推荐导出 `apply(ctx, config)` 和可选的 `inject`、`Config`；不要混用 service class 默认导出和函数导出。
- 没有 Host 行为时，保持空 `apply()` 即可，不要为了“看起来完整”而注册不必要的服务。
- 可选依赖写进 `inject` 或 `ctx.inject([...], ...)`，缺少服务时插件应保持不激活，而不是让整个 profile 启动失败。
- 所有资源（服务、路由、监听器、定时器）在 `apply` 内注册并返回清理函数；不要依赖进程退出自动清理。
- 涉及会话数据时，优先使用 DSH 的 session projection / storage 服务，不要自己订阅全量 `session/event` 再重扫。不要向 session 追加自定义 `type` 的事件，除非你确认了格式兼容性。
- 用户可调参数放进 `Config` schema，让用户在 profile 的 `cordis.patch.yml` 中覆盖；不要把配置写死在代码里。
- 如果插件同时提供 UI 操作和 Agent 工具，**同一个操作只实现一份 Host 服务方法**，UI 和 tool 都调用它，不要维护两套逻辑。

## 6. 配置、状态与数据

- Web 与 Desktop 的 profile 是分开的。不要假设插件在 Web 端保存的设置会自动出现在 Desktop；需要跨端共享时，明确设计同步方式并处理冲突。
- 用户配置优先放在 profile 的 patch 层或 DSH settings 命名空间，不要写到插件包目录（升级/替换包会丢）。
- 不要用 `localStorage` 保存敏感信息或长期配置；优先使用 DSH 的 settings / credentials 服务。
- 插件产生的缓存、日志、临时文件要放在 DSH 提供的目录或系统临时目录，并在卸载时清理；不要污染用户 workspace。
- 时间、时区、locale 相关逻辑要显式处理，不要依赖运行机器的本地时区（现有 `dsh-peak-hours` 固定使用 `Asia/Shanghai`，可作为参考）。

## 7. 安全与隐私

- 永远不要信任客户端传来的路径、URL、命令或参数。Host 侧必须校验：路径必须落在允许的 workspace 内，URL 只允许允许的 scheme，命令参数必须转义或改用服务 API。
- 不要把任意文件读写、shell 执行、端口监听暴露成无鉴权的路由。使用 DSH 的 workspace / remote / connection 服务，并遵循其权限模型。
- 插件默认不应收集遥测或上传用户数据；如果需要网络请求，必须在 README 中说明请求目标、频率和用途，并尊重离线/无网环境。
- 不要在仓库、日志、错误信息中输出 API key、token、cookie、完整用户路径或会话内容。
- 引入第三方依赖前先确认许可证和体积；能零依赖实现就不要引入依赖，尤其是不要引入会在客户端重复打包 React 的库。

## 8. 测试与验证

### 8.1 自动化

每个插件至少提供：

```sh
node --test          # 单元测试
node --check index.js
node --check client.js
```

- 测试要覆盖边界条件、时区换算、日期/节假日数据、格式化、空数据、异常输入。
- 测试必须确定性：不要依赖当前真实时间、网络、用户目录或机器时区；需要“现在”时注入固定时间。
- 如果插件有安装脚本，至少测试 `--check` 和 `--dry-run`（不写真实 profile）。
- 如果引入构建（TypeScript/JSX/打包），必须提供可复现的 `build`，并提交/产出 DSH 实际加载的构建后 `client.js`；DSH 运行时不会替你编译 TSX。

### 8.2 手工验收矩阵

| 场景 | Web | Desktop |
| --- | --- | --- |
| 安装后重启，插件出现在插件列表 | 必须 | 必须 |
| 主功能可见、可交互 | 必须 | 必须 |
| 亮色 / 暗色主题 | 必须 | 必须 |
| 侧边栏展开 / 收起 | 必须 | 必须 |
| 窄窗口 / 小屏 | 必须 | 必须 |
| 桌面专属能力缺失时降级 | 在 Web 上验证降级 | 不适用（能力存在） |
| 停用 / 卸载后无残留 | 必须 | 必须 |
| 控制台无 `slot entry crashed` 等错误 | 必须 | 必须 |

- 验证时打开 DevTools / 桌面端开发者工具，确认没有 slot 崩溃、未捕获 Promise、React 警告和重复挂载。
- UI 改动后更新 `docs/` 中的截图；截图必须来自真实运行，不要用 mock 页面冒充验证。
- 无法实际验证 Desktop 时，在最终交付说明中写清楚：验证了什么、没验证什么、原因是什么。**不要因为“代码应该兼容”就宣称双端通过。**

## 9. 文档要求

每个插件至少提供：

- `README.md`：功能、截图、判定/行为规则、**Web 与 Desktop 各自的安装方式**、兼容版本、开发与测试命令、卸载方式、已知限制。
- `INSTALL.md`（推荐）：换机/迁移、无 Node 的手动安装、`DSH_HOME`、路径移动后重建链接、常见问题。
- 兼容性矩阵：写清楚实测过的 DSH 版本、Node 版本、操作系统；Desktop 的 macOS/Windows 差异要单独说明。
- UI/UX 必须符合 [DESIGN.md](DESIGN.md)：主题 token、响应式、桌面安全区、组件状态、无障碍和双端视觉验收都要对齐。
- 如果插件依赖外部数据（节假日、价格、API），写清楚数据来源、更新周期和过期后的降级行为。

文档默认使用中文；代码标识符、注释可以使用英文。对外发布时再补英文 README。

## 10. 工作方式

- 开始修改前先读相关插件目录的 `README.md`、`package.json`、`cordis.patch.yml`、`index.js`、`client.js`，不要凭印象改 API。
- 如果当前会话能加载 DSH 自带的 `cordis-plugin-development` skill，或能使用 `cordis_inspect_query` / `Slots` / `Theme` 查询，先查真实签名再写代码。
- 优先做**最小可用版本**：先让插件在一端真实运行，再补双端差异、主题、窄栏和文档；不要先写大量未验证的抽象。
- 不要在没有用户要求时自动 `git commit` / `git push`，不要改写 git 历史。
- 不要为了“让测试通过”而删除测试、放宽断言或把真实失败吞掉；失败要暴露并解释。
- 修改插件包名、目录、patch id、slot 或安装方式时，同步更新 README、INSTALL、安装脚本和测试。

## 11. 完成定义（Definition of Done）

一个插件任务只有同时满足以下条件才算完成：

- [ ] `package.json` 有 `dsh.bundle.patch`、`dsh.client`（如有 UI）、`engines.dsh`，且 `files` 覆盖所有运行时文件。
- [ ] `cordis.patch.yml` 能正确插入插件行，id 全局唯一，不重复挂载。
- [ ] Host 半区可空实现；所有注册都有清理逻辑。
- [ ] 客户端通过 `window.__ModuleLoader__.load` 注册，无重复 React，无内部 Client 包依赖。
- [ ] UI 只使用主题 token，亮/暗、宽/窄、侧栏展开/收起都可用。
- [ ] UI/UX 符合 [DESIGN.md](DESIGN.md)：桌面安全区、弹层边界、键盘焦点、双端视觉验收通过。
- [ ] Web 上桌面专属能力正确降级，不出现死按钮或报错。
- [ ] `node --test`、`node --check` 通过。
- [ ] 已在 Web 和 Desktop 实际安装并重启验证；无法验证的部分已明确标注。
- [ ] 停用/卸载后无残留定时器、DOM、路由或文件。
- [ ] README/INSTALL 包含双端安装、兼容性、测试和卸载说明；UI 截图已更新。

## 12. 常见错误清单

- ❌ 只测 Web，就认为 Desktop 也能用。
- ❌ 用 `location.origin` / `location.host` 拼 WebSocket 或 Host 路由。
- ❌ 在 `dsh-app://` 页面里假设 `http://` / `https://`。
- ❌ 把 `dsh.client.platform` 写成 `"desktop"`，或维护两套客户端代码。
- ❌ 用 `dsh plugin --profile desktop` 安装桌面端插件。
- ❌ 只刷新页面就宣称 Desktop 升级完成（需要完全退出并重开）。
- ❌ 固定 `top: 0` / 固定窗口尺寸，忽略 macOS 红绿灯、Windows 标题栏和窄栏。
- ❌ 写死颜色，导致暗色主题下不可读。
- ❌ 在 Web 上显示“在文件管理器中打开”等桌面专属按钮。
- ❌ `factory` 里启动定时器、监听器或写 DOM，卸载后不清理。
- ❌ `require('@deepseek-ai/dsh-client-ui-primitives')` 或重复打包 React。
- ❌ 为了插件方便，在 Host 侧开放任意路径读写或 shell 执行。
- ❌ 把个人 profile 路径、`package.json.bak-*`、密钥提交进仓库。
