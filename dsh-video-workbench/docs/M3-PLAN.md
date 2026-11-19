# M3 素材与配音 · 执行计划（v1）

> 目标版本：`0.3.0`。前置：M2 已完成（渲染链路、运行时供给、面板 UI 可用）。
> 状态：**待开工**。已拍板：① Kokoro 兜底接受"要求本机 Python"；② 火山凭据已可用；③ M3 不拆，单里程碑内按步骤顺序交付。

## 1. 目标与非目标

**目标**：一条命令/一次点击，把一个 `project.json` 变成"有图、有配音、可渲染"的项目，并渲染出
带音频轨的成片。

验收口径（PLAN §3 M3 行）：3 张图 + 1 段配音进片并渲染成功；无云凭据时 Kokoro 出片；
TTS 全部失败时输出无声片且不阻断渲染。

**不做**：字幕烧录（PLAN §1 已定）、生视频 API、多轨时间线、素材编辑 UI、Agent 工具定义（M4）、
模板市场、批量渲染。

## 2. 本机已核实的事实（M3 计划的前提）

| # | 事实 | 证据 |
| --- | --- | --- |
| 1 | **`<audio>` 会被混进渲染产物** | 3s 合成 + `tone.wav` → `h264 + aac` 双流，产物 `3.022s`（2026-11-19 实测） |
| 2 | **`hyperframes tts` 是 Kokoro-82M，需 Python 3** | `--help` 列出音色（含中文 `zf_xiaobei`、`-s` 语速、`--json`）；实测报 "Python 3 is required … pip install kokoro-onnx soundfile" |
| 3 | 本机只有 `py` 启动器（Python 3.14.3），`python`/`python3` 不在 PATH | 实测：`hyperframes tts` 因此失败 |
| 4 | `hyperframes transcribe` 可产出 word-level 时间戳，但**中文只有 `large-v3`**（其它模型是 `.en`） | `transcribe --help` |
| 5 | 火山 TTS 自带时间戳字幕，主路径不需要本地 Whisper | PLAN §0 决策 |
| 6 | DSH 有 `credentials` 服务（`resolve`/`readRecord`/`set` 等） | `cordis_inspect_query` Host Service 目录 |
| 7 | 音频元素属性：`data-volume`、`data-has-audio` | hyperframes `dist/docs/data-attributes.md` |
| 8 | 合成仍遵守 M2-PLAN §14：入口必须是项目根 `index.html`、必须注册 `window.__timelines`、只用通用字体 | M2 实测 |

## 3. 决定记录（本阶段新增）

| 项 | 结论 | 理由 |
| --- | --- | --- |
| Kokoro 兜底 | **接受"要求本机 Python 3 + pip 包"**；插件负责**探测**并给出可执行提示，不静默安装 | 用户已确认；静默 `pip install` 不可接受（网络/权限/供应链） |
| Python 探测 | 依次尝试配置的 `pythonPath` → `python` → `python3` → `py -3`；版本 ≥3.8 | 本机正是"只有 `py`"的情况 |
| 火山凭据 | 已可用；**主路径** | 用户已确认；时间戳字幕 + 中文质量 |
| M3 拆分 | **不拆**，一个里程碑内按步骤 0→7 顺序做，但**先做不依赖云凭据的部分**（步骤 3/4 的本地路径） | 用户决定；仍保证"无凭据可验收" |
| 素材元数据 | 不改 `project.json` schema；元数据写 `assets/attribution.json` | 避免 schema 升级链；PLAN §2 已预留该文件名 |
| 字幕数据 | 存 `captions/<sceneId>.json`，**不烧录** | 供 M4/M5 使用；`captions.enabled=false` 时不请求/不落盘 |
| 时长对齐 | 默认 `autoAlignSceneDuration: true`：按配音时长回写 `scene.durationSec` | 避免"配音被截断"；写入仍走原子写 + schema 校验 |

## 4. 目录与文件布局（M3 增量）

```text
<projectsRoot>/<slug>/
├── project.json            # schemaVersion 1 不变；仅 durationSec 可能被对齐更新
├── index.html              # 合成入口（M3 起由模板生成：图片窗 + 音频轨）
├── assets/
│   ├── attribution.json    # M3 新增：素材来源/许可/尺寸/时长/哈希
│   ├── images/s1.png …     # Seedream 生成或 Pixabay 下载
│   └── voice/s1.wav …      # 火山 / Kokoro 合成
├── captions/s1.json        # M3 新增：word timings（可选）
└── renders/vN.mp4          # M2 已有；M3 起含音频轨
$DSH_HOME/cache/dsh-video-workbench/
├── assets-cache/<sha256>.<ext>   # 跨项目复用的素材缓存（相同 prompt/URL 不重复请求）
└── tts/                          # Kokoro 模型与临时件（跟随 hyperframes 缓存）
```

### 4.1 `assets/attribution.json` schema

```json
{
  "schemaVersion": 1,
  "assets": [
    {
      "kind": "image",
      "path": "assets/images/s1.png",
      "source": "seedream",
      "prompt": "…",
      "model": "20260415",
      "author": null,
      "license": "generated",
      "url": null,
      "width": 1024,
      "height": 1792,
      "sha256": "…",
      "createdAt": "2026-11-19T00:00:00.000Z"
    },
    {
      "kind": "voice",
      "path": "assets/voice/s1.wav",
      "source": "volc-tts",
      "voice": "zh_female_…",
      "speed": 1,
      "durationSec": 3.42,
      "words": 0,
      "createdAt": "…"
    }
  ]
}
```

写入规则：原子写；同 `path` 覆盖前先在 `assets-cache` 留底；条目按 `path` 去重；
`license` 取值 `generated` / `pixabay` / `unknown`；Pixabay 条目必须带 `author` 与 `url`。

### 4.2 `captions/<sceneId>.json`

```json
{ "sceneId": "s1", "provider": "volc-tts", "lang": "zh", "text": "…",
  "durationMs": 3420, "words": [{ "text": "第一", "startMs": 0, "endMs": 180 }] }
```

## 5. 模块与接口

```text
src/host/media/
├── types.ts          # Provider 接口、错误码、结果类型（纯类型 + 纯函数）
├── attribution.ts    # attribution.json 读写、哈希、去重、许可校验（纯逻辑可测）
├── captions.ts       # word timings 归一化/落盘/校验
├── cache.ts          # assets-cache：key=sha256，命中即复用；容量上限与清理
├── providers/
│   ├── index.ts      # resolveProviders(config, credentials)：auto/volc/kokoro/none
│   ├── volc-tts.ts   # 火山语音合成（时间戳 → words）
│   ├── kokoro.ts     # 调 hyperframes tts；探测 python；失败给可执行提示
│   ├── seedream.ts   # 火山方舟生图（/images/generations）
│   ├── pixabay.ts    # 图/视频检索与下载
│   └── fake.ts       # 测试用：确定性字节 + 固定 words
├── prepare.ts        # 编排：逐分镜 生图/找图 → 配音 → 对齐时长 → 写 attribution/captions
└── jobs.ts           # 与 render/jobs 同款异步任务（202 + 轮询），并发 1
```

### 5.1 Provider 接口（`types.ts`）

```ts
export interface ImageRequest { prompt: string; aspect: '9:16' | '16:9'; seed?: number }
export interface ImageResult { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg'; width: number; height: number; model?: string }
export interface StockRequest { query: string; kind: 'image' | 'video'; count: number }
export interface StockResult { items: Array<{ bytes: Uint8Array; mime: string; author: string; url: string; license: 'pixabay' }> }
export interface VoiceRequest { text: string; lang: 'zh'; voice?: string; speed: number; wantWords: boolean }
export interface VoiceResult { bytes: Uint8Array; mime: 'audio/wav' | 'audio/mpeg'; durationMs: number; words?: WordTiming[] }

export type MediaErrorCode =
  | 'provider-not-configured' | 'auth-failed' | 'rate-limited' | 'timeout'
  | 'content-rejected' | 'invalid-response' | 'network' | 'toolchain-missing' | 'unknown'
```

错误一律带 `code` 与**脱敏**信息（不含 key、不含完整路径）；`toolchain-missing` 用于 Python 缺失、
`provider-not-configured` 用于无凭据。

### 5.2 编排 `prepare.ts`

```ts
prepareProject({ projectsRoot, projectId, options }): Promise<PrepareResult>
// 逐分镜：media.kind === 'image' && 无 asset → 生图/找图；
//         voice.asset 缺失 → 配音；captions.enabled → 存 words
// 幂等：asset 已存在且 !force → 跳过；force 只重做缺失项除非 forceAll
// 失败：单分镜失败记录 {sceneId, stage, code, message}，继续其它分镜
// 结束：原子写 attribution.json / captions/*.json / project.json（含对齐后的 durationSec）
```

`PrepareResult`：`{ ok, prepared: [], skipped: [], failed: [{sceneId, stage, code, message}] }`。
`ok = failed.filter(f => f.stage === 'voice').length < scenes.length`（允许部分失败；全部 TTS 失败 → 无声片仍 ok）。

## 6. 外部服务契约（步骤 0 用真实凭据逐条落定）

| 服务 | 用途 | 待落定项（步骤 0 输出到本文 §6 附录） |
| --- | --- | --- |
| 火山 TTS | 主配音 + 时间戳 | endpoint/版本、鉴权头（appId/token/cluster）、`voice_type`、字数上限、输出格式、时间戳字段、超时与价格 |
| 火山方舟 Seedream | 生图 | `/images/generations` 请求体、model id（`20260415`）、9:16 尺寸映射、返回 base64/URL、审核拒绝文案 |
| Pixabay | 备用图/视频 | `/api/` 检索参数、`per_page` 上限、`image`/`video` 字段、下载地址、许可与署名要求、限流 |
| Kokoro（本地） | 无凭据兜底 | `hyperframes tts -v zf_xiaobei -s <speed> -l zh --json` 的真实 JSON 结构；Python 探测顺序 |

凭据读取顺序：`ctx.credentials.resolve/readRecord`（key 名见 §7）→ `Config` 明文兜底（仅本机自用，README 标注不建议）→ 视为未配置。

## 7. 配置项（`PluginConfig` 增量）

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `imageProvider` | `auto` | `auto` / `seedream` / `pixabay` / `none` |
| `seedreamModel` | `20260415` | 模型 id 走配置，不写死 |
| `ttsProvider` | `auto` | `auto`（先火山后 Kokoro）/ `volc` / `kokoro` / `none` |
| `volcTtsVoice` | 空 | 火山音色 id；空则用服务端默认 |
| `kokoroVoice` | `zf_xiaobei` | 中文音色 |
| `pythonPath` | 空 | 显式指定 Python；空则按 `python → python3 → py -3` 探测 |
| `autoAlignSceneDuration` | `true` | 按配音时长回写 `scene.durationSec` |
| `assetsCacheDir` | `$DSH_HOME/cache/dsh-video-workbench/assets-cache` | 跨项目素材缓存 |
| `maxImagesPerProject` | `8` | 成本护栏（Seedream 约 0.2 元/张） |
| `prepareTimeoutMs` | `180000` | 准备素材总超时 |

凭据 key（需步骤 0 验证点号是否被 `CredentialKey` 接受）：
`volc.tts.appId`、`volc.tts.token`、`volc.ark.apiKey`、`pixabay.key`。

## 8. 合成模板升级（`render/scaffold.ts` → `render/template.ts`）

- 每个分镜一个时间窗（M2 已有 `data-start`/`data-duration` 语义），窗内放 `<img>` + 文本；
  图片按 M2 的离线规则用项目根相对路径（`assets/images/s1.png`）。
- **音频轨**：每个分镜一个 `<audio src="assets/voice/s1.wav" data-start="<累计>" data-duration="<scene.durationSec>" data-volume="1">`
  （已实测会进产物；M3 步骤 5 再验一次"3 段音频 → 产物 aac 总时长"）。
- 模板对空文案/缺图/缺音频都必须是合法合成：缺音频 → 不出 `<audio>`（无声片）；缺图 → 只出文字。
- 字体仍只用通用字族；不引入 CDN。

## 9. 降级矩阵

| 情形 | 行为 | 渲染结果 |
| --- | --- | --- |
| 无任何云凭据 | 图：`none`（纯文字卡）；配音：Kokoro | 有声片 |
| Kokoro 也不可用（无 Python/pip） | 图：文字卡；配音：跳过并提示 `toolchain-missing` | **无声片**，不阻断渲染 |
| 火山 TTS 失败（鉴权/限流/超时） | 该段回退 Kokoro；仍失败则跳过该段 | 部分有声/无声片 |
| Seedream 失败 | 回退 Pixabay（若配置）→ 文字卡 | 出片 |
| Pixabay 失败 | 文字卡 | 出片 |
| 内容审核拒绝 | 该段文字卡 + 错误记录 | 出片 |
| 素材缓存命中 | 不发请求，直接复制 | 出片 |

任何降级都只**记录**，不抛到 UI 之外的调用方；`PrepareResult.failed` 是唯一失败清单。

## 10. 暴露面（M3 边界）

- Host：`prepareProject` 服务（M4 的 agent 工具只调它，不重复实现）+ 两条路由：
  - `POST /api/video-workbench/assets/prepare` `{ projectId, force? }` → `202 { job }`
  - `GET /api/video-workbench/assets/job/<id>` → 进度（阶段：图/配音/对齐/落盘）
- Client：工作台面板加「**准备素材与配音**」按钮 + 进度 + 失败明细（与渲染进度同款轮询）。
- **不暴露**：单个 provider 的直连路由、任意 URL 下载、任意路径写入。

## 11. 测试计划（无网络、确定性）

| 层 | 用例 |
| --- | --- |
| `attribution.ts` | 读写原子性、去重、许可校验、Pixabay 条目必带 author/url |
| `captions.ts` | words 归一化（排序、重叠裁剪、空数组）、落盘校验 |
| `cache.ts` | sha256 命中/未命中、容量清理、损坏文件自愈 |
| providers fake | 成功/超时/429/审核拒绝/无效响应 → 错误码正确 |
| `prepare.ts` | 3 分镜：全成功 / 部分失败 / 全 TTS 失败；幂等跳过；force 重做；时长对齐后 project.json 仍通过 schema 校验 |
| `template` | 有图有声/无图无声/缺文件三种 HTML 合法；音频窗累计正确 |
| 路由/jobs | 202 + 轮询 + 取消；并发 1；非法 projectId 400 |
| E2E（手工） | `scripts/prepare-smoke.mjs`：真实火山/Kokoro + Seedream → 渲染 → `ffprobe` 断言 aac 流与时长 |

测试全部不联网：真实 provider 只在步骤 0 与 E2E 手工脚本里跑。

## 12. 验收清单（M3 DoD）

- [ ] `node scripts/verify.mjs` 全绿（含新增测试）
- [ ] 火山 TTS：真实请求 → `assets/voice/s1.wav` + `captions/s1.json`（words 非空）
- [ ] Kokoro：本机 Python（`py`）→ 生成 wav；缺 Python 时错误码 `toolchain-missing` 且可读提示
- [ ] Seedream：3 张图落盘，`attribution.json` 记录 model/prompt/许可
- [ ] Pixabay：有 key 时可检索并下载，条目带 author/url
- [ ] 缓存：相同 prompt 二次准备不发请求（日志/fake 计数可证）
- [ ] 时长对齐：配音 3.4s → `scene.durationSec` 更新且 `project.json` 仍合法；关闭开关后不改
- [ ] 模板：3 图 + 3 段音频 → 渲染产物含 **aac 流**，总时长 = 各分镜之和
- [ ] 降级：无凭据 → Kokoro 出片；TTS 全失败 → 无声片仍 `succeeded`
- [ ] UI：面板「准备素材与配音」可见进度与失败明细
- [ ] 文档：README / INSTALL / COMPAT / HANDOFF / 本文件同步（含外部请求说明与隐私段）

## 13. 步骤与提交

| # | 提交 | 内容 | 完成标准 |
| --- | --- | --- | --- |
| 0 | `chore: M3 预检（凭据/服务契约/音频与 Python）` | 用真实凭据打火山 TTS、Seedream、Pixabay 各一次；Kokoro 走 `py`；把结果写进 §6 附录；确认 `credentials` key 命名 | 三个服务各有一条真实成功记录；Kokoro wav 可播 |
| 1 | `feat: 增加素材 provider 接口与假实现` | `media/types.ts`、`fake.ts`、错误码、provider 解析（auto/none） | 单测覆盖所有错误码；无网络 |
| 2 | `feat: 增加 attribution 与素材缓存` | `attribution.ts`、`cache.ts`（sha256、容量清理） | 单测 + 幂等用例 |
| 3 | `feat: 接入火山 TTS 与 Kokoro 兜底` | `volc-tts.ts`、`kokoro.ts`、captions 落盘、时长对齐 | 真实 TTS 出 wav + words；`py` 兜底可用 |
| 4 | `feat: 接入 Seedream 与 Pixabay 素材` | `seedream.ts`、`pixabay.ts`、`maxImagesPerProject` 护栏 | 3 图落盘 + attribution 正确 |
| 5 | `feat: 合成模板支持图片与音频轨` | `render/template.ts`（替换 scaffold 实现，保留旧行为兜底） | 渲染产物含 aac；缺素材仍可渲染 |
| 6 | `feat: 素材准备服务、路由与面板入口` | `prepare.ts`、`media/jobs.ts`、两条路由、UI 按钮与进度 | UI 一次准备 + 失败明细可见 |
| 7 | `docs: M3 验收记录` | README/INSTALL/COMPAT/HANDOFF/截图 + `prepare-smoke.mjs` | 文档与实测一致 |

每步：`tsc --noEmit` → `build` → `node --test` → `verify` 全绿 → 提交。

## 14. 风险与停止条件

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 火山 TTS 时间戳字段与预期不符 | 字幕数据不可用 | 步骤 0 先落定；不可用则 `captions` 降级为"无 words"，不阻断出片 |
| Seedream 模型 id/尺寸契约变化 | 生图失败 | model 走配置；失败回落 Pixabay/文字卡 |
| Python 环境差异（`py` vs `python`） | Kokoro 不可用 | 探测链 + `pythonPath`；只提示不安装 |
| 音频与视频时长不同步 | 音画错位 | 以 `scene.durationSec` 为唯一时间轴；配音回写时长 |
| 成本失控 | 意外扣费 | `maxImagesPerProject` + 缓存 + 日志记录每次调用 |
| 外部内容合规 | 审核拒绝 | 逐段降级、记录 `content-rejected`、不重试 |

停止条件：步骤 0 若火山 TTS 无法产出可用时间戳，则把 `captions` 从 M3 DoD 移除并记入 M4；
若 Kokoro 在本机始终不可用，则保留"要求 Python"的提示路径，不另找替代 TTS。

## 15. 估时

| 步骤 | 人日 |
| --- | --- |
| 0 预检 | 0.5 |
| 1–2 provider + attribution + cache | 1.0 |
| 3 TTS + Kokoro + captions + 对齐 | 1.5 |
| 4 Seedream + Pixabay | 1.0 |
| 5 模板图片/音频 | 0.75 |
| 6 服务 + 路由 + UI | 1.0 |
| 7 验收与文档 | 0.75 |
| 合计 | **6.5**（PLAN 原估 5，偏紧；缓冲后按 7 排） |

## 16. 待确认（开工前 3 项，已有结论的打勾）

- [x] Kokoro 兜底接受"要求本机 Python"
- [x] 火山凭据已可用
- [x] M3 不拆
- [ ] 火山 TTS 的具体音色 id 与集群（步骤 0 用真实凭据确定后回填 §7）
- [ ] Pixabay key 是否已有（没有就把 `imageProvider` 默认 `seedream`，Pixabay 留 M3 之后）
- [ ] 是否允许在 `cordis.patch.yml` 明文写 key（本机自用可接受；README 标注不建议）
