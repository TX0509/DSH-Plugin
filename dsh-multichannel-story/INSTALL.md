# 安装说明（dsh-multichannel-story）

Host 半区只向 `ctx.skills` 注册一个技能；客户端半区提供**可选的**侧栏入口与工作台面板（入口在设置里关掉后，插件行为退化成纯 host-only）。Desktop 与 Web 的安装方式相同，只是**装在不同的 profile 里**。

支持 **macOS 与 Windows**（Linux 未验证）。两端用的是同一份 `client.js` 与同一套 Node 脚本；下面的命令在两边都能跑，差异只有：Windows 用 junction 代替 symlink、不要用 `bash` 跑技能脚本、文本按 LF 检入。

## 1. 前提

- DSH `0.2.2-rc.5`（或满足 `engines.dsh` 的版本），Node `>= 20`。
- 本插件目录保持在本机固定位置（安装方式是 `link:`，挪走会让 profile 里的引用悬空）。

## 2. 安装到 Desktop 与 Web

推荐用 DSH 应用内的插件管理（两端都有）：

```
plugin_manager(action="install_bundle", target="<本插件目录的绝对路径>")
```

`plugin_manager` 会把包放进目标 profile 的 `node_modules`、把包名写进 `dsh.profile.bundles`，并立即激活。

或者用本仓库的双端安装脚本（不需要 pnpm，也不依赖 `plugin_manager`）：

```sh
cd <本插件目录>
node scripts/install.mjs              # 默认处理 web 与 desktop 两个 profile
node scripts/install.mjs --profile web
node scripts/install.mjs --check      # 只检查，不改文件
node scripts/install.mjs --dry-run    # 只打印计划
```

脚本行为：

- 在 `$DSH_HOME/profiles/<name>/node_modules` 建目录链接（Windows 用 junction，macOS/Linux 用 symlink），并在 profile `package.json` 里登记 `dependencies` 的 `link:` 依赖与 `dsh.profile.bundles`。
- 只处理链接：已存在的是**真实目录**（复制式安装）时拒绝删除或替换，并说明手动处理方式；不会为了装上链接而删用户文件。
- 修改 profile `package.json` 前先备份为 `package.json.bak-multichannel-story-<时间戳>`；写入后读回校验，校验失败会报错而不是假装成功。
- 插件目录被移动过时，用 `--force` 重建失效链接（`--force` 不会删除真实目录）。

**安装或升级后请完全退出并重新打开 DSH。** Desktop 只刷新页面不会重建 bundle；Web 端通常刷新即可，但重启更稳。

## 2.1 按平台安装

**macOS**

```sh
cd <本插件目录>
node scripts/install.mjs --check      # 先看当前状态
node scripts/install.mjs              # web + desktop
# Desktop 装完请完全退出（⌘Q）再重新打开
```

**Windows（PowerShell 或 cmd）**

```powershell
cd <本插件目录>
node scripts\install.mjs --check
node scripts\install.mjs             # 建的是 junction（通常不需要管理员权限；遇到 EPERM 改用应用内插件管理器）
# Desktop 装完请完全退出（托盘/任务管理器确认进程结束）再重新打开
```

- `DSH_HOME` 不是默认的 `%USERPROFILE%\.dsh` 时，先 `setx DSH_HOME "%USERPROFILE%\dsh"`（PowerShell 用 `$env:DSH_HOME="$env:USERPROFILE\dsh"`），再执行安装。
- 想确认链接类型：`dir "%USERPROFILE%\.dsh\profiles\desktop\node_modules"` 里应看到 `<JUNCTION>` 指向本插件目录。
- 技能脚本**不要**用 `bash`（Windows 上的 bash 通常是 WSL，路径与 Python 环境都不同）：统一 `node <插件目录>/assets/multichannel-story/scripts/mcs.mjs <子命令>`；`*.sh` 只是 macOS/Linux 的薄壳。
- 文本固定 LF、图片按二进制（插件目录 `.gitattributes`）；`MANIFEST` 校验在 CRLF 检出时会先归一化，不会整份失配。

## 3. 验证

- **设置 → 插件** 里出现「内容工作台」一行，可停用/启用。
- 新建会话，技能目录里应有 `multichannel-story`；输入 `/multichannel-story` 可直接调用。
- 若本机还有手工安装的 `~/.agents/skills/multichannel-story`，**加载的是那份用户副本**（用户级 rank 500 优先于插件的 bundled 600）。要确认插件里的副本生效，先把用户目录那份改名，再重启 DSH 看技能目录。
- 左侧边栏出现「内容工作台」入口，点开是插件页面（产物说明 + 「开始做一条内容」+ 入口开关）。
- 命令行自检：`node scripts/install.mjs --check`。
- 仓库自检（两端都适用）：`node --test`、`node scripts/check-package.cjs .`、`node assets/multichannel-story/scripts/mcs.mjs preflight --page --cards`。

Windows 上额外看这几项（本轮没有 Windows 真机，这部分是给你照着走的清单）：

| 检查 | 期望 |
| --- | --- |
| `dir "%USERPROFILE%\.dsh\profiles\desktop\node_modules"` | `dsh-multichannel-story` 是 `<JUNCTION>`，不是真实目录 |
| `node --test` | 全部通过；1 项「真实上游比对」按设计跳过（需要 `MCS_REQUIRE_UPSTREAM=1`） |
| `node assets/multichannel-story/scripts/mcs.mjs preflight --page --cards` | 缺哪个依赖就照输出的安装命令补（winget / pip） |
| 工作台「风格与配色」 | 色卡能点、方向键能换档、窄窗口自动换行 |
| 装/卸后完全重启 DSH | 插件列表与侧栏入口状态一致，不留残链 |

## 3.1 工作台与侧栏入口

- 左侧边栏出现「内容工作台」入口，点开是工作台：两个页签（开始 / 设置）。开始页 = 三档产物预设 + 「开始」按钮（可见文字只有「开始」）+ 一行状态提示（导语、检查清单、四步流程与提示词预览都已移除）；设置页是分组标题「入口与偏好」+ 一个开关（分组标题 15px，不是页面大标题）。
- 主按钮写进草稿的是**自然语言指令**（点名 `multichannel-story` 技能），不是斜杠命令：这样已有草稿时追加进去也能生效；斜杠命令仍可手动输入。
- 若装了 `dsh-better-sidebar`，右侧栏也会多一个同名标签页（没装自动跳过）。
- 默认显示入口；工作台里的开关与 **设置 → 插件 → 内容工作台 → 配置** 里的开关是同一个偏好。
- 关掉入口只是隐藏 UI：`/multichannel-story` 和技能目录里那一条始终可用；关掉时若正停在工作台会自动回到会话。
- 偏好存在浏览器 `localStorage`（键 `dsh-multichannel-story:sidebar-entry`，值 `on`/`off`）。换浏览器或换机器后会回到默认（显示）。
- 想彻底去掉入口与工作台：停用或卸载插件；客户端半区随插件激活/卸载自动注册和注销。

## 4. 卸载

```sh
node scripts/install.mjs --uninstall
# 或在 DSH 里：
# plugin_manager(action="set_bundle", target="dsh-multichannel-story", enabled=false)
# plugin_manager(action="remove_bundle", target="dsh-multichannel-story")
```

卸载后技能立即从目录消失；profile `package.json` 的备份文件可以手动删除（它们只在排障时有用）。

## 5. 换机 / 迁移

1. 把整个插件目录（含 `assets/`、`scripts/`）拷到新机器同一个位置，或任意位置后用新路径重新安装。
2. 若路径变了：先 `node scripts/install.mjs --check` 看是否指向旧路径，再用 `node scripts/install.mjs --force` 重建链接。
3. `$DSH_HOME` 不是默认的 `~/.dsh` 时，设置环境变量 `DSH_HOME` 后再执行安装/检查脚本。

## 6. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 插件列表里看不到这一行 | 没装到当前 profile；或装完没有完全重启 DSH。先 `node scripts/install.mjs --check` |
| 卸载时报「是真实目录（复制式安装）」 | `node_modules/dsh-multichannel-story` 不是链接而是拷贝（`plugin_manager` 或手动 `cp` 装的）。安装器不会删用户目录：确认要卸载就手动删掉该目录，再跑 `--uninstall` 清登记 |
| 卸载时报「链接指向…不是本插件目录」 | 那个 profile 当前装的是另一个 checkout。去它自己的目录执行 `--uninstall`，或先手动删除链接；安装器不会替你清掉别人的链接与登记 |
| 技能在目录里但加载失败 | 插件目录被移动/删除，或 `assets/multichannel-story/SKILL.md` 丢失/带 BOM。重新安装或重跑 `node scripts/sync-assets.mjs` |
| 改过技能，插件里还是旧内容 | 没重跑 `node scripts/sync-assets.mjs`，或没重启 DSH。`node --test` 会提示 MANIFEST 哈希不一致 |
| 和 `~/.agents/skills/multichannel-story` 同时存在 | 用户目录那份优先级更高（500 < 600 的 bundled 优先级），删掉用户目录那份即可只保留插件版本 |
| 技能自检报缺依赖 | 按 `assets/multichannel-story/references/setup.md` 安装；缺依赖时技能会停下说明，不会降级交付 |
| Windows：`bash` 报找不到文件 / 路径全乱 | 那是 WSL，不是同一个文件系统。技能脚本统一用 `node <插件目录>/assets/multichannel-story/scripts/mcs.mjs …`，不要用 `*.sh` |
| Windows：看不出链接是不是 junction | 用 `dir /AL`，或在 PowerShell 里 `Get-Item <路径>` 看 `LinkType`；脚本装出来的是 `<JUNCTION>` |
| Windows：`node --test` 有 1 项 skipped | 是「真实上游比对」，需要 `MCS_REQUIRE_UPSTREAM=1` 才跑；不是失败 |
| Windows：MANIFEST 校验失败但没改过文件 | 现在纯 CRLF/LF 差异已被哈希归一化，不会因此失败。还失败说明内容真的变了，或改的是图片等二进制（按原始字节校验）；确认后重跑 `node scripts/sync-assets.mjs --manifest-only`，或从源目录重新同步 |

## 7. 手动安装（无 Node 时）

1. 把本目录复制（或建目录链接）到 `$DSH_HOME/profiles/<profile>/node_modules/dsh-multichannel-story`（Windows：`mklink /J`；macOS/Linux：`ln -s`）。
2. 编辑 `$DSH_HOME/profiles/<profile>/package.json`：在 `dependencies` 里加 `"dsh-multichannel-story": "link:<本插件目录的绝对路径>"`，在 `dsh.profile.bundles` 数组里加 `"dsh-multichannel-story"`。
3. 完全退出并重新打开 DSH。
