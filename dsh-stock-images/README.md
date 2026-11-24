# dsh-stock-images · 配图素材库

给 DSH 的 Agent 装上「找配图」的能力：写公众号、发小红书、做短视频时，直接在会话里说一句「帮我找三张黄仁勋的横版照片」，Agent 就会调用工具去免费图库搜索、把选中的图片存进当前工作区，并记录署名与许可。

- **工具直接出现在工具列表**，Agent 原生调用，不需要记 URL、不需要复制粘贴。
- **API Key 在插件设置页填写**（Plugins → 配图素材库），密钥存进 DSH 凭据库，不写进插件配置，也不会出现在会话里。
- **两个免 Key 图库开箱可用**：Openverse 与 Wikimedia Commons；其中 Wikimedia Commons 是搜真人的最佳来源。
- **默认只给能安全使用的素材**：只返回「允许商用 + 允许修改」的许可；非商用（NC）、禁止演绎（ND）、版权归属不明、未知许可的图片**既不会出现在结果里，也下载不了**。
- **下载即带署名与权利说明**：图片落到工作区 `stock-images/`，同时在 `ATTRIBUTION.md` 追加一行可粘贴的 credit；每条结果都带 `rights` 与 `risk` 行。

## 工具

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `stock_image_search` | 跨图库搜索，返回候选图（许可、**权利评估**、署名、页面链接、预览图、下载直链、各图库状态，以及被许可策略拒绝了几张、为什么） | `query`、`alt_query`、`sources`、`orientation`、`count`、`min_width` |
| `stock_image_download` | 把选中图片下载到工作区并记录署名；**只接受本次搜索返回的 URL**，拒绝 Unsplash+ 与 AVIF/HEIC；许可要求署名时强制记录，署名写失败会在结果里报警 | `url`、`source`、`filename`、`directory`、`attribution` |
| `stock_image_sources` | 查看各图库是否需要 Key、当前是否配置、各自的额度与许可以及署名规则；`check: true` 会真实请求验证 Key | `check` |

一次典型流程：

1. `stock_image_search({ query: "黄仁勋", alt_query: "Jensen Huang", orientation: "landscape", count: 6 })`
   （`alt_query` 会让 Pexels / Pixabay / Unsplash 直接改用英文；免 Key 的 Openverse 与 Wikimedia 会先搜中文、无结果再自动换英文重搜一次）
2. 从结果里挑一条，`stock_image_download({ url: "<download_url>" })`
3. `read_image({ file_path: "stock-images/jensen-huang-keynote.jpg" })` 确认画面对不对
4. 把图片用到文章 / 卡片 / 视频里，`stock-images/ATTRIBUTION.md` 里已经有署名行

## 法律风险：默认策略怎么避开

这一版按「不确定就不用」来设计，四道闸门都在代码里，不靠自觉：

1. **搜索阶段按许可过滤**
   - Openverse 直接带 `license_type=commercial` + `license=by,by-sa,cc0,pdm` 参数，非商用和禁止演绎的许可根本不会被请求。
   - Wikimedia Commons 逐文件读取 `LicenseShortName` / `UsageTerms` / `LicenseUrl` / `AttributionRequired` / `Restrictions`，再本地分类。
   - 分类结果只要命中 **非商用（NC）、禁止演绎（ND）、All rights reserved、non-free、fair use、editorial use only、未知许可** 任意一条，就**丢弃**，并在 provider 状态行里报告「refused: 原因 × 数量」。
2. **只保留可商用 + 可修改的许可**：CC0 / Public Domain / CC BY / CC BY-SA / 政府开放数据许可（OGL、GODL）/ 三个平台自有许可（Pexels、Pixabay、Unsplash）。**ShareAlike 会额外标注**：你裁剪、加字、二创后的成片必须沿用同一许可。
3. **下载阶段再验一次**
   - **只有本次搜索验证过的 URL 才能下载**（搜索结果在进程内保留 1 小时）；没有搜索记录的 URL 一律拒绝，即使它来自 Pexels 官方图床。
   - 重启后想保存之前看中的图，请重新搜一次再下载——这是有意的取舍：没有元数据就无法确认许可与摄影师署名。
   - 拒绝 `plus.unsplash.com`（Unsplash+ 订阅付费库，不是免费 Unsplash License）。
   - 只保存 JPEG / PNG / WebP / GIF：AVIF / HEIC 虽然合法，但 DSH 的 `read_image` 读不回来，存了也无法核对画面，因此直接拒绝。
   - 因此即使上游页面被篡改、或模型把别处的图片 URL 塞进来，也落不了盘。
4. **署名是许可条件，不是可选项**：许可要求署名时，即使传 `attribution: false` 也会写入 `ATTRIBUTION.md`，并在结果里说明「已强制记录」；如果署名文件写不进去，结果会带 `attribution_error` 并提示手工保存 credit。

结果里每条都带：

```
rights: commercial use OK · modification OK · attribution required · risk: medium
rights notes: attribution is a license condition: keep the credit line with the image
```

`risk` 只有两级：`low`（CC0 / 公有领域 / 平台许可且无需署名）和 `medium`（需要署名、ShareAlike、肖像权、商标、或来源页有额外使用限制）。

**仍需你自己判断的（工具只能提示、不能替你承担）**：

- **肖像权 / 人格权**：真人照片即使版权许可允许商用，把照片用在广告、带货、暗示代言的位置仍可能侵权。用公众人物照片做**编辑性内容**（报道、评论、科普）通常没问题；做**商业推广**请换图或取得授权。Wikimedia 上带 `personality` 限制的文件会标 `risk: medium`。
- **商标与品牌**：画面里出现 logo、产品包装时，不要暗示品牌背书。
- **上游标注可能有误**：CC 图片由上传者标注，Openverse / Flickr 偶有标错许可的情况；商业投放前建议回原页面再确认一次。
- **中国法下的合规**：广告法、著作权法、肖像权对「广告用途」「可识别人物」要求更严；本插件只做素材筛选，不构成法律意见。

## 图库来源

| 来源 | 需要 Key | 免费额度 | 商用 | 署名 | 适合 |
| --- | --- | --- | --- | --- | --- |
| [Pexels](https://www.pexels.com/api/) | 是（即时下发） | 200 次/小时、20000 次/月 | ✅ | API 条款要求展示 Pexels 链接并标注摄影师 | 通用配图、封面、人物氛围图 |
| [Pixabay](https://pixabay.com/api/docs/) | 是（即时下发） | 100 次/分钟 | ✅ | 展示时说图来自 Pixabay；禁止永久热链 | 通用配图、插画 |
| [Unsplash](https://unsplash.com/oauth/applications) | 是（Demo 50 次/小时，Production 审核后 1000 次/小时） | 见左 | ✅ | 必须带摄影师 + Unsplash 回链（含 utm），保存时必须调 download 回调 | 高质量视觉图 |
| [Openverse](https://api.openverse.org/v1/) | **否** | 匿名 20 次/分钟、200 次/天 | 逐条看 CC 许可 | 结果自带 `attribution` 字段 | **人物、新闻、纪实** |
| [Wikimedia Commons](https://commons.wikimedia.org/wiki/Commons:First_steps/Reuse) | **否** | 无硬性上限，需串行与描述性 UA | 逐文件许可 | 按文件页要求标注作者与许可 | **真人肖像**、历史图、机构图 |

> 为什么不接 Flickr / 必应图片 / Google 图片抓取：Flickr 免费 Key 已限制为「只能搜自己的照片」（error 22）；必应搜索 API 已于 2025-08 退役；Google 图片与 DuckDuckGo 的图片接口禁止自动化抓取，且接口随时失效。抓取路线既不合规也不稳定，本插件不做。

## 设置页：填写 API Key

打开左侧栏 **Plugins** → **Installed plugins** → **配图素材库**，页面中间就是本插件的配置卡片：

- 每一行是一个需要 Key 的图库：显示当前状态（已配置 / 未配置）、是否来自环境变量、密钥文件里的掩码预览、申请 Key 的官方入口。
- 粘贴 Key → **保存**：写入 DSH 凭据库（`~/.dsh/.credentials.yaml` 的 `refs` 段），立刻生效，不需要重启。
- **清除**：删除凭据库里的值；如果同时存在环境变量，会回落到环境变量。
- 免 Key 的两个图库固定显示「无需 Key」，装好即可用。

凭据引用名：

| 图库 | 凭据引用（也是环境变量名） |
| --- | --- |
| Pexels | `PEXELS_API_KEY` |
| Pixabay | `PIXABAY_API_KEY` |
| Unsplash | `UNSPLASH_ACCESS_KEY` |

除了设置页，也可以直接设置环境变量，或手工写入：

```yaml
# ~/.dsh/.credentials.yaml
version: 1
refs:
  PEXELS_API_KEY: 你的key
  PIXABAY_API_KEY: 你的key
  UNSPLASH_ACCESS_KEY: 你的key
```

凭据服务不可用时（例如极简部署没有挂载凭据插件），设置页会给出说明并禁用输入，工具仍可读取环境变量。

## 安全与边界

- **只走 HTTPS，并做 SSRF 防护**：解析 DNS 后拒绝回环、内网、链路本地、CGNAT、IPv6 唯一本地等地址；重定向逐跳重新校验，最多 4 跳；响应体有大小上限（图片 32 MB）。
- **只认真正的图片**：按文件签名识别 JPEG / PNG / WebP / GIF / AVIF，非图片内容直接拒绝，扩展名由签名决定而不是 URL。
- **写入被限制在会话工作区内**：目录参数会解析成绝对路径并校验是否落在当前 Session 的工作目录内，`../` 与工作区外的绝对路径都会被拒绝；文件名清洗为安全字符，重名自动加序号。
- **密钥不进日志、不进会话、不进插件配置**：设置页只显示掩码；错误信息只带凭据引用名。
- **下载会记录署名**：默认写入 `stock-images/ATTRIBUTION.md`，可用 `attribution: false` 关闭。

## 安装

### 方式一：DSH 内安装（推荐，Web / Desktop 都适用）

1. 打开左侧栏 **Plugins** → **Add plugin**。
2. 输入本插件目录的绝对路径（例如 `/Users/you/Desktop/Code/DSH-Plugin/dsh-stock-images`）并安装。
3. 安装完成后 **完全退出并重新打开 DSH**（Desktop 必须整应用重启；Web 仅刷新页面不一定重新加载插件模块）。
4. 在 **Plugins → Installed plugins → 配图素材库** 里填写 Key。

### 方式二：命令行安装脚本

```sh
cd dsh-stock-images
node scripts/install.mjs --check      # 检查安装状态
node scripts/install.mjs              # 安装到 web + desktop 两个 profile
node scripts/install.mjs --dry-run    # 只打印计划
node scripts/install.mjs --uninstall  # 卸载
```

脚本的作用：把本目录链接进 `<profile>/node_modules/dsh-stock-images`，并把包名写进该 profile 的 `dsh.profile.bundles`；改 `package.json` 前会先备份。

> Desktop profile 由 Electron 独占管理，**不要**在应用运行时执行 `dsh plugin --profile desktop ...`。要么用应用内插件管理，要么先完全退出应用再运行脚本。

更多细节见 [INSTALL.md](INSTALL.md)。

## 兼容性

| 项目 | 说明 |
| --- | --- |
| DSH | 实测 `0.2.2-rc.5`（Desktop 内置 Web GUI）。`engines.dsh: >=0.2.1-rc.5` |
| Node.js | `>=20`（插件运行时不引入任何第三方依赖） |
| 平台 | Web 与 Desktop 共用同一份客户端代码；`dsh.client.platform` 固定为 `web` |
| 主题 | 只使用 `--dsw-*` / `--dsw-alias-*` token，跟随亮色 / 暗色 / 第三方主题 |

## 开发与测试

```sh
node --test                  # 单元测试（纯函数 + provider 归一化 + 客户端字典/凭据转发）
node --check index.js
node --check client.js
node scripts/smoke.mjs       # 真实网络冒烟：免 Key 图库搜索 + 下载 + 图片签名/尺寸校验
```

`scripts/smoke.mjs` 会实际请求 Openverse 与 Wikimedia Commons，并把下载文件写到临时目录后删除；设置了几何 Key 的环境变量时也会一并验证。

## 已知限制

- **设置页卡片尚未做视觉验收**：DSH Web GUI 只接受带认证信息的 URL，外部自动化浏览器无法打开，因此没有提供截图。卡片已通过单测（slot 注册、凭据 Remote 转发、中英文案一致）；请在 **Plugins → 配图素材库** 里确认实际观感。
- **三个需要 Key 的图库未做真机调用**：本机没有 Pexels / Pixabay / Unsplash 的 Key，只按官方文档做了请求构造与字段归一化的单测。填上 Key 后可用 `stock_image_sources({ check: true })` 自检。
- **搜索不是万能的**：Pexels / Pixabay / Unsplash 是通用素材库，搜人名通常只能得到「相似氛围」的图；要找特定人物（例如黄仁勋），请依赖 Openverse 与 Wikimedia Commons，或用 `alt_query` 同时给出英文名。
- **Pixabay 大图上限 1280px**：默认 Key 只返回 `largeImageURL`；更高分辨率需要向 Pixabay 申请 full API access。
- **Unsplash Demo Key 只有 50 次/小时**：频繁搜索容易打满，Production 需要走审核。
- **Openverse 匿名额度 20 次/分钟 / 200 次/天**：大量搜索建议申请 OAuth 应用提额。
- **结果缓存只在进程内**：搜索与下载之间的权利/署名/回调信息通过内存缓存关联（1 小时、1000 条上限）。重启后下载同一个 URL 会被拒绝，需要重新搜索——这是为了确保每次都带着可核验的许可信息。
- **不做图片压缩、裁剪、去水印**：本插件只负责「找到并保存合法来源的图片」；AVIF/HEIC 不保存（`read_image` 无法回读）。
- **不下载到符号链接目录**：目标目录解析出的真实路径必须仍在会话工作区内，否则拒绝写入。
- **许可需要人判断**：CC 图逐条不同，工具会给出许可与署名，但发布前是否可用（尤其是人物肖像权）仍需你自己确认。

## 卸载

```sh
node scripts/install.mjs --uninstall
```

或在 **Plugins → Installed plugins** 里移除本插件，然后完全重启 DSH。卸载不会删除已经下载到工作区的图片与 `ATTRIBUTION.md`；凭据库里的三个 Key 也会保留，需要时在设置页清除。

## 许可证

MIT。图标与界面样式为本项目原创。
