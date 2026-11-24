# 验证记录

本文件记录本插件在不同环境下的**实际验证**结果（不是设计意图）。后续改动请更新这里。

## 环境

| 项目 | 值 |
| --- | --- |
| DSH | `0.2.2-rc.5`（Desktop 内置 Web GUI） |
| 安装方式 | 应用内插件管理安装本地目录（`~/.dsh/profiles/desktop/node_modules/dsh-stock-images` 为符号链接） |
| profile | `desktop`（另用 `scripts/install.mjs --profile web` 装到 `web`） |
| 操作系统 | macOS（Darwin，Apple Silicon） |
| Node.js（测试/脚本） | 26.x（插件本体不依赖第三方包） |

## 已实际验证

### Host 半区 / 工具（真机、真网络）

- 新开一个子 Agent，其工具列表中出现 `stock_image_sources`、`stock_image_search`、`stock_image_download`。
- `stock_image_sources({})`：返回 5 个 provider 的状态；Pexels / Pixabay / Unsplash 显示 `unconfigured` 并提示凭据引用名；Openverse / Wikimedia Commons 显示 `available · no key needed`。
- `stock_image_sources({ check: true })`：对 Openverse 与 Wikimedia Commons 发起真实请求，状态为 `ok`；未配置 Key 的三个 provider 未发请求。
- `stock_image_search({ query: "黄仁勋", alt_query: "Jensen Huang", orientation: "landscape", count: 5 })`：返回 Wikimedia Commons 的真实结果（5184×3888，作者 Anders Eidesvik，CC BY 4.0），并给出 `download_url` / `preview_url` / `page` / `credit`，同时列出每个 provider 的状态行。
- `stock_image_download({ url, filename: "jensen-huang-verify" })`：下载成功，返回 `stock-images/jensen-huang-verify.jpg`、5184×3888、3.8 MB、`image/jpeg`、许可 `CC BY 4.0`、署名行，并写入 `stock-images/ATTRIBUTION.md`。
- `read_image` 读取该文件：画面确认为黄仁勋（斯坦福活动现场，真人肖像）。
- 写入路径校验、文件名清洗、图片签名识别、署名文件格式均按预期工作。

### 许可闸门（真机 + 真网络）

- `stock_image_search` 只返回 CC0 / Public Domain / CC BY / CC BY-SA / 政府开放数据 / 平台许可的结果；每条带 `rights` 与 `risk` 行；provider 状态行会报告「refused: 原因 × 数量」。
- 真实查询 `Jensen Huang` / `Mickey Mouse` / `Coca-Cola bottle`（Openverse + Wikimedia）：保留结果全部是 commercial + modification 许可，未出现 NC/ND/未知许可。
- `resolveDownloadPolicy` 实测：
  - 未经搜索的 `https://upload.wikimedia.org/...` → 拒绝（无法确认逐文件许可）；
  - `https://example.com/cat.jpg` → 拒绝；
  - `https://images.pexels.com/...`、`https://cdn.pixabay.com/...` → 允许（平台许可 + 官方图床）。
- 许可要求署名时，`attribution: false` 也会写入 `ATTRIBUTION.md`，结果里带 `attribution was recorded because the license requires it`。
- 工具真机返回示例（节选）：

```
License policy: commercial use and modification allowed; NC, ND, all-rights-reserved and unknown licenses are refused.
1. [openverse] 1350×1464 · 總統府 · CC BY 2.0
   rights: commercial use OK · modification OK · attribution required · risk: medium
   rights notes: attribution is a license condition: keep the credit line with the image
2. [wikimedia] 1698×2362 · Anders Eidesvik · CC BY 4.0
   rights notes: ... / identifiable people: personality/publicity rights may apply — normally fine for editorial use ...
```

- 任意外部 URL 的下载尝试被拒绝：

```
Error: refusing to save the image (rights unverified): cannot verify the license of example.com; search it with stock_image_search first
```

- `ATTRIBUTION.md` 在三次下载后按预期累积 3 条记录（含 `attribution: false` 的那次）。

### 单元测试

```sh
node --test     # 68 个用例全部通过
node --check index.js
node --check client.js
```

覆盖：文件名清洗、路径围栏（含**符号链接逃逸**与 `ATTRIBUTION.md` 链接拒绝）、SSRF 地址判定（含 **IPv4-mapped / NAT64 / 6to4**）、图片签名与尺寸解析、参数校验、provider 请求构造与归一化（5 个 provider 的真实字段形状，**Unsplash+ 结果被丢弃**）、查询回退计划、**许可分类对抗语料（`CC BY NC`、`BY/NC`、`CC BY 4.0 ND` 等空格/标点变体一律拒绝；CC0/PD/BY/BY-SA/政府许可放行）**、**下载权利闸门（未搜索 URL、来源不匹配、Unsplash+ 全部拒绝；署名强制与 CC0 免署名）**、渲染文本、Host `apply()` 与 Client `apply()` 的注册/清理契约、安装脚本 `--check`/`--dry-run`/`--uninstall`。

### 真实网络冒烟

```sh
node scripts/smoke.mjs
```

Openverse 与 Wikimedia Commons 搜索「Jensen Huang」并下载图片到临时目录，校验 HTTP 状态、图片签名与尺寸后清理临时目录。最近一次通过。

## 代码审查后修复（第二轮）

独立审查 + 复现确认的问题已修复并补了对抗性测试：

| 问题 | 状态 |
| --- | --- |
| 空格/标点写法（`CC BY NC`、`BY/NC`、`CC BY 4.0 ND`）绕过许可闸门 | 已修：按无分隔符形式 + token 双重判定，NC/ND 一律拒绝 |
| `plus.unsplash.com`（Unsplash+ 付费库）被当作免费 Unsplash License | 已修：搜索结果丢弃该主机，下载显式拒绝 |
| 符号链接目录可把写入带出 workspace | 已修：创建目录后比对 `realpath`；`ATTRIBUTION.md` 拒绝符号链接 |
| IPv6 `::ffff:7f00:1` / `64:ff9b::` / 6to4 私网地址未被识别 | 已修：展开为 8 组 16 位做前缀判断，只有 `2000::/3` 视为公网，并检查 6to4/Teredo |
| 无 Session cwd 时回落到 `process.cwd()` | 已修：直接返回 `NO_WORKSPACE` |
| 署名写失败被吞、仍报成功 | 已修：返回 `attribution_error` 并在结果文本里报警 |
| 错误信息回显绝对路径 / 原始 URL | 已修：改用相对路径与固定文案（避免回显 API Key 查询串） |
| Unsplash 下载回调可返回任意主机 | 已修：只接受 unsplash 官方图床 |
| 平台图床直链可绕过搜索下载（拿不到摄影师署名） | 已修：**只接受本次搜索返回的 URL**；重启后需重搜 |
| `latinQuery` 方向反了（英文主查询 + 中文 alt 反而搜中文） | 已修 |
| AVIF/HEIC 会存盘但 `read_image` 读不回来 | 已修：拒绝保存，提示换 JPEG/PNG/WebP/GIF |
| `uniqueTargetPath` + `writeFile('wx')` 竞态 | 已修：`EEXIST` 自动换名重试 |
| 多 query 回退时丢失 refused 统计 | 已修：累计后返回 |
| `engines.dsh` 宽于实测版本 | 已修：`>=0.2.2-rc.5` |
| install.mjs 无测试 | 已补：`--check` / `--dry-run` / `--uninstall` / 非法 profile |
| 客户端 `useMemo` 未用、`writable` 未生效、credential source 取值猜错、locale 字典未随卸载释放 | 已修 |

测试从 41 个增加到 57 个，新增：许可对抗语料、IPv6 表、符号链接写入、只允许可回读格式、Host/Client `apply()` 契约、搜索编排（stub fetch，离线确定性）、下载集成（署名强制、来源不匹配、未搜索 URL 拒绝）、安装脚本。

## 未验证 / 需要用户确认

- **设置页卡片的视觉效果未验证**：DSH Web GUI 只接受 `dsh web` 打印的带认证信息的 URL，外部自动化浏览器拿到的是 `dsh web authentication required; reopen the URL printed by dsh web.`。因此没有截图，也没有做亮/暗主题、窄窗口、侧栏收起的视觉验收。代码层面已静态检查 + 单测覆盖注册与凭据转发。
  - 请打开 **Plugins → Installed plugins → 配图素材库** 确认卡片出现；若要补截图，放到 `docs/` 并在 README 引用。
- **上游许标注可能不准**：分类基于 Openverse 的 `license` 字段与 Commons 的 extmetadata，上游标错无法自动发现；商业投放前仍应回原页面核对。
- **API Key 的三个 provider 未做真机验证**：本机没有 Pexels / Pixabay / Unsplash 的 Key，未实际调用它们的接口。请求构造、鉴权头、字段归一化有单测（基于官方文档字段），并整理了各家的额度与署名规则；用真实 Key 调用后请补充结论。
- **Windows / Linux 未验证**：安装脚本有 junction 与跨平台路径处理，但没有在 Windows 上实跑。

## 已知的验证边界

- 当前进程已通过停用/启用重新加载最终版代码，并用新 Agent 确认了最终版特征文案（`this looks like a pexels image URL ...`）；日常使用按常规重启即可。
- 结果缓存是进程内的（1 小时、1000 条）：**重启后再下载同一个 URL 会被拒绝**（`RIGHTS_UNVERIFIED`），需要重新 `stock_image_search`——这是有意的严格化，确保每次下载都带可核验的许可与署名。
- **DNS rebinding 窗口未封死**：`assertPublicHttpsUrl` 校验 DNS 后，`fetch` 会再次自行解析；一个第一次解析为公网、第二次为内网的域名存在 TOCTOU 窗口（剩余屏障：TLS 证书校验）。封死需要把校验过的 IP 固定注入连接层，属后续加固项。
- **搜索没有短期缓存**：同一 query 连续搜索会真实打到各图库（Openverse 匿名 20 次/分钟）；如需省配额请合并请求。
- **`fetchBuffer` 的 DNS 解析路径无离线单测**：`assertPublicHttpsUrl` 对「域名解析到私网地址」的分支依赖真实 DNS；测试覆盖了 IP 字面量（跳过 DNS）与私网地址分类表两段，中间的 lookup 过程只在真机冒烟中走过。
