# DSH Plugin Collection

本仓库用于开发和维护 **DeepSeek Harness（DSH）插件 / bundle**。每个插件都是独立、可单独安装和卸载的 npm 包，同时面向 DSH Web 与 DSH Desktop。

## 插件列表

| 插件 | 目录 | 简单介绍 |
| --- | --- | --- |
| **dsh-peak-hours** | [`dsh-peak-hours`](dsh-peak-hours/README.md) | 在 DSH 侧边栏常驻显示 DeepSeek API 当前处于**波峰还是波谷计费时段**，附带当前计费（全价 / 5 折）、距下次切换的倒计时，以及点击展开的 24 小时时段详情。按北京时间判断，自动识别周末与中国法定节假日。 |
| **dsh-selection-actions** | [`dsh-selection-actions`](dsh-selection-actions/README.md) | 在会话正文中**自由选中一段文字**后，选区旁出现「复制 \| 添加到对话框」操作组；复制把文字写入剪贴板，添加则把文字插入当前对话框的光标/选区位置，保留缩进与换行，不会自动发送。 |
| **dsh-dev-commands** | [`dsh-dev-commands`](dsh-dev-commands/README.md) | 在会话输入框中通过 `/` 调起 **`/review`**（审查未提交改动）与 **`/ship`**（提交并推送全部本地未提交改动）两个开发流程命令；命令把任务交给当前 Agent，沿用 DSH 的工具权限、审批和 sandbox；Agent 正在执行任务时命令自动排队，不打断当前任务。 |
| **dsh-stock-images** | [`dsh-stock-images`](dsh-stock-images/README.md) | 给 Agent 三个配图工具：跨 Pexels / Pixabay / Unsplash / Openverse / Wikimedia Commons 搜图、把选中的图直接下载进会话工作区并记录署名与许可；API Key 在插件设置页填写并存入 DSH 凭据库。Openverse 与 Wikimedia Commons 免 Key 即可用，找真人肖像首选。 |

## 快速了解

- **dsh-peak-hours**  
  不改变 DSH 原有布局，只在侧边栏底部增加一个状态徽章；侧栏收起时自动退化为「峰 / 谷」小方块。详情面板包含今日时段轴、逐段时段表和节假日数据覆盖年份。

- **dsh-selection-actions**  
  通过 DSH 公开的 `inputActions.captureInsertion()` / `insertText()` 插入文字，不模拟输入事件、不读写文件；复制只走浏览器 Clipboard API（不支持时回退 `execCommand`），不经过 Host。主会话与侧边栏会话会按选区所属会话匹配各自的输入框。

- **dsh-stock-images**  
  Host 半区用 `ctx.tools.register()` 注册 `stock_image_search` / `stock_image_download` / `stock_image_sources`，密钥通过 `ctx.credentials` 读取（环境变量作为兜底）；下载只允许 HTTPS 公网地址并校验图片签名，写入限制在会话工作区内。Client 半区在 bundle 详情页的 `plugins.bundle.config` 里渲染 Key 配置卡片，经 `remote.credentials` 写入凭据库。

- **dsh-dev-commands**  
  Host 负责通过 `ctx.commands.register()` 注册斜杠命令，Client 给 `/review` / `/ship` 菜单行补齐中文标题、英文别名和图标；命令本身不执行 git，而是把一段普通用户消息交给 Agent，由 Agent 使用已有的 bash / git 工具完成审查或提交推送。消息通过 `agent.followup()` 进入下一轮队列：Agent 忙时排队等待，当前任务结束后再执行，不会用 `steer` 打断正在进行的任务。

## 安装

每个插件目录下都有独立的安装说明：

- [dsh-peak-hours 安装说明](dsh-peak-hours/INSTALL.md)
- [dsh-selection-actions 安装说明](dsh-selection-actions/INSTALL.md)
- [dsh-dev-commands 安装说明](dsh-dev-commands/INSTALL.md)
- [dsh-stock-images 安装说明](dsh-stock-images/INSTALL.md)

四个插件都提供 `scripts/install.mjs`，默认处理 `web` 与 `desktop` 两个 profile：

```sh
cd <插件目录>
node scripts/install.mjs              # 安装到 web + desktop
node scripts/install.mjs --check      # 只检查
node scripts/install.mjs --uninstall  # 卸载
```

安装或升级后通常需要**完全退出并重新打开 DSH**；仅刷新页面不保证重新加载 bundle / 插件模块。Desktop profile 由 Electron 独占管理，不要在应用运行时用 `dsh plugin --profile desktop` 写入。

## 仓库文档

- [AGENTS.md](AGENTS.md)：插件工程约束、双端适配、安装、测试与完成定义。
- [DESIGN.md](DESIGN.md)：插件 UI/UX 设计契约（主题、布局、交互、无障碍、双端验收）。

## 兼容性

- 目标运行时：DSH `0.2.1-rc.5`（Desktop 内置 Web GUI）；`dsh-stock-images` 实测并要求 `0.2.2-rc.5`。
- Node.js：`>=20`（安装脚本与测试需要；插件运行时不引入第三方依赖）。
- 主题：跟随 DSH 的 `--dsw-*` / `--dsw-alias-*` token，支持亮色、暗色和第三方主题。
- 平台：Web 与 Desktop 共用同一份客户端代码；Desktop 的顶部安全区、窄窗口和侧栏收起状态均已纳入布局处理。

## 开发与测试

各插件均为纯 JavaScript、无构建步骤；进入插件目录后运行：

```sh
node --test
node --check client.js
```

新增插件请遵循 [AGENTS.md](AGENTS.md) 的包结构、双端安装、locale、icon、测试和文档要求。
