# 换电脑安装 / 迁移

插件本身就是一个目录，不含 `node_modules`，也没有构建步骤；换机器只需要把它放进新机器的 DSH profile。推荐方式 A。

## 最短路径（有 Node，Windows）

```powershell
# 1. 把 dsh-peak-hours-1.0.0.zip 拷到新电脑，解压：
Expand-Archive .\dsh-peak-hours-1.0.0.zip -DestinationPath D:\apps
# 2. 先启动一次 DSH 再完全退出（生成 profiles）
# 3. 安装到 web + desktop，并检查：
node D:\apps\dsh-peak-hours\scripts\install.mjs
node D:\apps\dsh-peak-hours\scripts\install.mjs --check
# 4. 完全退出并重新打开 DSH
```

macOS / Linux 把最后两步换成 `node /path/dsh-peak-hours/scripts/install.mjs`。

## A. 拷贝文件夹 + 安装脚本（推荐）

1. **旧电脑**：把整个 `dsh-peak-hours` 目录拷走（或使用打包好的 `dsh-peak-hours-1.0.0.zip`），放到新电脑任意路径，例如 `D:\apps\dsh-peak-hours`。路径含空格也可以。
2. **新电脑**：先启动一次 DSH 再完全退出，让它生成 `~/.dsh/profiles/web` 与 `~/.dsh/profiles/desktop`。
3. 在插件目录执行：

   ```sh
   node scripts/install.mjs
   ```

   Windows 下即 `node scripts\install.mjs`。脚本会：

   - 在 profile 的 `node_modules/dsh-peak-hours` 建立 junction（Windows）或 symlink（macOS/Linux），指回插件目录；
   - 在 profile `package.json` 的 `dependencies` 写入 `"dsh-peak-hours": "link:<插件目录>"`；
   - 把 `dsh-peak-hours` 追加到 `dsh.profile.bundles`；
   - 修改前备份为 `package.json.bak-peak-hours-<时间戳>`；
   - 默认只处理 `web` 和 `desktop`，`--all` 处理全部 profile，`--profile <名字>` 精确指定。

4. 完全退出并重新打开 DSH（仅刷新页面不够，bundle 列表在启动时合成）。
5. 验证：

   ```sh
   node scripts/install.mjs --check
   ```

其他参数：

```sh
node scripts/install.mjs --dry-run              # 预演，不改文件
node scripts/install.mjs --all                  # 装到所有 profile
node scripts/install.mjs --profile web          # 只装 web
node scripts/install.mjs --uninstall            # 卸载
node scripts/install.mjs --force                # 插件目录移动后重建链接
```

`DSH_HOME` 不是 `~/.dsh` 时先设置环境变量，例如 `set DSH_HOME=D:\dsh-data`。

## B. 只用官方 CLI（仅 web profile）

如果只关心浏览器端：

```sh
dsh plugin --profile web add link:D:/apps/dsh-peak-hours
```

`dsh plugin` 最终执行 pnpm，会把包链接进 profile 并维护 `dsh.profile.bundles`。

也可以直接装打包好的 tgz（`dsh-peak-hours-1.0.0.tgz`）：

```sh
dsh plugin --profile web add file:D:/apps/dsh-peak-hours-1.0.0.tgz
```

这条路径已实测：pnpm 会把包复制进 profile 的 `node_modules` 并自动把 `dsh-peak-hours` 追加到 `dsh.profile.bundles`。区别是 tgz 安装是**复制**，之后升级要再 `add` 一次；方式 A 的 `link:` 指向源目录，覆盖源目录即完成升级。

桌面端 profile 由 Electron 应用独占管理，`dsh plugin --profile desktop` 会报 “profile desktop is managed exclusively by the Electron application”，请用方式 A 或 C。

## C. 手动安装（没有 Node 时）

Windows PowerShell：

```powershell
$src = "D:\apps\dsh-peak-hours"
foreach ($p in @("web", "desktop")) {
  $dir = Join-Path $env:USERPROFILE ".dsh\profiles\$p"
  New-Item -ItemType Directory -Force (Join-Path $dir "node_modules") | Out-Null
  cmd /c mklink /J (Join-Path $dir "node_modules\dsh-peak-hours") $src
}
```

macOS / Linux：

```sh
ln -s /path/to/dsh-peak-hours ~/.dsh/profiles/web/node_modules/dsh-peak-hours
ln -s /path/to/dsh-peak-hours ~/.dsh/profiles/desktop/node_modules/dsh-peak-hours
```

然后编辑每个 profile 的 `package.json`，缺哪段补哪段：

```json
{
  "dependencies": {
    "dsh-peak-hours": "link:D:/apps/dsh-peak-hours"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...其他 bundle 保持不动...",
        "dsh-peak-hours"
      ]
    }
  }
}
```

最后重启 DSH。

## 插件目录移动之后

链接指向旧路径会失效。到新路径重新执行 `node scripts/install.mjs --force`，或手动删掉 `node_modules/dsh-peak-hours` 再重装。

## 常见问题

- **`没有检测到任何 DSH profile`**：先启动一次 DSH；或用 `--profile` 指定；或检查 `DSH_HOME`。
- **重启后侧边栏没有徽章**：先跑 `--check`；确认所有目标 profile 都是 `[ok]`。仍不显示时，确认 DSH 版本包含 `sidebar.footer.action` 槽（0.2.x 已有），并查看「插件」页是否出现 `dsh-peak-hours`。
- **pnpm 报 lockfile 不一致**：手动写入的 `link:` 依赖不会同步 `pnpm-lock.yaml`。执行一次 `pnpm install`（不要加 `--frozen-lockfile`），或通过图形界面的插件管理器重装即可。
- **桌面端正在运行**：建议完全退出应用后再运行脚本，避免应用退出时回写 profile 文件。
- **升级插件**：用新版目录覆盖旧目录即可，链接不用重建；只有目录路径变化时才需要 `--force`。
