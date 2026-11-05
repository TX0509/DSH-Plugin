# 安装与迁移

## 1. 安装前须知

- DSH 的 profile 位于 `$DSH_HOME/profiles/<profile>`，默认 `$DSH_HOME` 是 `~/.dsh`。
- **Web 与 Desktop 是两个独立 profile**：`web` 和 `desktop`。两端分别安装，配置不自动共享。
- Desktop profile 由 Electron 应用独占管理。`dsh plugin --profile desktop ...` 会被拒绝；请使用应用内插件管理，或**完全退出应用后**用本插件的安装脚本写入 profile。
- 安装 / 升级后通常需要**完全退出并重新打开 DSH**。仅刷新页面可能不会重新合成 bundle 列表。
- 本插件由旧的 `dsh-selection-to-composer` 重命名而来，包名与 patch id 都已改变。升级时先按第 9 节卸载旧包，避免两个 bundle 同时挂载。

## 2. 推荐方式：安装脚本

在插件目录执行：

```sh
node scripts/install.mjs                  # 安装到 web 和 desktop（已安装的跳过）
node scripts/install.mjs --check          # 只检查，不修改
node scripts/install.mjs --dry-run        # 只打印计划，不修改
node scripts/install.mjs --uninstall      # 从所有检测到的 profile 卸载
node scripts/install.mjs --profile web    # 只处理指定 profile（可重复）
node scripts/install.mjs --all            # 安装到检测到的全部 profile
node scripts/install.mjs --force          # 插件目录移动后，替换失效链接
```

脚本会：

1. 在 `<profile>/node_modules/dsh-selection-actions` 创建链接（Windows 使用 junction，macOS/Linux 使用 symlink）；
2. 备份 profile 的 `package.json`（`package.json.bak-dsh-selection-actions-*`）；
3. 写入 `dependencies["dsh-selection-actions"] = "link:<插件绝对路径>"`；
4. 把 `dsh-selection-actions` 追加到 `dsh.profile.bundles`；
5. 读回校验；失败会明确报错。

指定 `DSH_HOME`：

```sh
DSH_HOME=/path/to/dsh-home node scripts/install.mjs --profile web
```

## 3. Web profile：官方 CLI

如果 `dsh` 在 PATH 中：

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-selection-actions
```

`link:` 后面必须是**插件目录的绝对路径**。安装后完全重启 DSH。

## 4. Desktop profile

按优先级选择：

1. **应用内插件管理**：打开 DSH Desktop 的插件 / 扩展管理，从本地目录安装 `dsh-selection-actions`。
2. **安装脚本**：先完全退出 DSH Desktop（不是关窗口，是退出应用），再运行：

   ```sh
   node scripts/install.mjs --profile desktop
   ```

   重新打开应用。不要在应用运行时让它回写 profile，否则可能覆盖刚写入的 `package.json`。

## 5. 无 Node 的手动安装

> 手动修改前先备份 `<profile>/package.json`。

1. 把整个插件目录放到稳定位置，例如 `~/dsh-plugins/dsh-selection-actions`。
2. 在 `<profile>/node_modules/` 下创建指向该目录的链接：
   - macOS / Linux：`ln -sfn /absolute/path/to/dsh-selection-actions <profile>/node_modules/dsh-selection-actions`
   - Windows（管理员命令提示符）：`mklink /J "<profile>\node_modules\dsh-selection-actions" "C:\path\to\dsh-selection-actions"`
3. 编辑 `<profile>/package.json`：

   ```json
   {
     "dependencies": {
       "dsh-selection-actions": "link:/absolute/path/to/dsh-selection-actions"
     },
     "dsh": {
       "profile": {
         "bundles": ["dsh-selection-actions"]
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

如果只想确认某一个 profile，加 `--profile web`。

## 7. 移动插件目录后

旧的链接会失效。先完全退出 DSH，然后在插件新位置执行：

```sh
node scripts/install.mjs --force
```

`--force` 只替换指向本插件的失效 / 过期链接；遇到指向别处的链接会要求显式确认。

## 8. 卸载

```sh
node scripts/install.mjs --uninstall
```

或手动删除 `<profile>/node_modules/dsh-selection-actions`，并从 `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 中移除对应条目，最后完全重启 DSH。

## 9. 从旧包 `dsh-selection-to-composer` 迁移

包已改名为 `dsh-selection-actions`（新增复制功能）。旧包和新包是**两个不同的 bundle**，同时存在会出现两套浮动按钮，所以升级时按顺序执行：

1. 在**旧目录**（`dsh-selection-to-composer`）执行卸载，清掉旧链接和旧 bundle 条目：

   ```sh
   node scripts/install.mjs --uninstall
   ```

2. 在新目录（`dsh-selection-actions`）执行安装：

   ```sh
   node scripts/install.mjs
   ```

3. 完全退出并重新打开 DSH，再用 `--check` 确认新包在两个 profile 都是 `[ok]`。

如果旧目录已被删除、脚本无法运行，手动从每个 profile 的 `package.json` 中删除 `dsh-selection-to-composer` 的 `dependencies` 条目和 `dsh.profile.bundles` 条目，并删除 `<profile>/node_modules/dsh-selection-to-composer` 链接。

## 10. 常见问题

**安装后按钮不出现？**

- 确认已**完全退出并重开** DSH。
- 运行 `node scripts/install.mjs --check`，确认目标 profile 是 `[ok]`。
- 打开 DevTools / 桌面端开发者工具，查看是否有 `slot entry crashed`、`Failed to load module` 或 `require('react')` 相关错误。
- 确认当前页面是**会话正文**；在输入框、设置页或空会话里选中文字不会出现按钮。

**点「复制」没有反应 / 提示「复制失败」？**

- 非安全上下文（例如自定义 scheme）下 `navigator.clipboard` 可能不可用，插件会自动回退到 `document.execCommand('copy')`。
- 如果两端都失败，检查是否有其他扩展 / 策略阻止了剪贴板写入；页面失焦时复制也可能被拒绝。

**Desktop 上 `dsh plugin --profile desktop` 报错？**

这是预期行为。Desktop profile 由应用独占管理，请用应用内插件管理或安装脚本（应用完全退出后）。

**Web 装好了，Desktop 没有？**

两端 profile 独立。分别执行 `--profile web` 和 `--profile desktop`（或应用内安装）。

**`--check` 失败但文件看起来都在？**

检查 `dsh.profile.bundles` 是否包含 `dsh-selection-actions`，以及 `dependencies` 的值是否严格等于 `link:<当前插件绝对路径>`。路径变了要用 `--force` 重建。

**Windows 上链接失败？**

在开发者模式或管理员命令提示符下使用 junction；脚本已自动选择 `junction` 类型。路径含空格时加引号。

**升级后仍是旧行为？**

完全退出 DSH 再打开；浏览器刷新不足以重新加载插件模块。如果使用 `link:` 安装，确认链接指向的是新目录。
