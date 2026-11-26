# dsh-multichannel-story

给 DeepSeek Harness（Desktop 与 Web 同一个 bundle）装上 `multichannel-story` 技能：**一篇文章 → 精排网页长文 + 小红书图文 + 公众号封面，可选再加一条带自然男声旁白的抖音竖屏视频**。

它做两件事：

1. **技能**：把仓库里那份 skill（`SKILL.md` + `references/` + `scripts/`）作为 **bundled skill provider** 注册进 `ctx.skills`。装上以后每个会话的技能目录里都有它，输入框里打 `/multichannel-story` 就能直接调用，不用再手动拷到 `~/.agents/skills/`。
2. **侧栏入口（可选）**：左侧边栏的全局面板区多一个「多平台内容」入口，点开是插件自己的页面（产物说明 + 「开始做一条内容」一键新开会话并填好 `/multichannel-story` 草稿 + 入口开关）。不想要这个入口就关掉，技能照常可用。

## 界面：工作台与可选入口

界面走宿主自己的面板语言（语义 token、宿主字体、衬线标题、克制动效），结构上按**行动优先**组织：

- **入口**：左侧边栏全局面板区多一个「多平台内容」（图标 + 名称，排在 歸藏设计 之后）。
- **工作台**（主区域）：顶部是品牌 + 两个页签
  - **开始**：标题与一句话说明 → **三档产物预设**（网页 + 卡片 + 封面 / 网页 + 卡片 + 封面 + 视频 / 只要网页长文，各带「默认 / 含视频 / 最快」标签与差异说明）→ 一句「点下去会发生什么」→ 主按钮「开始：<档位>」→ 成功后一行状态提示 → 折叠的「查看将写入草稿的提示词」→ 三条开跑前检查 → 折叠的「这条内容会怎么走（4 步）」；
  - **设置**：侧栏入口开关与偏好说明。
- **一键开始**：主按钮新开会话，把 `/multichannel-story …` 写进输入框；**已有草稿时追加**而不是覆盖，也不会自动发送。打开期间按钮禁用并显示「正在打开…」，避免连点开两个会话；失败时 `role="alert"` + 「重试」，成功时给一行「已写入草稿」。
- **可访问性**：页签是 `role="tablist"/"tab"` + `aria-selected` + 方向键 / Home / End；预设是 `role="radiogroup"/"radio"` + roving tabindex，读屏名只读标题、说明走 `aria-describedby`；开关 `role="switch"` + `aria-checked`，用可见文字做名字并关联说明；所有实例内 id 都带 `useId` 前缀，主面板与右侧栏标签页同时挂载也不会撞 id；主要控件（页签、主按钮、折叠行）高度 36–44px，开关视觉 44×24 但命中区撑到 44 高。
- **视觉约定**：所有颜色走 `--dsw-alias-*` 别名层（带 `color-mix` + 宿主 token 兜底），圆角用 `--dsw-radius-*`、阴影用 `--dsw-elevation-soft`；支持亮/暗主题、窄窗口（≤720px 预设单列、页签整行、主按钮满宽）、`prefers-reduced-motion` 关动效；中文行宽按 34em 收，避免一行排过长。布局按**容器宽度**（`@container`）而不是视口切换：主区 ≥1000px 时开始页转两栏（左：档位与开始；右：检查项与流程），右侧栏标签页那种窄容器自动退回单列。
- **开关两处**：工作台里的开关；或 **设置 → 插件 → 多平台内容流水线 → 配置** 里的同一个开关（入口关掉后仍能重新打开）。关掉时如果正停在工作台，会自动回到会话面板，不会把人困在无入口的页面里。
- 开关是**纯 UI 偏好**（一个布尔值，存在浏览器 `localStorage`，不含任何个人信息）。本版 DSH 客户端没有 settings 服务、Host 配置也不会热下发给已打开页面，所以放在客户端；卸载插件后这条键不再被读取。
- **文案**：中英双语文案叶子交给宿主 `locale` 服务按回退链解析（不支持中文/英文的界面回退英文，不会显示中文）；服务缺失时才用本地兜底。
- 入口隐藏不影响技能：`/multichannel-story` 与技能目录里那一条始终可用。
- 若本机装了 `dsh-better-sidebar`，同一套工作台还会在右侧栏注册一个同名标签页（没装则自动跳过）。

## 安装

DSH 里用插件管理器装（推荐，Desktop / Web 各自的 profile 各装一次）：

```
plugin_manager(action="install_bundle", target="<本插件目录的绝对路径>")
```

或者用仓库自带的双端安装脚本（默认处理 `web` 与 `desktop` 两个 profile）：

```sh
cd <本插件目录>
node scripts/install.mjs              # 安装到 web + desktop（没有则退回全部检测到的 profile）
node scripts/install.mjs --check      # 只检查，不改文件
node scripts/install.mjs --dry-run    # 只打印计划
node scripts/install.mjs --uninstall  # 卸载
```

- **安装或升级后请完全退出并重新打开 DSH**；Desktop 仅刷新页面不会重建 bundle 列表与客户端模块。
- 装完看 **设置 → 插件** 里有没有「多平台内容流水线」这一行（图标 + 说明 + 详情图）。
- 新会话立即可见；已打开的会话会在下一次请求时收到更新后的技能目录。
- 注意：DSH 的 **Web 与 Desktop 是两个独立 profile**。本机已分别装好（Desktop 用插件管理器，Web 用 `scripts/install.mjs`）；换机时两端都要装一次。
- 详细步骤、`DSH_HOME`、目录移动后重建链接、排障见 [INSTALL.md](INSTALL.md)。

## 兼容性与验证状态

| 项 | 值 |
| --- | --- |
| `engines.dsh` | `>=0.2.2-rc.1 <0.3.0`（两个 profile 的运行版本都在范围内） |
| Desktop profile | DSH `0.2.2-rc.5`（本机 v24.19.0 Node）：**已安装并运行验证**（技能 + 客户端半区） |
| Web profile | DSH `0.2.2-rc.1`：**已安装**，`dsh --profile web --dump-config` 确认 bundle 行已插入、不再被 engines 拦截；rc.1 的 `@deepseek-ai/dsh-skill` 提供相同的 `registerProvider`/校验/rank 语义，`dsh-client-ui-sidebar` 与 `dsh-client-ui-plugin-manager` 也提供 `sidebar.panellist` 与 `plugins.bundle.config` 两个 slot；**运行时加载要等该 profile 的 DSH 重启后确认** |
| Node | `>= 20`（插件运行时无第三方依赖） |
| 平台 | Windows 11 实测；脚本层 `scripts/*.mjs` 与客户端半区无平台绑定，macOS 未实测 |

已验证：技能出现在会话技能目录并经 `skill` 工具加载；停用 → 技能消失/入口消失、启用 → 恢复；`node --test`（含客户端两个视图与 slot 注册、better-sidebar 标签页注册与注销、页签/预设焦点、忙碌与失败路径、双实例 id、安装脚本、CLI 冒烟与 `--out`/`check` 失败路径、同步安全、Python 脚本的 `--force` 与缺旁白路径、静态检查负例）、`node --check`、`node scripts/check-package.cjs .` 全部通过；技能自检 `preflight --page --cards` 通过；web profile 的 bundle 组合包含本插件；客户端模块由 Host 正常下发（见下方"验证方式"）。
未验证：侧栏入口、面板与配置卡片在亮/暗主题、窄侧栏下的**实际渲染**（本环境无浏览器控制）；web profile 的运行时加载（需重启该 profile 的 DSH）。

验证方式（不依赖截图）：客户端模块按 DSH 的 `window.__ModuleLoader__.load` 契约由 `test/client.test.mjs` 在假 window/React/slots 下加载并断言三个 slot 的注册与开关行为；Host 侧用 `scripts/check-package.cjs .` 校验 `dsh.client`、`./client` 导出与主题 token 约束。**已打开的页面需要刷新（Desktop 需重启）才会加载新的客户端模块**——未刷新时技能照常可用，只是侧栏暂无入口。

## 它不改什么

这是刻意设计的最小侵入：

| 可能影响宿主的东西 | 本插件 |
| --- | --- |
| 覆盖 / 替换内置插件行 | 没有，只有一条 `insert` |
| 覆盖 / 替换宿主 UI 组件 | 没有；只往既有 slot 里追加自己的入口、面板与配置卡片 |
| 新增工具（占系统提示词） | 没有 |
| 改系统提示词 / 注入上下文 | 没有 |
| 监听事件（`agent/*`、`tools/*`） | 没有 |
| 客户端 UI | 一个侧栏入口 + 一个主面板 + 插件详情页的一张配置卡片；用主题 token，随插件卸载自动注销 |
| 写工作区或 profile 文件 | 没有（唯一的持久化是浏览器里一个 UI 偏好布尔值） |

Host 半区唯一的行为是注册一个只读 skill provider：`list()` 返回一个缓存的候选，`get()` 返回缓存的正文，不读盘、不联网。

如实说明两件事：

- 每个会话的技能目录会多出 `multichannel-story` 这一条（大约一行目录文本），这就是它的全部 prompt 成本；停用插件后这条会消失。
- 插件以 `link:` 形式装在**它被安装的那个目录**，不要挪动或删除该目录：挪走后 profile 里的 bundle 引用会悬空，技能会直接加载失败（插件不会破坏其它行，重新指向或卸载即可）。

## 技能内容

插件里的 `assets/multichannel-story/` 是 skill 的副本：

- `SKILL.md`：流程与硬性约束（先自检 → 选工作流 → 网页 → 卡片/封面 → 视频 → 验收）
- `references/`：setup、page、cards、video、voice、copy-and-images、guizang-workflows、checklist
- `scripts/`：`mcs.mjs`（跨平台 CLI：`preflight` / `page` / `cards` / `brand` / `check` / `verify`）、`page-post.mjs`（网页后处理，纯函数、单独可测）、它的 POSIX 薄壳 `*.sh`、`tts.py`、`scaffold-video.py`、`list-recipes.mjs`
- `MANIFEST.json`：副本逐文件 sha256，用来发现"手改副本"或"同步遗漏"

Windows（DSH Desktop）上直接 `node <base>/scripts/mcs.mjs preflight --page --cards`，不要用 `bash`——那里的 `bash` 常常是 WSL。
`mcs check <工程目录>` 会用 OpenMotion 的 `install.json` 找到 hyperframes CLI 做视频工程校验，不用记死路径。

注意：手动安装路线用的 `scripts/install.sh` 不进插件包。装了插件后再跑它，会往 `~/.agents/skills` 拷一份 rank 500 的副本，优先级高于插件的 600，插件更新就不生效了。

## 依赖（技能会自己检查）

| 产物 | 必需 |
| --- | --- |
| 网页长文 | `dsh-guizang-design` 插件、node |
| 小红书 / 公众号封面 | `dsh-guizang-design` 插件、可用的 playwright chromium |
| 抖音视频 | OpenMotion（MCP + 本机 Studio）、ffmpeg/ffprobe、python `edge-tts` |
| 抓真实网页/推文截图 | `ego-browser` |
| 免费图库配图 | `dsh-stock-images` |

缺依赖时技能会报缺并停下，不会用静音成片或纯文字卡片凑数。

## 与手工安装的 skill 共存

同名 `~/.agents/skills/multichannel-story` 存在时，**用户目录那份优先**（插件用 bundled 优先级 600，用户级是 500）。
也就是说插件不会顶掉你自己改过的副本；想只保留插件版本，把用户目录那份删掉即可。

## 开发

```bash
node scripts/sync-assets.mjs              # 从同级 ../multichannel-story 同步 skill 副本 + 重建 MANIFEST.json
node scripts/sync-assets.mjs <源目录>      # 或指到别的 skill 目录（也可用 MCS_SKILL_SRC）
node --test                               # 单元测试：frontmatter、provider、安装脚本、CLI 冒烟与失败路径、同步安全、检查脚本负例、Python 脚本
node --check index.js
node scripts/check-package.cjs .          # 交付前静态检查（清单/图标/详情/副本哈希/个人路径/files 存在性）
```

同步是"先校验源、复制到临时目录、再整体替换"：源不完整或源/目标重叠时会直接失败，现有副本保持不变。

改了 skill 之后：先 `sync-assets`（否则 `node --test` 会因为 MANIFEST 哈希不一致而失败），再重启 DSH 或重新安装 bundle 让新的 `SKILL.md` 生效。

## 卸载

```
plugin_manager(action="set_bundle", target="dsh-multichannel-story", enabled=false)   # 立即停用，技能消失
plugin_manager(action="remove_bundle", target="dsh-multichannel-story")               # 彻底移除
# 或
node scripts/install.mjs --uninstall
```

## 已知限制

- 技能正文以配置的方式交给模型，插件本身不执行任何渲染：卡片/视频的实际依赖与失败模式见 `references/setup.md`。
- 插件不写日志文件、不落盘、不缓存工作区状态（只在宿主缺少 skill provider API 时输出一条警告）；所有产物由技能脚本写进用户自己的项目目录。
- 技能里的脚本会在用户机器上起 `node` / `python` / `ffmpeg` 子进程，按 DSH 的审批与沙箱策略执行。
- 图标与详情图的实际观感（尤其暗色主题）尚未目视验证，见上文验证状态。

MIT License。
