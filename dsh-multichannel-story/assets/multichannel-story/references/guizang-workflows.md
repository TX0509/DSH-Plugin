# 与「歸藏设计」插件的内容工作流配合

插件（`dsh-guizang-design`）自带 4 个 skill 和 6 个**内容工作流**（recipes）。工作流是跨 skill 的常用组合：用户在插件页面点「使用工作流」，DSH 会把一条以 `/skill 名` 开头的草稿发到新对话里。

**本 skill 不重复实现这些工作流**，而是：
1. 运行时读取插件当前的定义，按用户要的产物选一条（或组合）；
2. 按那条工作流的 `steps` 顺序执行；
3. 只补插件之外的环节：环境自检、真实素材与配图、去 AI 味把关、抖音视频与配音、验收与交付。

## 先读运行时定义（会随插件版本变）

```bash
node scripts/list-recipes.mjs          # 人读
node scripts/list-recipes.mjs --json   # 机器读：id/title/summary/steps/prompt
node scripts/list-recipes.mjs --lang en
```

硬编码会过期：条目增减、文案微调都以 `list-recipes.mjs` 当次输出为准；和本文不一致时按运行时执行并告诉用户。

## 当前 6 个工作流（v0.1.4 实测）

| id | 名称 | steps | 什么时候走它 | 本 skill 叠加什么 |
| --- | --- | --- | --- | --- |
| `one-article-three-outputs` | 一篇文章，三种出口 | page → social-card | 要网页 + 小红书 + 公众号封面（**主链路**） | 视频分支、配音、素材、验收 |
| `humanize-then-typeset` | 先去 AI 味，再排版 | humanizer-zh → page | 用户在意文风 / 稿件有明显 AI 味 | 改稿清单给用户过目；卡片文案同步去 AI 味 |
| `talk-to-article` | 演讲回收 | page → humanizer-zh | 手上是 PPT/讲稿，要成文 | 视频（可用同一套内容做口播短片） |
| `brand-kit` | 品牌套件 | ppt → social-card | 有品牌色，要发布会物料 | **已实跑**：网页/卡片/视频统一用插件生成的品牌主题，见下方「品牌套件怎么落地」 |
| `cover-matrix` | 封面矩阵 | social-card | 只要封面三件套（21:9 + 1:1 + 3:4） | 见下方「冲突处理」：默认不出配对预览与尺寸标注 |
| `bilingual` | 中英双版本 | page | 要中英两版网页 | 两版各渲染一份；卡片/视频如需双语另议 |

## 两种进入方式

**A. 用户自己点了工作流**：消息以 `/guizang-page-skill …` 之类开头，或直接贴了工作流原文。
→ 立刻按消息里点名的 skill 加载它，按 steps 顺序做；本 skill 只补第 1/4/5 步（自检、素材、视频、验收）。不要重新发明流程。

**B. 用户只是说需求**（「这篇文章做成网页+小红书+公众号，顺便来个抖音」）
→ 先 `list-recipes.mjs`，按下表匹配；用工作流的步骤与约束作为意图基准，再叠加视频分支。

| 用户要的产物 | 走的路径 |
| --- | --- |
| 网页 + 小红书 + 公众号 | `one-article-three-outputs` + 本 skill 第 3–6 步 |
| 网页 + 小红书 + 公众号 + 抖音视频 | 同上 + 第 5 步（视频与配音） |
| 只有封面（21:9 / 1:1 / 3:4） | `cover-matrix` |
| 只有小红书 3:4 组图 | `guizang-social-card-skill` 直接做（不经工作流） |
| 只有网页 | `guizang-page-skill` 直接做 |
| 稿件需要先改文风 | `humanize-then-typeset`（改完把主要改动列给用户确认，再排版） |
| PPT/讲稿要成文 | `talk-to-article` |
| 有品牌色 | `brand-kit`（品牌主题贯穿网页/卡片/视频） |
| 要中英两版 | `bilingual` |

## 品牌套件怎么落地（已实测）

品牌色**不要**直接写进 CSS，交给插件的受约束主题流程（杂志风会压彩度到 0.12 以内，瑞士风保留鲜度）：

```bash
MCS="node <base>/scripts/mcs.mjs"       # Windows；macOS/Linux 可用对应 .sh 薄壳

# 1) 生成 + 注入卡片/网页
$MCS brand "#76B900" --family magazine --apply cards/index.html
$MCS brand "#76B900" --family magazine   # 只看生成的 CSS 块

# 2) 网页：直接交给 page skill 的品牌流程
$MCS page . --brand "#76B900" --out brand-page.html --embed

# 3) 视频：把同一套 token 喂给骨架
$MCS brand "#76B900" --tokens
# → {"paper":"#edefec","ink":"#102000","accent":"#618836"}
# 写进 scenes.json 的 "theme"，再 scaffold-video.py（照片压暗会自动用主题墨色）
```

实测结果（#76B900）：卡片 3/3 PASS、网页 `data-theme="brand"` 生效（accent #618836）、视频骨架 check 0 error 0 warning。

## 冲突处理（用户偏好优先）

插件的默认提示词里有几条与本用户偏好相反，按后者执行并在交付说明里提一句：

| 插件默认 | 本用户偏好 |
| --- | --- |
| 封面矩阵「配对预览也出一张」 | **不出**配对预览（带尺寸标签的 QA 图不是交付物）；用户明确要才出 |
| 成图上标比例/尺寸（`.poster.wide 2100×900` 之类） | 画面上**不写**比例与像素尺寸 |
| 页面底部保留工具品牌页脚 | 删除 `归藏 Page · Built with constrained HTML` |
| 视频可静音 | **必须有声**，自然男声（见 `voice.md`） |
| 可交付未核实的配图 | 不用模糊图（原图分辨率必须大于显示尺寸） |

## 组合示例（用户要全套）

```
1) node <base>/scripts/list-recipes.mjs     → 确认 one-article-three-outputs 仍在
2) mcs preflight --page --cards [--video]   → 装齐本次要用的依赖
3) /humanizer-zh 过稿（改动清单给用户）      → 事实/立场不动
4) guizang-page-skill：article.md + annotations.json + `mcs page`
5) guizang-social-card-skill：seed 模板 + `mcs cards` + 校验
6) 视频（可选）：create_project → import → scaffold-video.py → tts.py → complete/export
7) 验收：checklist.md + `mcs verify`（有视频时）+ present + library_add
```
