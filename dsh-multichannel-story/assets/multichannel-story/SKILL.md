---
name: multichannel-story
description: 把一篇文章、一份素材或一个选题，一次性做成多平台成品：精排网页长文（杂志风）+ 小红书图文卡片 + 公众号封面（21:9 主封面与 1:1 分享卡），并可选择追加一条抖音竖屏短视频（含自然男声旁白）。当用户说「把这篇排版成网页」「做成小红书图文」「出公众号封面」「顺便剪个抖音视频」「一条内容分发多平台」「做个内容三件套」，或一次性要网页+卡片+视频时使用。依赖歸藏设计插件、OpenMotion、ego-browser、图库工具和 edge-tts 语音链路，开跑前必须先做环境自检。
license: MIT
metadata:
  author: DSH session multichannel-story
  version: "1.0.0"
---

# 多平台内容流水线（网页长文 → 小红书 / 公众号 → 抖音短视频）

这个 skill 是把一次真实交付沉淀下来的流程：一篇长文 → 一个精排网页、一组小红书卡片、一对公众号封面，可选再出一条带男声旁白的抖音竖屏视频，全部共用同一套主题与素材。

它的价值在**顺序和约束**：先定主题与素材 → 再写页面 → 卡片/封面复用同一套视觉 → 视频复用同一批图与同一套文案；声音默认必须有，配音用自然男声。

## 交付物

```
<项目目录>/
  article.md  annotations.json  <标题>.html  <标题>.pdf  <标题>-长图.png
  assets/figs/…                  ← 页面与卡片共用素材
  cards/index.html  cards/output/xhs-01-cover.png …  wechat-21x9.png  wechat-1x1.png
  video/index.html  video/compositions/s1…sN.html  video/audio/vo.mp3
  <标题>-抖音竖版.mp4            ← 仅当用户要视频
  <标题>-抖音发布文案.md          ← 仅当用户要视频
```

## 先选路径：对齐「歸藏设计」插件的 6 个工作流

插件自带 6 条内容工作流（一篇文章三种出口 / 先去 AI 味再排版 / 演讲回收 / 品牌套件 / 封面矩阵 / 中英双版本）。**不重复实现它们**，而是运行时读定义、按产物选一条、按它的 steps 执行，本 skill 只补插件之外的环节（自检、素材、配音、视频、验收）。

```bash
node "<base>/scripts/list-recipes.mjs"          # 看当前装了哪些工作流（会随插件版本变）
node "<base>/scripts/list-recipes.mjs" --json   # id / title / steps / prompt
```

- 用户**已经点了工作流**（消息以 `/guizang-page-skill …` 之类开头）：直接按点名的 skill 与 steps 做，本 skill 只补后续步骤，不重新发明流程。
- 用户**只说需求**：先跑上面的命令，按下表匹配。

| 用户要的产物 | 走哪条 |
| --- | --- |
| 网页 + 小红书 + 公众号 | `one-article-three-outputs`（本 skill 主链路） |
| 以上 + 抖音视频 | 同上，再叠加本 skill 第 5 步（视频与配音） |
| 只要封面（21:9 / 1:1 / 3:4） | `cover-matrix` |
| 只要网页 / 只要 3:4 组图 | 直接用 `guizang-page-skill` / `guizang-social-card-skill` |
| 先改文风再排版 | `humanize-then-typeset`（改动清单先给用户确认） |
| PPT/讲稿成文 | `talk-to-article` |
| 有品牌色 | `brand-kit`（品牌主题贯穿网页/卡片/视频） |
| 中英两版 | `bilingual` |

**冲突时用户偏好优先**：不出带尺寸的配对预览、成图上不写比例尺寸、删工具品牌页脚、视频必须有声且自然男声。详见 `references/guizang-workflows.md`。

有品牌色就走 `brand-kit`：`mcs brand` 生成受约束主题（不要手写颜色值），网页用 `mcs page --brand`，卡片用 `mcs brand --apply` 注入，视频用 `mcs brand --tokens` 喂给骨架。

## 开跑前：环境自检（强制）

本 skill 的脚本都在**本 skill 目录**下的 `scripts/`（加载时 `<skill_resources>` 里给出的 `Base directory` 就是它）。通过 DSH 插件 `dsh-multichannel-story` 加载时，这个目录在插件包内（`<插件目录>/assets/multichannel-story/`）。

**下文用 `mcs` 代指这个命令行，务必带上绝对 base 目录**：

```bash
# Windows（DSH Desktop，优先）——不要用 bash，那里的 bash 常常是 WSL
node "<Base directory>/scripts/mcs.mjs" <子命令> …

# macOS / Linux：.sh 只是同一个 mcs.mjs 的薄壳，两种写法等价
bash "<Base directory>/scripts/preflight.sh" --page --cards
```

1. 跑自检（按本次要做的产物加参数）。它逐项打印 OK / MISSING：
   - 只要网页 + 卡片：`mcs preflight --page --cards`
   - 还要视频：`mcs preflight --page --cards --video`
   - 要抓真实网页/推文截图再补 `--images`（**别默认加 `--all`**，那会把用不到的依赖也判成缺失）
2. 有 MISSING：按 `references/setup.md` 里的命令安装。DSH 插件用 `plugin_manager` 安装/启用，用户级 skill 装到 `~/.agents/skills/`，运行时依赖用 pip / brew / winget / npm。
3. **装不上就停下来说明缺什么、影响哪一步**，不要用降级方案硬做（静音成片、纯文字卡片都不算交付）。唯一例外：用户明确同意后可用 macOS `say` 兜底配音，必须在交付说明里写明这是降级。
4. 装完依赖后，新装的 DSH 插件或 skill 可能需要重启会话才会出现在技能目录里——告知用户，不要假装已经可用。

### 平台差异（Windows / Desktop 必读）

| 要做的事 | 统一写法（两平台都行） | macOS / Linux 也可写 |
| --- | --- | --- |
| 自检 | `node <base>/scripts/mcs.mjs preflight --page --cards` | `bash <base>/scripts/preflight.sh --page --cards` |
| 网页 | `node <base>/scripts/mcs.mjs page <目录> …` | `bash <base>/scripts/build-page.sh <目录> …` |
| 卡片 | `node <base>/scripts/mcs.mjs cards <目录> …` | `bash <base>/scripts/build-cards.sh <目录> …` |
| 品牌主题 | `node <base>/scripts/mcs.mjs brand "#76B900" …` | `bash <base>/scripts/brand-theme.sh "#76B900" …` |
| 视频工程校验 | `node <base>/scripts/mcs.mjs check <工程目录>` | 同左 |
| 成片核查 | `node <base>/scripts/mcs.mjs verify <file.mp4> …` | `bash <base>/scripts/verify-av.sh <file.mp4> …` |

python 脚本（`tts.py`、`scaffold-video.py`）跨平台用：Windows 上写 `py -3 <base>/scripts/tts.py …`。各子命令都支持 `--help`。



按需检查，别要求用户装用不到的：

| 产物 | 必需 |
| --- | --- |
| 网页长文 | 歸藏设计插件（guizang-page-skill）、node |
| 小红书 / 公众号封面 | 歸藏设计插件（guizang-social-card-skill）、playwright（插件自带） |
| 抖音视频 | OpenMotion（MCP 工具 + 本机 Studio）、ffmpeg/ffprobe、python `edge-tts` |
| 真实素材/推文截图 | ego-browser（skill + CLI） |
| 免费图库配图 | dsh-stock-images |
| 需要生成配图 | dsh-image-gen（非必要不生成） |

## 第一步：一次问清三件事

用 `ask_user_question` 一口气问完，不要分批打断：

1. **要哪些产物**（多选）：网页长文 / 小红书图文 / 公众号封面（21:9+1:1）/ 抖音竖屏短视频。默认给出「网页 + 小红书 + 公众号」。
   同时说明可选的工作流路径（一篇文章三种出口 / 先去 AI 味再排版 / 封面矩阵 / 品牌套件 / 中英双版本 / 演讲回收），用户点名哪条就按哪条的 steps 走。
2. **视频音色**（选了视频才问）：把 `references/voice.md` 的音色表列出来让用户选 —— 云健（成熟男声·纪实，默认）/ 云扬（新闻男声·稳）/ 云希（年轻男声·轻快）/ 云夏（少年音）/ 自带录音。同时问一句是否要配乐（默认只做旁白）。
3. **素材口径**：用户自己有图 / 允许抓公开素材（ego-browser + 图库）/ 允许 AI 生成（非必要不生成）。

顺带确认：主题风格（默认杂志风·靛蓝瓷）、是否需要中文译文（外文素材/推文默认译成中文）、发布平台规格。

## 第二步：事实与文案

- 数字、日期、引文、归属必须来自用户材料；不要补造。外部新闻类素材先用 `web_search` / ego-browser 核实再写。
- 所有要署用户名字的正文与卡片文案，**过一遍 `humanizer-zh`**（"去除 AI 味"）：删空泛抬高（堪称/彰显/惊天反转/一针见血）、删伪洞察、删无信息的评价词，保留事实、判断、语气和标题。原文是用户自己写的，只改空话，不改立场。
- 用户明确过的文案偏好见 `references/copy-and-images.md`（不要模糊配图、外文推文做中文译文卡、成图上不要尺寸/比例标注、页面不要工具品牌页脚）。

## 第三步：网页长文（guizang-page-skill）

按 `references/page.md` 执行，核心是「模型写 annotations，脚本确定性渲染」：

1. 原文原样落到 `article.md`（可拆段、可加图表块，不删内容）。
2. 用脚本按锚点文字算行号生成 `annotations.json`（不要手工数行号）。
3. `mcs page <项目目录> --out <标题>.html [--brand "#76B900"] [--cap-fig "文件名:660:840"]` 渲染 + 注入两条必要后处理：竖幅人像按栏宽收窄、删除页脚 `归藏 Page · Built with constrained HTML`。两条都会核对是否真的生效（页脚还在、或没有 `</head>` 插不进 CSS 就直接失败），`--out` 只接受 `.html` 且不能指向 `article.md` / `annotations.json`。
4. 打开验证（图片加载、目录、移动端 390px），再导出 PDF 与长图（命令末尾会打印 export.mjs 的完整调用）。

## 第四步：小红书 + 公众号封面（guizang-social-card-skill）

按 `references/cards.md`：拷贝 seed 模板 → 规划 6–9 张 3:4 → `mcs cards <任务目录>` 渲染（无 index.html 时会先放 seed 模板）→ 看 PNG 逐张自检 → `validate-social-deck` 跑到 0 fail。

硬性约束：3:4 内容覆盖 ≥75% 画布高度；标题不贴边不撞页脚；中文不斜体；**画面上不写比例与像素尺寸**（不写 `21:9`、`2100×900`、`1:1`），也不产出带尺寸标签的配对预览图。

## 第五步：抖音竖屏视频（OpenMotion，可选）

按 `references/video.md`。要点：

1. 先调 `openmotion_get_project()` **验证 MCP 连接**（脚本查不到这一项）：能返回 `dataDirectory` 才算连上；连不上就先修连接，别硬写工程。然后 `openmotion_create_project`（natural_language，requirements 写清规格与声音要求）。
2. `openmotion_import_assets` 导入图片与（若已有）旁白音频；素材名用中文内容名。
3. 用 `py -3 <base>/scripts/scaffold-video.py --dir <工程目录> --scenes scenes.json`（macOS/Linux 用 `python3`）生成「根合成 + 每场一个子合成」的骨架（Studio 校验要求子合成，单文件嵌套会被判 error），再逐场改造。
4. 旁白：按 `references/voice.md` 用 `py -3 <base>/scripts/tts.py spec.json --out vo.mp3` 生成并混音（逐句按场次起点延时，句间留停顿，−16 LUFS / 真峰 −1.5 dB）。
5. 本地校验：`mcs check <工程目录>` 必须 0 error（它从 OpenMotion 的 `install.json` 找到 hyperframes CLI，不用猜路径；CLI 输出无法解析时按失败退出；Studio 的 lint 比 CLI 更严，CLI 通过不等于能过 `complete_generation`）。然后 `complete_generation` → `open_preview` → `export_request(audio: "required")` → 等完成。
6. 导出后用 `mcs verify <mp4> --expect-audio required --expect-dur <秒>` 复核：音轨存在、时长、响度、语句落点，并从成品抽帧核对画面。

## 第六步：验收与交付

- 跑 `references/checklist.md`；图片许可与来源写进页面「图片来源与许可」表和卡片 `assets/SOURCES.md`。
- 用 `present` 交付关键文件；用 `guizang_library_add` 把网页和卡片登记进作品库（同一条内容的多平台产物可以分别登记，便于以后「做同风格的下一份」）。
- 交付说明里写清：产物路径、规格、配音音色、素材许可、以及未验证项（例如宿主不支持编辑器面板时，成片仍按文件验证交付）。

## 不要做的事

- 不要在没做环境自检的情况下开跑，也不要承诺未安装的工具能力。
- 不要在 Windows / DSH Desktop 上用 `bash` 跑脚本（那是 WSL，路径和 python 环境都不同），统一用 `node <base>/scripts/mcs.mjs <子命令>`。
- 装了 `dsh-multichannel-story` 插件时不要再跑 `scripts/install.sh`（会往 `~/.agents/skills` 拷一份高优先级副本，顶掉插件版本）。
- 不要用静音成片交差（用户已明确：所有视频必须有声音，自然男声，避免机械念稿）。
- 不要用视频截帧/低分辨率图做大幅配图（原图分辨率应大于显示尺寸）。
- 不要改动用户文章的立场与事实，只为去空话而编辑。
- 不要为了「更丰富」编造数据、来源、互动量或专家意见。
- 不要在成图上留工具品牌页脚、比例尺寸、制作术语。

## 参考文件

| 文件 | 内容 |
| --- | --- |
| `references/setup.md` | 每个依赖的安装/启用/验证命令与常见故障 |
| `references/page.md` | 网页长文完整流程、annotations 生成、图注与许可表 |
| `references/cards.md` | 卡片/封面流程、seed 模板、无尺寸标注规则 |
| `references/video.md` | OpenMotion 工程结构、Studio 校验坑、导出与验收 |
| `references/voice.md` | 音色目录、TTS 混音参数、兜底方案 |
| `references/copy-and-images.md` | 去 AI 味清单、用户文案偏好、素材来源与署名 |
| `references/guizang-workflows.md` | 插件 6 个工作流的 id/steps/组合规则与冲突处理 |
| `references/checklist.md` | 交付前检查表 |

脚本：

| 脚本 | 用途 |
| --- | --- |
| `scripts/mcs.mjs` | 跨平台命令行（`preflight` / `page` / `cards` / `brand` / `check` / `verify`），几个 `.sh` 都转发到这里 |
| `scripts/page-post.mjs` | 网页后处理（删工具页脚、收窄竖图），由 `mcs page` 调用；纯函数，单独可测 |
| `scripts/preflight.sh` | 环境自检（按需检查） |
| `scripts/list-recipes.mjs` | 读插件当前的工作流列表（运行时，不硬编码） |
| `scripts/brand-theme.sh` | 生成品牌主题并注入 HTML / 输出视频用的 paper/ink/accent |
| `scripts/build-page.sh` | 渲染网页 + 注入人像收窄与去页脚 |
| `scripts/build-cards.sh` | 渲染卡片 + 跑校验 |
| `scripts/tts.py` | 多句 TTS + 延时混音成一条音轨 |
| `scripts/scaffold-video.py` | 生成「根合成 + 子合成」视频骨架 |
| `scripts/verify-av.sh` | 成片音轨/画幅/响度/语句落点复核 |
