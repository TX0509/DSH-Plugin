# 安装与迁移

## 1. 安装前须知

- DSH 的 profile 位于 `$DSH_HOME/profiles/<profile>`，默认 `$DSH_HOME` 是 `~/.dsh`。
- **Web 与 Desktop 是两个独立 profile**：`web` 和 `desktop`。两端分别安装。
- Desktop profile 由 Electron 应用独占管理。`dsh plugin --profile desktop ...` 会被拒绝；请使用应用内插件管理，或**完全退出应用后**用本插件的安装脚本写入 profile。
- 安装/升级后通常需要**完全退出并重新打开 DSH**。仅刷新页面不保证 Host 插件行重新加载。

## 2. 推荐方式：安装脚本

```sh
node scripts/install.mjs                  # 安装到 web + desktop（已安装的跳过）
node scripts/install.mjs --check          # 只检查
node scripts/install.mjs --dry-run        # 只打印计划
node scripts/install.mjs --uninstall      # 从所有检测到的 profile 卸载
node scripts/install.mjs --profile web    # 只处理指定 profile（可重复）
node scripts/install.mjs --all            # 安装到检测到的全部 profile
node scripts/install.mjs --force          # 插件目录移动后重建失效链接
```

脚本会：

1. 在 `<profile>/node_modules/dsh-dev-commands` 创建链接（Windows 用 junction，macOS/Linux 用 symlink）；
2. 备份 profile 的 `package.json`（`package.json.bak-dev-commands-*`）；
3. 写入 `dependencies["dsh-dev-commands"] = "link:<插件绝对路径>"`；
4. 把 `dsh-dev-commands` 追加到 `dsh.profile.bundles`；
5. 读回校验，失败会明确报错。

指定 `DSH_HOME`：

```sh
DSH_HOME=/path/to/dsh-home node scripts/install.mjs --profile web
```

## 3. Web profile：官方 CLI

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-dev-commands
```

`link:` 后面必须是插件目录的绝对路径。安装后完全重启 DSH。

## 4. Desktop profile

按优先级选择：

1. **应用内插件管理**：从本地目录安装 `dsh-dev-commands`。
2. **安装脚本**：完全退出 DSH Desktop 后运行：

   ```sh
   node scripts/install.mjs --profile desktop
   ```

   重新打开应用。不要在应用运行时让它回写 profile。

## 5. 无 Node 的手动安装

> 手动修改前先备份 `<profile>/package.json`。

1. 把整个插件目录放到稳定位置，例如 `~/dsh-plugins/dsh-dev-commands`。
2. 在 `<profile>/node_modules/` 下创建链接：
   - macOS / Linux：`ln -sfn /absolute/path/to/dsh-dev-commands <profile>/node_modules/dsh-dev-commands`
   - Windows（管理员命令提示符）：`mklink /J "<profile>\node_modules\dsh-dev-commands" "C:\path\to\dsh-dev-commands"`
3. 编辑 `<profile>/package.json`，在原有内容上补充：

   ```json
   {
     "dependencies": {
       "dsh-dev-commands": "link:/absolute/path/to/dsh-dev-commands"
     },
     "dsh": {
       "profile": {
         "bundles": ["dsh-dev-commands"]
       }
     }
   }
   ```

   保留文件里原有的其他字段和 bundle；不要覆盖整个 `dsh.profile`。
4. 完全退出并重新打开 DSH。

## 6. 验证安装

```sh
node scripts/install.mjs --check
```

预期：

```text
[ok] desktop: 已安装
[ok] web: 已安装
```

然后在任意会话输入 `/`，菜单中应出现带图标的：

- `代码审查 review` — `审查当前工作区未提交的改动`
- `提交并推送 ship` — `提交全部本地未提交改动并推送`

如果菜单里没有，先确认已完全重启，并检查 `dsh-client-ui-commands` 是否启用。

## 7. 移动插件目录后

旧的链接会失效。完全退出 DSH 后，在插件新位置执行：

```sh
node scripts/install.mjs --force
```

## 8. 卸载

```sh
node scripts/install.mjs --uninstall
```

或手动删除 `<profile>/node_modules/dsh-dev-commands`，并从 `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 中移除对应条目，最后完全重启 DSH。

## 9. 常见问题

**输入 `/` 看不到这两个命令？**

- 确认已完全退出并重开 DSH。
- 运行 `node scripts/install.mjs --check`，确认目标 profile 为 `[ok]`。
- 检查 DevTools 控制台是否有 Host 插件加载错误（例如 `commands` 服务缺失）。
- 确认当前输入框属于一个已有会话；没有会话时没有可接收命令的 Agent。
- 如果 `/review` 或 `/ship` 已被其他插件占用，本插件会记录警告并跳过冲突的那个。

**`/ship` 没有真正提交？**

命令只是把任务交给 Agent。是否提交取决于 Agent 是否拥有 git/bash 工具、当前权限/审批策略，以及仓库状态。看 Agent 的回复确认提交哈希和推送结果。

**Desktop 上 `dsh plugin --profile desktop` 报错？**

这是预期行为。Desktop profile 由应用独占管理，请用应用内插件管理或安装脚本（应用完全退出后）。

**升级后仍是旧行为？**

完全退出 DSH 再打开；仅刷新页面不足以重新加载 Host 插件行。
