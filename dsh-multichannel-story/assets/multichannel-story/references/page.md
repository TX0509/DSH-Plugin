# 网页长文（guizang-page-skill）

## 流程

1. **落原文**：`article.md` 保留全部正文（可拆段、加 `## ` 章节、加 `chart` 代码块，不删内容）。章节用 `## `，不要用 `###`（渲染器按 `## ` 分节并自动编号）。
2. **选风格**：默认杂志风（`--style magazine --theme indigo-porcelain`）；叙事/财经/科技长文用杂志风，工程/数据/发布说明可用瑞士风。
3. **写 annotations**：用锚点文字算行号，**不要手工数行**。可用脚本片段：

```python
lines = open("article.md", encoding="utf-8").read().split("\n")
def find(sub, start=0):
    hits = [i + 1 for i, l in enumerate(lines) if sub in l and i + 1 >= start]
    assert len(hits) == 1, (sub, hits)
    return hits[0]
```

4. **升格组件**只从这些里选：`pullquote`（独立观点句）、`highlight`（核心判断/数字）、`def-card`（术语解释）、`checklist`（约束/风险清单）、`aside`（补充提示）、`summary-card`（并列案例/速查）、`embed`（内嵌 SVG 或 HTML 卡片）、`figure`（配图）、`drop`（文末 CTA/广告语）。
   - `figure`/`embed`/`aside`/`summary-card` 是**插入型**（`line` 指向插在哪一行之前，原文保留）；`pullquote`/`highlight`/`checklist`/`drop` 是**替换型**。
   - 行号打偏会渲染出重复段落——渲染后一定翻一遍。
5. **渲染 + 两条后处理**（`scripts/build-page.sh` 已内置；有品牌色时加 `--brand "#76B900"`，由插件生成受约束主题）：

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

6. **导出**：

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
