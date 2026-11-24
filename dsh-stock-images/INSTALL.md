# 安装与排障

本插件是一个标准 DSH bundle：Host 半区注册三个工具，Client 半区在 Plugins 页渲染配置卡片。运行时不引入第三方依赖，不需要构建。

## 1. 环境要求

| 项目 | 要求 |
| --- | --- |
| DSH | `>=0.2.1-rc.5`（实测 `0.2.2-rc.5`） |
| Node.js | `>=20`（只有安装脚本与测试需要；插件本体由 DSH 自带的运行时加载） |
| 操作系统 | macOS / Windows / Linux（Web 与 Desktop 共用同一份客户端代码） |
| 网络 | 搜索与下载需要访问图库 API；无网时工具会返回明确的网络错误 |

## 2. 在 DSH 里安装（推荐）

1. 左侧栏 **Plugins** → **Add plugin**。
2. 填写插件目录的**绝对路径**，例如：
   - macOS：`/Users/you/Desktop/Code/DSH-Plugin/dsh-stock-images`
   - Windows：`C:\Users\you\Code\DSH-Plugin\dsh-stock-images`
3. 确认安装，等待进度完成。
4. **完全退出 DSH 再打开**：
   - Desktop：退出整个应用（macOS `Cmd+Q`，Windows 关闭全部窗口）。
   - Web：重启 `dsh web` 进程；仅刷新浏览器页面不保证重新加载插件模块。
5. 打开 **Plugins → Installed plugins**，应能看到「配图素材库 / Stock images」，点进去就是 Key 配置卡片。

## 3. 用安装脚本安装

脚本做两件事：在 `<profile>/node_modules/` 下建立指向本目录的符号链接（Windows 用 junction），并把包名加入该 profile `package.json` 的 `dsh.profile.bundles`。改 `package.json` 前会备份成 `package.json.bak-stock-images-<时间戳>`。

```sh
cd dsh-stock-images

node scripts/install.mjs --check       # 只检查
node scripts/install.mjs --dry-run     # 只打印计划，不写文件
node scripts/install.mjs               # 安装到 web + desktop
node scripts/install.mjs --all         # 安装到全部检测到的 profile
node scripts/install.mjs --profile web # 只装指定的 profile（可重复）
node scripts/install.mjs --force       # 目录移动后重建失效链接
node scripts/install.mjs --uninstall   # 卸载
```

- `DSH_HOME` 默认是 `~/.dsh`，可用环境变量覆盖。
- 默认优先处理 `web` 与 `desktop` 两个 profile；都不存在时退回全部检测到的 profile。
- **Desktop profile 由 Electron 独占管理**：不要在应用运行时用 `dsh plugin --profile desktop ...` 写 profile，否则应用退出时可能回写覆盖。用应用内插件管理，或先完全退出应用再跑脚本。

## 4. 不装 Node 的手工安装

1. 把 `dsh-stock-images/` 整个目录放到一个固定位置（移动后需要重建链接）。
2. 建链接：
   - macOS / Linux：`ln -s /绝对路径/dsh-stock-images ~/.dsh/profiles/web/node_modules/dsh-stock-images`
   - Windows（管理员或开发者模式）：`cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-stock-images" "C:\绝对路径\dsh-stock-images"`
3. 编辑 `~/.dsh/profiles/web/package.json`（Desktop 对应 `profiles/desktop`）：
   - `dependencies` 里加 `"dsh-stock-images": "link:/绝对路径/dsh-stock-images"`
   - `dsh.profile.bundles` 数组里加 `"dsh-stock-images"`
4. 完全重启 DSH。

## 5. 配置 API Key

### 方式 A：设置页（推荐）

**Plugins → Installed plugins → 配图素材库**：

- 每行粘贴 Key → **保存**（写入凭据库，立即生效）；
- **清除** 删除凭据库中的值；
- 状态列会显示「已配置 / 未配置」和掩码预览；如果值来自环境变量，会标注「来自环境变量」。

### 方式 B：环境变量

```sh
export PEXELS_API_KEY=...
export PIXABAY_API_KEY=...
export UNSPLASH_ACCESS_KEY=...
```

环境变量是**启动时快照**：启动后再 `export` 不生效，需要重启 DSH。

### 方式 C：凭据文件

```yaml
# ~/.dsh/.credentials.yaml
version: 1
refs:
  PEXELS_API_KEY: 你的key
  PIXABAY_API_KEY: 你的key
  UNSPLASH_ACCESS_KEY: 你的key
```

文件权限必须是 `600`（仅本人可读），否则凭据服务拒绝加载：

```sh
chmod 600 ~/.dsh/.credentials.yaml
```

优先级：凭据库（设置页保存的值）> 启动环境变量 > 项目 `.env` > `~/.dsh/.env`。

> Openverse 与 Wikimedia Commons **不需要**任何 Key，装好即可用。

## 6. 验证

1. 新开一个会话，问：「用 stock_image_sources 看一下现在有哪些图库可用」。
2. 或直接说：「帮我找三张黄仁勋的横版照片」。
3. 想验证 Key 是否有效，让 Agent 调用 `stock_image_sources({ check: true })`，它会真实请求每个图库并报告 HTTP 状态。
4. 想确认许可闸门在工作，随便给 Agent 一个图库以外的图片 URL 让它下载，应该返回 `RIGHTS_UNVERIFIED`。

> 许可策略（只给可商用 + 可修改；NC/ND/未知许可直接丢弃；只下载本次搜索验证过的 URL；拒绝 Unsplash+ 与 AVIF/HEIC）是硬编码的，没有配置项可以放开。详见 README 的「法律风险：默认策略怎么避开」。

## 7. 常见问题

**工具列表里没有 `stock_image_*`**

- 插件是否在 **Plugins → Installed plugins** 里且为开启状态？
- 是否**完全重启**了 DSH？（改 JavaScript 文件后必须重启，热更新不会替换已加载的模块）
- 是否有别的插件用了同名工具？看 Host 日志里 `dsh-stock-images: cannot register ...`，重名时本插件会跳过该工具而不是让整个 bundle 失败。

**设置页看不到配置卡片**

- 确认进入的是 **bundle 详情页**（Installed plugins → 配图素材库），而不是 Settings 里的插件清单。
- 卡片注册在 `plugins.bundle.config`；如果当前 DSH 版本改了 slot 名，卡片不显示，但工具仍可用（Key 可用环境变量或凭据文件配置）。

**保存 Key 报错**

- 「credential-rejected」：凭据服务拒绝了值（空值不允许保存，请用「清除」代替）。
- 「credentials service unavailable」：当前部署没有挂载凭据服务，请改用环境变量。

**搜索返回 401 / 403**

- Key 无效或过期。Pexels 的 `Authorization` 头不带 `Bearer` 前缀；Unsplash 用 `Client-ID` 前缀。设置页保存的是纯 Key（不要带前缀）。
- Unsplash Demo Key 只有 50 次/小时，超限是 403。

**搜索返回 429**

- 超出图库额度。Pexels 200 次/小时、Pixabay 100 次/分钟、Openverse 匿名 20 次/分钟且 200 次/天、Unsplash Demo 50 次/小时。等一会儿再试，或申请更高额度。

**下载报 `PATH_OUTSIDE_WORKSPACE`**

- `directory` 参数只能在当前会话工作目录内部，不能写 `..` 或工作区外的绝对路径。

**下载报 `RIGHTS_UNVERIFIED`**

这是许可闸门，不是 bug：只有**本次会话里搜索验证过权利的 URL** 才能保存（搜索结果在进程内保留 1 小时）。重启过 DSH、或 URL 是从别处复制来的，都要重新 `stock_image_search` 一次再下载。这样能挡住未验证许可的素材。

**下载报 `UNSUPPORTED_IMAGE_FORMAT`**

命中的是 AVIF / HEIC。它们本身合法，但 DSH 的 `read_image` 无法回读，存了也没法核对画面，因此要求换一张 JPEG / PNG / WebP / GIF。

**下载报 `PATH_SYMLINK`**

目标目录（或 `ATTRIBUTION.md`）是符号链接，真实路径可能在会话工作区外，已拒绝写入。换一个普通目录即可。

**工具返回「refused: non-commercial license × 2」**

说明命中的图片里有非商用/禁止演绎许可，已被策略丢弃。换关键词，或改用 Pexels / Pixabay / Unsplash 找同类素材；不要试图绕过——本插件没有放开非商用许可的开关。

**下载报 `NOT_AN_IMAGE`**

- URL 返回的不是图片（可能是登录页、错误页或防盗链）。重新搜索取一条新的 `download_url`。

**下载报 `BLOCKED_HOST` / `INSECURE_URL`**

- 只允许 HTTPS 公网地址；内网、回环、`http://` 都会被拒绝。这是有意的 SSRF 防护。

## 8. 卸载

```sh
node scripts/install.mjs --uninstall
```

或在 Plugins 页移除插件，然后完全重启 DSH。

- 不会删除已下载的图片与 `stock-images/ATTRIBUTION.md`。
- 不会删除凭据库里的 Key；如需清除，在设置页点「清除」或编辑 `~/.dsh/.credentials.yaml`。

## 9. 迁移到另一台机器

1. 复制整个 `dsh-stock-images/` 目录。
2. 在新机器上重新执行安装（链接指向新路径，旧的必须是重建而不是复制）。
3. 重新填 Key（凭据库不随插件目录迁移）。
