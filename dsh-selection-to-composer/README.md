# dsh-selection-to-composer

在 DeepSeek Harness 的会话里**自由选中一段文字**，旁边会出现一个小胶囊按钮；点击它，选中的文字就会插入当前对话框的光标位置。全程不会自动发送消息。

## 功能

- **选中即出现**：在会话正文（用户消息、助手回复、代码块、工具输出）中选中任意文字，选区末端附近出现「添加到对话框」。
- **插入而非发送**：点击后按对话框当前光标/选区插入纯文本，保留选中内容的缩进与换行（仅去掉选区两端的空行）；不会清空已有草稿，也不会自动发送。
- **可继续编辑**：插入后对话框获得普通的一次撤销记录，可以继续修改或撤销。
- **状态反馈**：成功时显示「已添加到对话框」；对话框正在发送、裁决或不可编辑时显示「对话框正忙，稍后再试」。
- **不打扰**：按 `Escape`、滚动页面或点击空白处会收起胶囊；重新选择文字会把它移到新选区旁。不做自动聚焦、不弹窗、不播放持续动画。
- **双端一致**：Web 与 Desktop 共用同一份 `client.js`；浮动层注册在 `shell.overlay`，不依赖桌面专属能力。
- **主题跟随**：只使用 `--dsw-alias-*` / `--dsw-*` token，亮色、暗色和第三方主题自动适配。

## 使用

1. 打开任意有消息的会话。
2. 用鼠标拖选、双击选词，或按住 `Shift` 用键盘选择会话里的文字。
3. 选区旁出现 **添加到对话框**，点击即可。
4. 如果对话框当前正在发送消息，按钮会提示「对话框正忙，稍后再试」，等发送结束后重新选择即可。

只会对**会话正文**生效：在输入框、搜索框、侧边栏或设置页里选中文字不会出现按钮。侧边栏同时打开另一个会话时，插件会把文字加到**选区所属会话**的对话框，而不是另一栏的对话框。

## 实现方式

| 部分 | 位置 | 作用 |
| --- | --- | --- |
| 浮动按钮 | `shell.overlay`（root scope） | 监听选区、在视口内定位并渲染胶囊；浮动层本身点击穿透，只有胶囊接收指针事件 |
| 插入桥 | `conversation.input.overlay`（session scope） | 接收 shell 公开的 `inputActions`，调用 `captureInsertion()` / `insertText(text, span)` |
| 会话归属 | `[data-conversation-session]` | 桥按自己的会话根注册；选区按最近的会话根匹配，避免插错对话框 |

不读取其他插件的 DOM，也不模拟输入事件；插入走 DSH 的公开 `InputActions` 接口。

## 安装

插件是标准的 DSH cordis bundle。当前仓库的推荐流程：

```sh
# 同时安装到 web 与 desktop（已安装的会跳过）
node scripts/install.mjs

# 只检查，不修改
node scripts/install.mjs --check

# 卸载
node scripts/install.mjs --uninstall
```

**安装后必须完全退出并重新打开 DSH**；仅刷新页面不足以重新合成 bundle 列表。桌面端尤其需要退出应用再打开。

- Web profile（`dsh plugin` 可用）：`dsh plugin --profile web add link:<插件绝对路径>`
- Desktop profile（Electron 独占管理）：使用应用内插件管理，或**完全退出应用后**运行安装脚本；不要对 desktop profile 使用 `dsh plugin --profile desktop`。
- 本仓库当前已把插件安装到 `desktop` 与 `web` 两个 profile；换机、手动安装、`DSH_HOME`、移动目录后的重建步骤见 [INSTALL.md](INSTALL.md)。

## 兼容性

| 项目 | 实测 / 说明 |
| --- | --- |
| DSH | `0.2.1-rc.5`（Desktop 内置运行时） |
| Node | `>=20`（仅安装脚本与测试需要；插件运行时零依赖） |
| 平台 | macOS Desktop 已安装并确认两个 slot 注册为 active；Web profile 已安装，但本次未启动 Web 端做交互验证 |
| 主题 | 亮色 / 暗色 / 跟随系统（token 跟随） |
| 依赖 | 无运行时第三方依赖，不重复打包 React |

## 验证状态

本次完成：

- `node --test`：20 个用例全部通过（选区文本清洗、定位与边界翻转、桥接插入与会话归属、locale / manifest / patch / icon、安装脚本 `--check` 与 `--dry-run`）。
- `node --check index.js`、`node --check client.js`、`node --check scripts/install.mjs`。
- 在当前 Desktop profile 安装后，`shell.overlay` 出现 `selection-to-composer`，`conversation.input.overlay` 出现 `selection-to-composer-bridge`，两者均为 `active: true`。
- `node scripts/install.mjs --check` 显示 `desktop` 与 `web` 均已安装。

**未完成**：当前会话没有浏览器 / 页面控制能力，无法实际拖选文字并点击胶囊做端到端视觉验收，也没有生成真实运行截图。因此本 README 不包含截图，不能把“slot 已注册”等同于“视觉与交互已验收”。请在重启 DSH 后按上方「使用」步骤手动确认；如果按钮未出现，先检查 DevTools 控制台是否有 `slot entry crashed` 或 `require('react')` 相关错误。

### 手动验收清单

重启 DSH 后建议依次确认：

1. 在助手回复中拖选一段文字，选区旁出现「添加到对话框」。
2. 点击后文字出现在对话框光标处；`Cmd/Ctrl+Z` 可以撤销这一次插入。
3. 在代码块中选中多行，插入后缩进与换行保持；选区两端的空行被去掉。
4. 切到暗色主题，胶囊背景、文字、边框仍清晰可读。
5. 缩窄窗口或打开右侧面板，胶囊不被侧边栏 / 窗口边缘裁切。
6. 同时打开侧边栏会话，分别在主会话和侧边栏选中文字，文字进入各自那一栏的对话框。
7. 按 `Escape`、滚动页面、点击空白处，胶囊收起。
8. 在对话框正在发送时选中文字并点击，显示「对话框正忙，稍后再试」，且不会改动草稿。
9. 停用插件后刷新 / 重启，页面上不再有胶囊和残留样式。

## 开发

纯 JavaScript，无构建步骤：

```sh
node --test
node --check index.js
node --check client.js
```

- `client.js`：浮动胶囊、选区监听、定位、会话桥与 locale 字典。
- `index.js`：Host 半区占位；不注册服务、不发系统提示。
- `locale/*.json`：插件管理器里的标题与描述（`zh` / `en`）。
- `icon.svg`：插件图标。
- `scripts/install.mjs`：双端安装 / 检查 / 卸载；Windows 使用 junction，macOS/Linux 使用 symlink。

## 已知限制

- 依赖 DSH 会话 DOM 的公开结构标记 `[data-conversation-session]`、`[data-conversation-region]` 和 `[data-chat-flow]`。如果未来版本改了这些标记，浮动按钮可能不出现；插件本身不会报错或白屏。
- 依赖 `conversation.input.overlay` 传入的公开 `inputActions`（`captureInsertion` / `insertText`）。如果接口变更，按钮会显示「对话框正忙，稍后再试」而不是破坏对话框。
- 一次只能插入一段连续选区；多段选区请分次选择。
- 选区特别大时按原样插入，不截断；如果对话框本身不可编辑或正在提交，插入会失败并提示。

## 隐私

插件不发起网络请求、不读取文件、不写 `localStorage`、不收集遥测，也不保存选中的文字。所有处理都发生在当前页面的内存里。

## 卸载

```sh
node scripts/install.mjs --uninstall
```

然后完全退出并重新打开 DSH。卸载会移除 profile 中的链接、`dependencies` 条目和 `dsh.profile.bundles` 条目。

## License

MIT
