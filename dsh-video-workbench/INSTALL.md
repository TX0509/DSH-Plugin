# 安装与卸载

适用范围：**DSH Desktop（Windows）**，DSH `0.2.2-rc.3`。Web 与 macOS 未验证。

## 前置检查

1. `package.json` 的 `engines.dsh` 必须覆盖你当前的 DSH 版本（当前固定为 `0.2.2-rc.3`）。
   DSH 升级后插件会**拒绝激活**，这是有意的保护，见 [docs/UPGRADE-PLAYBOOK.md](docs/UPGRADE-PLAYBOOK.md)。
2. Desktop 的 profile 由 Electron 应用独占管理，`dsh plugin --profile desktop ...` 会被拒绝。
3. 安装或更新前，**完全退出 DSH（包括托盘图标）**；否则应用退出时可能回写 profile，覆盖安装结果。

## 方式 A：应用内插件管理器（最简单）

在 DSH 的「插件」页启用 `dsh-video-workbench`。若插件管理器提供“从本地目录 / link 安装”，
选择本目录即可；否则用方式 B。

## 方式 B：安装脚本（推荐）

```powershell
# 完全退出 DSH 后
node scripts/install.mjs --profile desktop
```

脚本会：

1. 在 `<profile>/node_modules/` 建立指向本目录的链接（Windows 用 junction）；
2. 备份 `<profile>/package.json`；
3. 写入 `dependencies["dsh-video-workbench"] = "link:<本目录>"` 并登记到 `dsh.profile.bundles`
   （临时文件 + `rename` 原子写：中断也不会留下截断的 profile `package.json`）；
4. 读回校验。

常用参数：

```powershell
node scripts/install.mjs --check       # 只检查，不改文件
node scripts/install.mjs --dry-run     # 预演
node scripts/install.mjs --force       # 目录移动后重建失效链接
node scripts/install.mjs --uninstall   # 卸载
node scripts/install.mjs --no-backup   # 不生成 package.json 备份（自行负责回滚）
```

安装完成后**完全退出并重新打开 DSH**（只刷新页面不够：客户端半区在启动时合成模块图）。

脚本只改 `<profile>/package.json` 与 `node_modules` 链接，**不会**运行 `pnpm install`；
profile 的 `pnpm-lock.yaml` / `.modules.yaml` 会在下一次插件管理操作时对齐。每次安装或卸载都会
在 profile 目录留下一份 `package.json.bak-video-workbench-*` 备份，可自行清理旧备份。

## 方式 C：手动安装（没有 Node）

1. 关闭 DSH。
2. 建立链接（`mklink /J` 建的是 junction，**不需要**管理员权限；只有 `/D` 符号链接才需要开发者模式）：
   ```cmd
   mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-video-workbench" "D:\Terry\Code\DSH-Plugin\dsh-video-workbench"
   ```
3. 编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：
   - `dependencies` 增加 `"dsh-video-workbench": "link:D:/Terry/Code/DSH-Plugin/dsh-video-workbench"`
   - `dsh.profile.bundles` 增加 `"dsh-video-workbench"`
4. 重新打开 DSH。

## 配置（M1 起）

M0 不需要配置。M1 增加项目能力后，需要给 profile 的 `cordis.patch.yml` 加一条配置
（该文件与插件一样由 Desktop 独占管理，**先完全退出 DSH 再编辑**）：

```yaml
- id: video-workbench
  name: dsh-video-workbench
  config:
    projectsRoot: D:/Terry/Videos/dsh-video/video-projects
    exportDir: D:/Terry/Videos/dsh-video/video-exports
```

| 配置项 | 必填 | 说明 |
| --- | --- | --- |
| `projectsRoot` | 是 | 所有项目的父目录；推荐 D 盘专用 DSH 工作区下的 `video-projects/`，**不会默认写 C 盘** |
| `exportDir` | 否 | 渲染后另存成片（M2 起生效），媒体/项目路由都不暴露它 |
| `mediaRoot` | 否 | 媒体根目录，默认 `$DSH_HOME/cache/dsh-video-workbench/media` |
| `dataDir` | 否 | 插件数据目录，默认 `$DSH_HOME/cache/dsh-video-workbench`；自检报告写在这里 |
| `selfcheckOnStartup` | 否 | 默认 `true`；启动 3 秒后自动跑 `video_selfcheck` 并写报告 |
| `selfcheckDelayMs` | 否 | 默认 `3000`；启动自检延迟 |
| `requireToken` | 否 | 默认 `true`；不推荐关闭 |

未配置 `projectsRoot` 时插件仍可加载，但项目功能禁用，`video_selfcheck` 的
`projectsRootWritable` / `projectsRoute` 会失败并写进报告。

## 验证安装

```powershell
node scripts/install.mjs --check
```

启动 DSH 后：

1. composer 左侧出现 ▶ 按钮，点开能看到播放器与诊断信息；
2. 等约 3 秒，读取启动自检报告：

   ```powershell
   Get-Content "$env:USERPROFILE\.dsh\cache\dsh-video-workbench\selfcheck.json" -Raw
   ```

   期望 `"ok": true` 且 `checks` 里 5 项都为 `"ok": true`。若未配置 `projectsRoot`，
   两项项目检查会失败并说明原因。
3. 页面 DevTools 控制台也可以手动复跑：

   ```js
   const t = window.__DSH_VIDEO_WORKBENCH__.token
   const r = await fetch(`/api/video-workbench/selfcheck?t=${t}`).then((x) => x.json())
   console.table(r.checks); r.ok
   ```

## 升级

1. 完全退出 DSH；
2. 更新本目录代码；
3. 再跑一次 `node scripts/install.mjs --profile desktop`（已是最新时会 skip）；
4. 重新打开 DSH。

## 卸载

```powershell
# 完全退出 DSH 后
node scripts/install.mjs --uninstall --profile desktop
```

脚本会移除链接、`dependencies` 与 `bundles` 登记，并保留一份 `package.json` 备份。
**不会**删除以下数据，需要时手动清理：

- `$DSH_HOME\cache\dsh-video-workbench\`（运行时、媒体缓存与 `selfcheck.json`）
- 你的项目目录（`projectsRoot`）

卸载后重新打开 DSH，确认侧栏与 composer 不再出现插件入口。

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 插件列表里看不到 | `engines.dsh` 与当前版本不匹配；按升级手册复测后放宽范围 |
| composer 没有 ▶ 按钮 | 客户端模块图只在启动时合成；完全退出后重开 |
| 播放器提示“未获取到访问令牌” | 页面启动时未拿到注入的 token；完全退出后重开 |
| 播放返回 401 | 同上；token 每个进程重新生成，旧页面会失效 |
| 播放返回 404 | `mediaRoot` 下没有该文件；默认在 `$DSH_HOME\cache\dsh-video-workbench\media` |
| 自检报告 `ok: false` | 看 `checks` 里失败项的 `detail`：未配置 `projectsRoot`、缺 `test.mp4`、或未完全重启都可能导致 |
| `/api/video-workbench/selfcheck` 返回纯文本 `unauthorized` | 该路由没挂载（返回的是网关 401）；确认插件已加载并完全重启 DSH |
| 渲染失败（M2 起） | 检查 Chrome 可用性与 ffmpeg；见 [docs/M0-FINDINGS.md](docs/M0-FINDINGS.md) |
