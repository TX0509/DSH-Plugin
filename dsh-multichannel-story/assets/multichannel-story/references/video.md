# 抖音竖屏短视频（OpenMotion / HyperFrames）

## 目标规格（抖音）

- `1080×1920` / `30fps` / 30–45s，H.264 + AAC 48kHz。
- 顶部 168px（状态/搜索栏）、底部 590px（文案/按钮）**不放正文**；正文落在 168–1330px 内。底部只放装饰（进度条、纹理）。
- 第 0 帧必须是钩子：人脸或大字，不能黑屏、不能是 logo。
- 单行中文 ≤ 8 字；标题 90–130px，正文 ≥ 28px。

## 操作顺序（照这个顺序，别乱）

1. `openmotion_get_project()` → 确认 `dataDirectory` 与工作区（没有 projectId 时只是列表）。
2. `openmotion_create_project({projectType:"natural_language", title, requirements, namingLanguage:"zh-CN", requestId})`
3. `openmotion_get_project({projectId})` → 读 `directory`、`revision`、`currentVersionId`、`assets/` 现状。
4. 有品牌色时先取 token：`node "<base>/scripts/mcs.mjs" brand "#76B900" --tokens` → 写进 scenes.json 的 `theme`；照片压暗会自动用主题墨色。
5. `openmotion_import_assets({projectId, requestId, items:[{itemId, name, sourcePath}]})` → 图片/音频逐个导入，用返回的 `assets/imported/…` 路径。中文名用「内容 + 用途」。
6. **写 `scenes.json`**：场景 id、`start`、`duration`、文案、`photo`/`photoPos`（模板见下面「工程结构」）。先定分镜起点，后面旁白按这些起点对齐。
7. **旁白（要视频就必做）**：写 TTS `spec.json`（`total_duration` 必填，取最终视频时长）→ `py -3 "<base>/scripts/tts.py" spec.json --out vo.mp3`（macOS/Linux 用 `python3`）→ `openmotion_import_assets` 导入 → 把 `voice.src` 写成**工程内相对路径**（例如 `assets/imported/vo.mp3`；绝对路径或 `../` 会被拒绝）→ 在 `scenes.json` 里加 `voice: {"src": "assets/imported/vo.mp3", "fadeOut": 0.5}`。
8. **搭结构**：`py -3 "<base>/scripts/scaffold-video.py" --dir <工程目录> --scenes scenes.json`。脚本会**先全量校验**（id 唯一、首场从 0 开始、末场不超时长、旁白存在且时长够）再写文件，失败不会留下半个工程；根合成的 `<audio>` 由它按 `voice.src` 写入，**不要手写**。骨架已存在时重跑会被拒绝，确认要覆盖逐场手改才加 `--force`（同时保护 `index.html` 与 `compositions/sN.html`）。scenes.json 里的文本会 `html.escape` 后写入，不要把 HTML 标签当样式用。
9. 本地校验：`node "<base>/scripts/mcs.mjs" check <工程目录>`。CLI 定位顺序：`HYPERFRAMES_CLI` → 旧版 `install.json` → `$DSH_HOME/profiles/<profile>/openmotion-onboarding.json` → 已知安装目录直接探测；成功时会打印用的是哪一条。CLI 输出无法解析时按失败退出，`scaffold-video.py --check` 也转发到这一条。**Studio 的 lint 比 CLI 严**，CLI 通过不代表能过 `complete_generation`。
10. `openmotion_open_preview({action:"begin", mode:"create"|"modify"})` → 拿 `workId`。
11. 若第 10 步之后没有内容变化，`complete_generation` 会报 `GENERATION_CONTENT_UNCHANGED`：**先 begin 再改最后一处内容**，或 begin 后补一个小改动（例如给音频加 `data-fade-out`）。
12. `openmotion_open_preview({action:"complete_generation", workId, expectedRevision, expectedVersionId})`
13. `openmotion_open_preview({action:"open", expectedRevision, expectedVersionId})` → 返回 `previewUrl`。
14. `openmotion_export_request({projectId, requestId, versionId, expectedRevision, audio:"required"})` → 用 `openmotion_get_project({exportJobId})` 轮询到 `completed` 且 `verification.status=passed`。
15. `node "<base>/scripts/mcs.mjs" verify <mp4> --expect-audio required --expect-dur <秒> --expect-cues scenes.json`，再从成品抽帧核对画面。
    - `verify` 会查分辨率/帧率（29.97 这类用浮点容差）/时长/音轨，响度用 loudnorm 两遍法读积分响度与真峰（默认 -16 LUFS ±1、真峰 ≤ -1.0 dBTP），并按 `--expect-cues` 的场次起点核对语句落点（容差 0.4s）。
    - 不给 `--expect-cues` 时它会明确打印「未校验语句落点」，不会用「全部通过」暗示已经核对过。

## 工程结构（Studio 要求的形状）

根合成 `index.html` 只放：变量声明、8 个场景 host、进度条、音轨、根时间线。

```html
<div id="main" data-composition-id="main" data-start="0" data-duration="40.5"
     data-width="1080" data-height="1920" data-fps="30">
  <div id="s1" data-composition-id="s1" data-composition-src="compositions/s1.html"
       data-start="0" data-duration="4.6" data-track-index="1"
       data-width="1080" data-height="1920"></div>
  …
  <div id="prog" data-hf-id="prog"></div>
  <!-- 由 scaffold-video.py 按 scenes.json 的 voice 字段写入；不要手写 -->
  <audio id="vo" class="clip" data-start="0" data-duration="40.5"
         data-track-index="2" data-volume="1" data-fade-out="0.5"
         src="assets/imported/<audio-id>.mp3"></audio>
</div>
<script>
  window.__timelines = window.__timelines || {};   // ★ 必须先初始化
  const tl = gsap.timeline({ paused: true });
  tl.fromTo("#prog", { scaleX: 0 }, { scaleX: 1, duration: 40.5, ease: "none" }, 0);
  window.__timelines["main"] = tl;
</script>
```

每个场景 `compositions/sN.html`：`<template>` 包住 `<style>` + `#root` + `<script>`。

```html
<template>
  <style>
    @font-face { font-family:'SongtiSc'; src: local('Songti SC'), local('STSong'); }
    @font-face { font-family:'HeitiSc'; src: local('Heiti SC'), local('STHeiti'); }
    #root{position:absolute;inset:0;overflow:hidden;background:#f1f3f5;color:#0a1f3d;font-family:'HeitiSc',sans-serif}
    #s1-h{margin:0;position:absolute;left:72px;right:72px;top:900px;font-family:'SongtiSc',serif;font-size:228px;line-height:.94}
  </style>
  <div id="root" data-composition-id="s1" data-width="1080" data-height="1920">
    <h2 id="s1-h" data-hf-id="s1-h">11 天</h2>
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    tl.fromTo("#s1-h", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.7, ease: "power3.out" }, 0.28);
    window.__timelines["s1"] = tl;
  </script>
</template>
```

## 一定会踩的坑

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| `complete_generation` 报 `nested_structure_needs_subcomposition`（error，CLI 只是 warning） | 单文件里 `.clip` 包着子元素 | **拆成子合成**：根只放 host，内容进 `compositions/sN.html` |
| 画面全静态 / 时间轴不跑 | `window.__timelines` 未初始化就赋值 | 脚本开头 `window.__timelines = window.__timelines || {}` |
| 标题跑到画面顶端 | `h2` 用 `top:` 但没 `position:absolute`，且默认 margin 把内容顶下去 | 加 `margin:0; position:absolute; left/right` |
| GSAP 警告 `target not found` | 选择器指向的元素没有 `id`（只写了 `data-hf-id`） | 每个被动画的元素同时给 `id` |
| 场景结束就断掉 | host 的 `data-duration` 与内容时长不一致 | host 时间窗要覆盖该场全部动画 |
| 文字被判定重叠 | 元素在文档流里堆叠 | 所有定位元素 `position:absolute` + 显式 `top/left/right` |
| `text_below_floor` | 用了 26px 之类的小字 | 标注 ≥28px，正文 ≥30px |
| `line_unread` | 一行停留时间 < 0.5+0.3×词数 | 延长该行停留、缩短文案，或提前入场 |
| `dead_stretch` | 3 秒以上画面无变化 | 尾部加缓慢缩放/位移，或给元素 `data-hold` |
| `first_frame_empty` | 第 0 帧只有背景（社交平台缩略图和钩子都靠它） | 首场标题/主视觉直接在 0 秒可见，不要从 opacity:0 入场 |
| `film_silent` | 没有音轨 | 在 `scenes.json` 写 `voice.src`（工程内相对路径）后重跑 `scaffold-video.py`，由它写 `<audio>`；不要手写 |
| `duplicate_media_discovery_risk` | 同一素材两处出现 | 裁一份不同用途的图（如「全年日线」与「11 月跌段」） |
| 字体不生效 / lint 报 font-face | 用了非内置字体且没声明 | `@font-face` + `src: local('系统字体名')`；中文用 `Songti SC` / `Heiti SC` |

## 保存与版本

- 小批量文本修改用 `openmotion_edit_project`（带 `expectedRevision` + `expectedVersionId`，冲突就先 `get_project` 重读）。
- 直接写工程目录也可（Studio 会记成 `Changed outside the app` 并生成版本），写完必须 `openmotion_get_project` 拿新 revision/version 再做 `complete_generation`。
- 导出必须带 `versionId` + `expectedRevision`；repeated requestId 会返回原任务，不会重复渲染。

## 预览面板

`open_preview` 返回的 `nextAction`：Codex 宿主是右侧面板（`open_in_codex`）；**DSH Desktop 的右侧编辑器面板是优先目标**（`presentation` 默认 foreground，切回来再看面板是否真的渲染出内容，并用最新 revision/version 复核）；**只有宿主确实没有面板**（例如别的 Web 部署）时，才在 `preflight` 通过、`previewUrl` 可用的前提下 `record_display`（`visibility:"unavailable"` + 证据），然后用文件路径交付成片，不要假装打开过。

## 成片验收

- `verification.checks` 全 passed（尺寸、帧率、时长、音轨、全解码、首/中/尾 seek）。
- `mcs verify`：音轨存在、响度均值/峰值合理（无削波）、语句落点与分镜对齐。
- ffmpeg 从**成品文件**抽 6–9 帧做接触表，核对与分镜一致（不是看工程截图）。

## 时长与节奏

- 15–20s：一个钩子 + 一个数字 + 一个结尾。
- 30–45s：6–8 场，2–6s 一场，硬切为主，场内有缓慢推近/位移。
- 超过 45s 抖音完播率明显下降，优先砍字而不是加速旁白。
