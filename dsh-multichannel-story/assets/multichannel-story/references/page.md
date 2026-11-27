# 网页长文（guizang-page-skill）

## 流程

1. **落原文并留底**：`article.md` 保留全部正文（可拆段、加 `## ` 章节、加 `chart` 代码块，不删内容）。章节用 `## `，不要用 `###`（渲染器按 `## ` 分节并自动编号）。
   同目录另存一份未改动的 `article.orig.md` 作为底稿：下一步要改 `article.md`，没有它就 diff 不了、也回滚不了。**不要在没有留底的情况下就地覆盖用户原稿。**
2. **过 `humanizer-zh`**（默认第二步，不要跳过）：在 `article.md` 上按它的检查项删空泛抬高、伪洞察和无信息评价词；事实、数字、引文、判断、作者语气一律不动。改完给用户一段**简短说明**（改了哪几类、删了什么），按 humanizer-zh 自己的输出约定，不要附逐条命中清单。用户明确说「不要改文案」才略过，`article.orig.md` 照样保留。
3. **选风格与配色**：用用户在开跑前选的 `--style magazine|swiss --theme <id>`，**没有用户指定就不要按默认开跑**。两套骨架，配色见下表（id 与「歸藏设计」插件的 `themes.json` 同一套，颜色由插件按对比度算好，不要自己写色值）：

| 风格 | 主题 id | 名称 | 适合 |
| --- | --- | --- | --- |
<!-- mcs:themes:begin -->
| 杂志风 `magazine` | `ink-classic` | 墨水经典 | 通用分享、商业发布（page skill 自身默认） |
| | `indigo-porcelain` | 靛蓝瓷 | 科技/研究/数据、工程师文化 |
| | `forest-ink` | 森林墨 | 自然/可持续/文化/非虚构 |
| | `kraft-paper` | 牛皮纸 | 怀旧/人文/历史/独立杂志 |
| | `dune` | 沙丘 | 艺术/设计/时尚/画廊手册 |
| | `midnight-ink` | 午夜墨 | 深色主题：夜读、电影感、大片照片 |
| 瑞士风 `swiss` | `ikb` | 克莱因蓝 | 通用、AI/科技产品、设计领域 |
| | `lemon` | 柠檬黄 | 年轻/运动/零售/Y2K |
| | `lemon-green` | 柠檬绿 | 生态/健康/Z 世代品牌 |
| | `safety-orange` | 安全橙 | 工业/警示/汽车/发布会重点页 |

   没给 `--theme` 时由 render.mjs 用该风格的默认主题（杂志风 → `ink-classic`，瑞士风 → `ikb`）。
<!-- mcs:themes:end -->
   品牌色走 `--brand "#hex"`（杂志风会把彩度压到 0.12 以内，要鲜亮就用瑞士风）。
   这一套同时决定卡片 seed（`template-editorial-card` / `template-swiss-card`）、封面的 `data-theme` 和视频骨架的 `paper/ink/accent`。
4. **写 annotations**：用锚点文字算行号，**不要手工数行**。可用脚本片段：

```python
lines = open("article.md", encoding="utf-8").read().split("\n")
def find(sub, start=0):
    hits = [i + 1 for i, l in enumerate(lines) if sub in l and i + 1 >= start]
    assert len(hits) == 1, (sub, hits)
    return hits[0]
```

5. **升格组件**只从这些里选：`pullquote`（独立观点句）、`highlight`（核心判断/数字）、`def-card`（术语解释）、`checklist`（约束/风险清单）、`aside`（补充提示）、`summary-card`（并列案例/速查）、`embed`（内嵌 SVG 或 HTML 卡片）、`figure`（配图）、`drop`（文末 CTA/广告语）。
   - `figure`/`embed`/`aside`/`summary-card` 是**插入型**（`line` 指向插在哪一行之前，原文保留）；`pullquote`/`highlight`/`checklist`/`drop` 是**替换型**。
   - 行号打偏会渲染出重复段落——渲染后一定翻一遍。
6. **渲染 + 两条后处理**（`scripts/build-page.sh` 已内置；有品牌色时加 `--brand "#76B900"`，由插件生成受约束主题）：

```bash
# Windows（DSH Desktop）：node "<base>/scripts/mcs.mjs" page …
# macOS / Linux：bash "<base>/scripts/build-page.sh" …
node "<base>/scripts/mcs.mjs" page <项目目录> --embed \
  --cap-fig "jensen-portrait.jpg:660:840"
# 品牌色：
node "<base>/scripts/mcs.mjs" page <项目目录> --brand "#76B900" --out brand-page.html --embed
```

   - 删除页脚品牌署名 `<footer><p>归藏 Page · Built with constrained HTML</p></footer>`（用户要求：成稿不出现工具品牌）。
   - 竖幅人像按栏宽收窄：`max-width:660px; height:840px; object-fit:cover`，否则竖图会占满整屏。

   `--out` 的安全规则（渲染器会直接写到这个路径，写错就毁输入）：
   - 必须在项目目录内；不能用符号链接（链接可能指到源稿或项目外）；
   - 已存在的文件默认拒绝，确认覆盖项目内的普通文件才加 `--force`；
   - 不能指向 `article.md` / `annotations.json`。
   - `--cap-fig` 的文件名会被写进 HTML/CSS：不能含 `<`、`>`、控制字符或换行（否则会被拒绝）。

7. **导出**：

   `mcs page` 结束时会打印一段 **导出 argv（JSON 数组）**，例如：

   ```
   导出 argv（按数组直接执行，不要拼 shell 字符串）：["node","…/export.mjs","out.html","--pdf","out.pdf","--png","out-长图.png","--width","1240"]
   ```

   用这组参数按数组执行（不要复制成一行 shell 命令：项目名/文件名里可能有 `$(...)`、反引号或空格）。
   等价的手写形式：

```bash
node <page-skill>/scripts/export.mjs <out>.html --pdf <out>.pdf --png <out>-长图.png --width 1240
```

   长图有高度上限，脚本会自动降倍率；超过 12000px 的页面以 PDF 为主交付。

## 图片

- **原图分辨率必须大于显示尺寸**：网页图片显示宽约 920px（人物竖图 620–660px），源图宽 < 1000px 就会发虚。视频截帧（720p 竖屏）不要放大幅图。
- 图注要写：谁、在哪、什么时候、摄影/来源、许可。第一句会被渲染成粗体小标题。
- 许可写在文末 `## 图片来源与许可` 表格里；CC BY 要署名，CC BY-SA 要同协议，Unsplash/Pexels 要留摄影师链接。
- 不要用带水印、带手机 UI 的截图当正文配图；截图只做「证据」，并注明截取时间。

## 文案口径（本 skill 的默认偏好）

- 外文推文：做成**中文译文卡**（原文行 + 中文正文 + 账号/时间/互动量），不要直接贴英文截图。若用户给了参考样式，按参考样式排。
- 图注、说明卡不写「读者可以…」「本文将…」这类编辑说明；只写事实。
- 正文过 `humanizer-zh`：删空泛抬高与伪洞察，保留事实、判断与作者语气。

## 验收

- 图片全部加载（浏览器里检查 `document.images` 的 `naturalWidth > 0`）。
- 桌面 1440px、移动 390px 各看一遍；TOC 可开合。
- 无重复段落（升格行号错位的典型症状）。
- 页面结尾没有工具品牌页脚。
- 导出 PDF 页数与长图高度合理，无整页空白。
