# dsh-dev-commands

在 DSH 会话输入框里通过 `/` 调起两个开发流程命令：

- **`/review`**：代码审查，默认审查当前工作区**未提交的改动**。
- **`/ship`**：提交并推送，默认把**全部本地未提交改动**提交并推送。

命令名必须是 DSH 支持的 ASCII 小写形式，所以实际输入是 `/review` 和 `/ship`；斜杠菜单里的说明使用中文。

## 使用

在任意有会话的输入框中输入 `/`，从菜单选择命令，或在输入框直接输入：

| 输入 | 行为 |
| --- | --- |
| `/review` | 审查当前工作区未提交的改动 |
| `/review 重点看并发和错误处理` | 同上，并把「重点看并发和错误处理」作为额外关注点 |
| `/ship` | 提交全部未提交改动并推送当前分支 |
| `/ship fix: handle empty diff` | 同上，并把这段文字作为提交说明的补充 |

`/review` 只读：要求 Agent 不修改文件、不提交、不推送。  
`/ship` 默认包含未跟踪文件（不包含被 `.gitignore` 忽略的文件），不 amend、不 rebase、不使用 `--no-verify`；如果发现明显的密钥、凭据、个人隐私数据或不应提交的大型生成物，Agent 会先停下来询问。

## 工作方式

插件由 Host 和 Client 两半组成：

1. **Host**：通过 `ctx.commands.register()` 注册两个全局斜杠命令。
2. **Client**：给斜杠菜单里 `/review` 和 `/ship` 两行补上线性图标；只装饰菜单候选行，不改变命令执行。
3. 命令处理器不直接执行 git，而是构造一条普通用户消息，通过 `agent.steer()` 交给当前会话的 Agent。
4. Agent 使用它已有的 bash / git 工具、权限策略和 sandbox 完成审查或提交。
5. 斜杠命令行和命令结果留在 UI 命令平面，不进入模型历史；只有生成的提示词作为普通用户消息进入会话。

因此：

- `/ship` 不会绕过 DSH 的工具审批、权限或 sandbox。
- 命令结果只是「已发起」的即时反馈，真正的提交哈希、推送结果会出现在 Agent 的回复里。
- 当前工作区不是 git 仓库、没有 upstream、或 Agent 没有可用 git 工具时，Agent 会在回复里说明原因。

## 安装

推荐用自带脚本安装到 `web` 与 `desktop` 两个 profile：

```sh
node scripts/install.mjs
node scripts/install.mjs --check
node scripts/install.mjs --uninstall
```

安装/升级后**完全退出并重新打开 DSH**。Desktop profile 由 Electron 独占管理，不要在应用运行时用 `dsh plugin --profile desktop` 写入。

- 仅 Web：`dsh plugin --profile web add link:<插件绝对路径>`
- 仅 Desktop：应用内插件管理，或完全退出应用后运行 `node scripts/install.mjs --profile desktop`
- 手动安装、`DSH_HOME`、移动目录后的重建、常见问题：见 [INSTALL.md](INSTALL.md)

## 兼容性

| 项目 | 说明 |
| --- | --- |
| DSH | `0.2.1-rc.5`（Desktop 内置运行时实测） |
| Node | `>=20` |
| 命令接口 | Host `ctx.commands`（DSH 0.2.x 的交互命令平面） |
| 客户端 | 依赖 Profile 中已启用的 `dsh-client-ui-commands` / 会话斜杠菜单；Client 半区只补菜单图标，Web 与 Desktop 共用 |
| 依赖 | 无第三方运行时依赖 |

## 验证状态

本次完成：

- `node --test`：15 个用例全部通过（Host 命令注册、两个提示词、参数透传、Agent 缺失/异常、重复命令、manifest / patch / locale / icon、安装脚本；Client 图标补全、图标尺寸、清理恢复）。
- `node --check index.js`、`node --check client.js`、`node --check scripts/install.mjs`。
- 安装到当前 Desktop profile 后，插件行已激活。

**未完成**：当前会话没有浏览器/页面控制能力，无法实际在输入框输入 `/`、从菜单选择并观察 Agent 执行，因此斜杠菜单的图标、视觉和端到端行为未验收。Client 图标补全是单元测试覆盖的；请在重启 DSH 后按上方「使用」表格手动确认。如果菜单里没有命令或图标，检查 DevTools 控制台是否有插件加载错误，并确认 `dsh-client-ui-commands` 已启用。

## 开发

```sh
node --test
node --check index.js
node --check scripts/install.mjs
```

- `index.js`：Host 命令注册、提示词构造、消息提交和错误处理。
- `client.js`：Client 半区，为 `/review` 和 `/ship` 菜单行附加图标。
- `cordis.patch.yml`：把 `dev-commands` 这一行插入 Host loader。
- `locale/*.json`：插件管理器中的标题/描述。
- `scripts/install.mjs`：双端安装 / 检查 / 卸载。
- `test/index.test.mjs`：不依赖真实 Agent 或浏览器的单元测试。

## 已知限制

- 命令名只支持 DSH 规定的小写 ASCII 名称，不能直接注册 `/代码审查` 或 `/提交并推送`；菜单说明使用中文。
- 图标补全通过包装 Client 的 `commandUi.candidates` 候选行实现，因为第三方 Host 命令没有官方 row-face 注册入口。DSH 若更换这个内部方法，图标可能不再显示，但命令本身仍可用；届时可移除 Client 半区，只保留 Host 命令。
- 如果其他插件已经注册了同名 `/review` 或 `/ship`，本插件会记录警告并跳过冲突的那个命令，另一个仍会注册。
- `/ship` 是「交给 Agent 执行」而不是 Host 直接执行 git；实际是否提交/推送取决于 Agent 的工具、权限和审批结果。
- 命令不会自动创建 Session；请在已有会话的输入框中使用。
- 这是一个面向现有工作流的快捷入口，不替代 review、测试或人工确认。

## 隐私

插件不发起网络请求、不读取文件、不写 `localStorage`、不收集遥测。命令生成的提示词会作为普通用户消息进入当前会话；git 操作完全由 Agent 在本机执行。

## 卸载

```sh
node scripts/install.mjs --uninstall
```

然后完全退出并重新打开 DSH。

## License

MIT
