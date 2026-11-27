---
name: multichannel-story
description: 把一篇文章、一份素材或一个选题，一次性做成多平台成品：精排网页长文（杂志风或瑞士风，配色在开工前选）+ 小红书图文卡片 + 公众号封面（21:9 主封面与 1:1 分享卡），并可选择追加一条抖音竖屏短视频（含自然男声旁白）。当用户说「把这篇排版成网页」「做成小红书图文」「出公众号封面」「顺便剪个抖音视频」「一条内容分发多平台」「做个内容三件套」，或一次性要网页+卡片+视频时使用。依赖歸藏设计插件、OpenMotion、ego-browser、图库工具和 edge-tts 语音链路，开跑前必须先做环境自检。
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
  article.md  article.orig.md  annotations.json  <标题>.html  <标题>.pdf  <标题>-长图.png
  （article.orig.md 是去 AI 味前的原始稿，留底供 diff / 回滚；只在项目目录里，不属于交付物）
  assets/figs/…                  ← 页面与卡片共用素材
  cards/index.html  cards/output/xhs-01-cover.png …  wechat-21x9.png  wechat-1x1.png
  video/index.html  video/compositions/s1…sN.html  video/audio/vo.mp3
  <标题>-抖音竖版.mp4            ← 仅当用户要视频
  <标题>-抖音发布文案.md          ← 仅当用户要视频
```

## 先选路径：对齐「歸藏设计」插件的 6 个工作流

插件自带 6 条内容工作流（一篇文章三种出口 / 先去 AI 味再排版 / 演讲回收 / 品牌套件 / 封面矩阵 / 中英双版本）。**不重复实现它们**，而是运行时读定义、按产物选一条、按它的 steps 执行，本 skill 只补插件之外的环节（自检、素材、配音、视频、验收）。其中「先去 AI 味再排版」（`humanize-then-typeset`）是**网页产物的默认路径**，不是可选项。

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
| 只要网页 | **`humanize-then-typeset`** 是默认：先 `humanizer-zh` 过稿，再 `guizang-page-skill`；用户明确说不要改文案才直接排版 |
| 只要 3:4 组图 | `guizang-social-card-skill` 直接做；文案沿用同一份去 AI 味后的文本，即使这次没有网页阶段也要先过一遍 |
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
| 抖音视频 | OpenMotion（MCP 工具 + 本机 Studio）、ffmpeg/ffprobe、python `edge-tts`（python 只有视频链路需要；`--page --cards` 缺 python 不算 MISSING） |
| 第二步去 AI 味 | 歸藏设计插件（humanizer-zh）；缺了就**先说明这一步做不了**，再问用户是否照排，不要静默跳过 |
| 真实素材/推文截图 | ego-browser（skill + CLI） |
| 免费图库配图 | dsh-stock-images |
| 需要生成配图 | dsh-image-gen（非必要不生成） |

## 第一步：一次问清四件事

用 `ask_user_question` 一口气问完，不要分批打断：

1. **要哪些产物**（多选）：网页长文 / 小红书图文 / 公众号封面（21:9+1:1）/ 抖音竖屏短视频。默认给出「网页 + 小红书 + 公众号」。
   默认就走「先去 AI 味再排版」（`humanize-then-typeset`），不用征询；提问时顺带说一句「默认先过一遍文案再排版」，除非用户已经说过不要改文案。其余可选工作流：一篇文章三种出口 / 封面矩阵 / 品牌套件 / 中英双版本 / 演讲回收，用户点名哪条就按哪条的 steps 走。
2. **视频音色**（选了视频才问）：把 `references/voice.md` 的音色表列出来让用户选 —— 云健（成熟男声·纪实，默认）/ 云扬（新闻男声·稳）/ 云希（年轻男声·轻快）/ 云夏（少年音）/ 自带录音。同时问一句是否要配乐（默认只做旁白）。
3. **素材口径**：用户自己有图 / 允许抓公开素材（ego-browser + 图库）/ 允许 AI 生成（非必要不生成）。
4. **风格与配色**（不预设，必须让用户选）：两段问，先风格再配色。
   <!-- mcs:themes:begin -->
   - 杂志风 `magazine`：`ink-classic` 墨水经典 / `indigo-porcelain` 靛蓝瓷 / `forest-ink` 森林墨 / `kraft-paper` 牛皮纸 / `dune` 沙丘 / `midnight-ink` 午夜墨
   - 瑞士风 `swiss`：`ikb` 克莱因蓝 / `lemon` 柠檬黄 / `lemon-green` 柠檬绿 / `safety-orange` 安全橙
   <!-- mcs:themes:end -->
   - 可以随选项附一句适配说明（例如技术/数据长文配靛蓝瓷、发布说明配克莱因蓝），但**不要替用户决定，也不要因为「用户没说」就按某个默认风格开跑**。
   - 用户已在指令里写明风格或主题（`--style swiss --theme ikb`、「瑞士风·克莱因蓝」都算）就照做，不再问这一项。

这套风格与配色会贯穿网页、卡片 seed、封面和视频 token，改一处就等于全都改。

顺带确认：是否需要中文译文（外文素材/推文默认译成中文）、发布平台规格。

## 第二步：事实与文案（先过 `humanizer-zh`，默认不跳过）

- 数字、日期、引文、归属必须来自用户材料；不要补造。外部新闻类素材先用 `web_search` / ego-browser 核实再写。
- 所有要署用户名字的正文与卡片文案，**先加载 `humanizer-zh`**（"去除 AI 味"，这是默认第一步）：删空泛抬高（堪称/彰显/惊天反转/一针见血）、删伪洞察、删无信息的评价词，保留事实、判断、语气和标题。原文是用户自己写的，只改空话，不改立场。改写只落在 `article.md` 上，动手前先把未改动的原文另存为 `article.orig.md`。改完给用户一段**简短说明**（改了哪几类、删了什么），不要附逐条命中清单；用户明确说「不要改文案」才略过。
- 用户明确过的文案偏好见 `references/copy-and-images.md`（不要模糊配图、外文推文做中文译文卡、成图上不要尺寸/比例标注、页面不要工具品牌页脚）。

## 第三步：网页长文（guizang-page-skill）

按 `references/page.md` 执行，核心是「模型写 annotations，脚本确定性渲染」：

1. `article.md` 已是去 AI 味后的正文（原始稿 `article.orig.md` 在第二步留好，不要覆盖它）；落盘只做分段与图表块，不删内容。
2. 用脚本按锚点文字算行号生成 `annotations.json`（不要手工数行号）。
3. `mcs page <项目目录> --out <标题>.html [--style magazine|swiss] [--theme <主题 id>] [--brand "#76B900"] [--cap-fig "文件名:660:840"]` 渲染 + 注入两条必要后处理：竖幅人像按栏宽收窄、删除页脚 `归藏 Page · Built with constrained HTML`。两条都会核对是否真的生效（页脚还在、或没有 `</head>` 插不进 CSS 就直接失败）。
   `--out` 的安全规则：必须是项目目录内的 `.html`、不能指向 `article.md` / `annotations.json`、不能是符号链接、已存在的文件默认拒绝（确认覆盖项目内普通文件才加 `--force`）；`--cap-fig` 的文件名不能含 `<`、`>`、控制字符或换行。
4. 打开验证（图片加载、目录、移动端 390px），再导出 PDF 与长图。**导出用 `mcs page` 末尾打印的 argv（JSON 数组）按数组执行，不要把它拼成一行 shell 命令**（项目名/文件名里可能有 `$(...)`、反引号或空格）。

## 第四步：小红书 + 公众号封面（guizang-social-card-skill）

按 `references/cards.md`：按用户选的风格拷对应 seed（杂志风 `template-editorial-card.html` / 瑞士风 `template-swiss-card.html`），`<html data-theme>` 与网页保持一致 → 规划 6–9 张 3:4 → `mcs cards <任务目录>` 渲染 → 看 PNG 逐张自检 → `validate-social-deck` 跑到 0 fail。

`mcs cards` 的退出码要按事实理解：`0` 才是渲染+校验都过；`3` 表示只拷了 seed 模板、还没渲染（不算交付）；`1` 表示画面上有比例/尺寸标注、`output/` 里没有 PNG、或校验器没跑起来/校验有 FAIL。`--allow-labels` 只在确认标注必须保留时用。

硬性约束：3:4 内容覆盖 ≥75% 画布高度；标题不贴边不撞页脚；中文不斜体；**画面上不写比例与像素尺寸**（不写 `21:9`、`2100×900`、`1:1`），也不产出带尺寸标签的配对预览图。

## 第五步：抖音竖屏视频（OpenMotion，可选）

按 `references/video.md`。要点：

1. 先调 `openmotion_get_project()` **验证 MCP 连接**（脚本查不到这一项）：能返回 `dataDirectory` 才算连上；连不上就先修连接，别硬写工程。然后 `openmotion_create_project`（natural_language，requirements 写清规格与声音要求）。
2. `openmotion_import_assets` 导入图片与（若已有）旁白音频；素材名用中文内容名。
3. 先写 `scenes.json` 定分镜（id 唯一、首场 `start=0`、末场不超过总时长）。
4. 旁白：按 `references/voice.md` 用 `py -3 <base>/scripts/tts.py spec.json --out vo.mp3` 生成并混音（`total_duration` 必填、逐句按场次起点延时、句间 ≥0.2s、−16 LUFS / 真峰 −1.5 dB；单句失败会自动重试，最终失败会指出第几句）→ 导入音频 → 在 `scenes.json` 写 `voice.src`（**工程内相对路径**，绝对路径 / `../` 会被拒绝）。
5. 用 `py -3 <base>/scripts/scaffold-video.py --dir <工程目录> --scenes scenes.json`（macOS/Linux 用 `python3`）生成「根合成 + 每场一个子合成」的骨架（Studio 校验要求子合成，单文件嵌套会被判 error），再逐场改造。脚本会先全量校验再写文件（失败不留半个工程），`<audio>` 由它写入、不要手写；骨架已存在时重跑要 `--force`。
6. 本地校验：`mcs check <工程目录>` 必须 0 error。CLI 按 `HYPERFRAMES_CLI` → `install.json` → `$DSH_HOME/profiles/<profile>/openmotion-onboarding.json` → 已知目录 的顺序发现，成功时会打印来源；CLI 输出无法解析时按失败退出；Studio 的 lint 比 CLI 更严，CLI 通过不等于能过 `complete_generation`。然后 `complete_generation` → `open_preview` → `export_request(audio: "required")` → 等完成。
7. 导出后用 `mcs verify <mp4> --expect-audio required --expect-dur <秒> --expect-cues scenes.json` 复核：分辨率/帧率（29.97 用浮点容差）、时长、音轨、积分响度与真峰（默认 −16 LUFS ±1、真峰 ≤ −1.0 dBTP）、语句落点（容差 0.4s），并从成品抽帧核对画面。**不给 `--expect-cues` 时它只会说「未校验语句落点」**，不要把那当成已核对。

## 第六步：验收与交付

- 跑 `references/checklist.md`；图片许可与来源写进页面「图片来源与许可」表和卡片 `assets/SOURCES.md`。
- 用 `present` 交付关键文件；用 `guizang_library_add` 把网页和卡片登记进作品库（同一条内容的多平台产物可以分别登记，便于以后「做同风格的下一份」）。
- 交付说明里写清：产物路径、规格、配音音色、素材许可、以及未验证项（例如宿主不支持编辑器面板时，成片仍按文件验证交付）。

## 不要做的事

- 不要在没做环境自检的情况下开跑，也不要承诺未安装的工具能力。
- 不要在 Windows / DSH Desktop 上用 `bash` 跑脚本（那是 WSL，路径和 python 环境都不同），统一用 `node <base>/scripts/mcs.mjs <子命令>`。
- 装了 `dsh-multichannel-story` 插件时不要再跑手册里的 `scripts/install.sh`（本插件包**不含**它；那个脚本会往 `~/.agents/skills` 拷一份 rank 500 的副本，优先级高于插件的 600，顶掉插件版本）。
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
| `scripts/mcs.mjs` | 跨平台命令行（`preflight` / `page` / `cards` / `brand` / `check` / `verify`），几个 `.sh` 都转发到这里；各子命令 `--help` 列全部参数 |
| `scripts/page-post.mjs` | 网页后处理（删工具页脚、收窄竖图），由 `mcs page` 调用；纯函数，单独可测 |
| `scripts/preflight.sh` | 环境自检（按需检查） |
| `scripts/list-recipes.mjs` | 读插件当前的工作流列表（运行时，不硬编码） |
| `scripts/brand-theme.sh` | 生成品牌主题并注入 HTML / 输出视频用的 paper/ink/accent |
| `scripts/build-page.sh` | 渲染网页 + 注入人像收窄与去页脚 |
| `scripts/build-cards.sh` | 渲染卡片 + 跑校验 |
| `scripts/tts.py` | 多句 TTS + 延时混音成一条音轨 |
| `scripts/scaffold-video.py` | 生成「根合成 + 子合成」视频骨架 |
| `scripts/verify-av.sh` | 成片音轨/画幅/响度/语句落点复核（转发到 `mcs verify`） |
