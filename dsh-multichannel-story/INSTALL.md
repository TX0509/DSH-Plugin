# 安装说明（dsh-multichannel-story）

Host 半区只向 `ctx.skills` 注册一个技能；客户端半区提供**可选的**侧栏入口与工作台面板（入口在设置里关掉后，插件行为退化成纯 host-only）。Desktop 与 Web 的安装方式相同，只是**装在不同的 profile 里**。

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

## 3. 验证

- **设置 → 插件** 里出现「多平台内容流水线」一行，可停用/启用。
- 新建会话，技能目录里应有 `multichannel-story`；输入 `/multichannel-story` 可直接调用。
- 左侧边栏出现「多平台内容」入口，点开是插件页面（产物说明 + 「开始做一条内容」+ 入口开关）。
- 命令行自检：`node scripts/install.mjs --check`。

## 3.1 工作台与侧栏入口

- 左侧边栏出现「多平台内容」入口，点开是工作台：两个页签（开始 / 设置）。开始页 = 三档产物预设 + 「开始：<档位>」+ 将写入草稿的提示词预览 + 开跑前检查 + 折叠的四步流程。
- 若装了 `dsh-better-sidebar`，右侧栏也会多一个同名标签页（没装自动跳过）。
- 默认显示入口；工作台里的开关与 **设置 → 插件 → 多平台内容流水线 → 配置** 里的开关是同一个偏好。
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

## 7. 手动安装（无 Node 时）

1. 把本目录复制（或建目录链接）到 `$DSH_HOME/profiles/<profile>/node_modules/dsh-multichannel-story`（Windows：`mklink /J`；macOS/Linux：`ln -s`）。
2. 编辑 `$DSH_HOME/profiles/<profile>/package.json`：在 `dependencies` 里加 `"dsh-multichannel-story": "link:<本插件目录的绝对路径>"`，在 `dsh.profile.bundles` 数组里加 `"dsh-multichannel-story"`。
3. 完全退出并重新打开 DSH。
