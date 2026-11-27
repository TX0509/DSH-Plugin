# 配音：音色目录、TTS 混音与验收

## 用户已明确的长期偏好

- **所有视频必须有声音**，不允许静音成片。
- 配音是**自然男声**、中文口语，避免机械念稿：短句、有停顿、有起伏。

## 音色目录（edge-tts，zh-CN，实测可用）

| 音色 ID | 名字 | 性格标签 | 适合 | 备注 |
| --- | --- | --- | --- | --- |
| `zh-CN-YunjianNeural` | 云健 | Passion | 纪实/解说/商业复盘（**默认**） | 成熟男声，起伏最自然 |
| `zh-CN-YunyangNeural` | 云扬 | Professional / Reliable | 新闻播报、严肃财经 | 稳、正式，稍像主播 |
| `zh-CN-YunxiNeural` | 云希 | Lively / Sunshine | 轻快、年轻向内容 | 偶发返回空音频，失败就重试或换云健 |
| `zh-CN-YunxiaNeural` | 云夏 | Cute | 少年音、轻松科普 | 偏幼，正式内容慎用 |

女声对照：`XiaoxiaoNeural`（温暖）、`XiaoyiNeural`（活泼）。方言：`zh-CN-liaoning-XiaobeiNeural`、`zh-CN-shaanxi-XiaoniNeural`。

**给用户选音色时**：列出前三个 + 少年音，各配一句「适合什么内容」，让用户选；不要默认静音，也不要默认女声。

## 参数

- 语速 `rate`：`+8%`（口播偏紧凑，避免拖）；抒情/慢节奏内容用 `+2%`。
- 音调 `pitch`：`-1Hz`（男声略压低，去电子感）；不要超过 ±3Hz。
- 输出：48 kHz 立体声，AAC/MP3 192 kbps。
- 响度：混完 `loudnorm=I=-16:TP=-1.5:LRA=11`（短视频平台常规），峰值不超过 −1 dB。
- 末尾 0.5 s 淡出（`data-fade-out="0.5"` 或 ffmpeg `afade`），避免硬切。

## 写台词（避免机械读稿的关键）

1. **一句一件事**，8–26 个汉字；超了就拆句或删字，别靠加速。
2. 用口语连接：`但 / 结果 / 这一次 / 六天后`，不用 `首先/其次/综上`。
3. 数字口语化：`百分之三十一点四八`→说成`涨了三成`；精确数字放在画面上，嘴上说人话。
4. 句间留 0.2 s 以上停顿（排版时给下一段留白），不要连读成一串。
5. 每句的时长 ≈ 汉字数 / 4.5（秒），按 `rate=+8%` 估；生成后必须用 ffprobe 实测。

## 生成与混音

```bash
py -3 "<base>/scripts/tts.py" spec.json --out vo.mp3      # Windows
python3 "<base>/scripts/tts.py" spec.json --out vo.mp3    # macOS / Linux
# spec.json: {"voice":"zh-CN-YunjianNeural","rate":"+8%","pitch":"-1Hz",
#             "total_duration":40.5,
#             "segments":[{"id":"s1","start":0.15,"text":"…"}, …]}
```

```jsonc
{
  "voice": "zh-CN-YunjianNeural",   // 音色 id
  "rate": "+8%",                     // 语速
  "pitch": "-1Hz",                   // 音调
  "total_duration": 40.5,            // 必填且 > 0：混音按它补齐，并校验输出长度
  "min_gap": 0.2,                    // 相邻句最小停顿（秒），默认 0.2
  "loudness": {"I": -16, "TP": -1.5},// 可选；I 必须在 -70~-5，TP 在 -9~0
  "segments": [{"id": "s1", "start": 0.15, "text": "…"}]
}
```

脚本做的事：入口一次性校验 spec（`id` 白名单 `/^[A-Za-z0-9_-]{1,64}$/` 且唯一、`text` 非空、`start` 是 ≥0 的数、`total_duration` 必填、响度区间）→ 逐句生成（单句最多重试 2 次，退避 0.5s/1s）→ ffprobe 实测时长 → 检查相邻句是否重叠或间隔不足 → `adelay`+`amix`+`loudnorm`+`apad` 混成一条与视频等长的音轨 → 校验输出时长与 `total_duration` 偏差 ≤0.15s、打印整轨 LUFS 与真峰（不达标只警告，不假装通过）。

- `spec` 里任何一条不合法都会在开始合成前退出（不会先花完 TTS 请求再失败）；报错会写明第几句 / 哪个字段。
- `--out` 已有同名文件时默认拒绝，确认覆盖加 `--force`；输出先写临时文件再原子替换。
- `--workdir DIR` 指定临时目录（不存在会自动建；调试时配合 `KEEP_TTS_TMP=1` 保留逐句 mp3）。
- 同时写出 `<out>.json`（每句实测时长与落点、整轨时长），审片与 `mcs verify --expect-cues` 都用它。
- 结尾 0.5s 淡出由视频根合成的 `<audio data-fade-out>` 实现（OpenMotion 渲染时生效），不在 mp3 上做 afade。

**为什么逐句生成**：整段合成会按自己节奏朗读，和分镜对不上；逐句生成后按场次起点延时，才能让每句话踩在对应画面上。

## 兜底方案（无网络，需用户明确同意）

macOS 本机音色（`say -v '?' | grep zh_CN`）：

```bash
say -v "Eddy (中文（中国大陆）)" -r 200 -o vo.aiff "辞职十一天，他又回来了。"
ffmpeg -i vo.aiff -ar 48000 -ac 2 vo.mp3
```

可用男声：`Eddy`、`Grandpa`、`Reed`、`Rocko`（均 zh_CN）。质量弱于 edge-tts：**先问用户同不同意用降级配音，同意了也要在交付说明里写明是降级**；不许不问就直接用它顶替 edge-tts。

## 验收

```bash
node "<base>/scripts/mcs.mjs" verify out.mp4 --expect-audio required --expect-dur 40.5
```

看四件事：有音轨（aac）、时长吻合、整轨响度与峰值（mean/max、I LUFS）、语句落点（silencedetect 的 silence_end 应与分镜起点对齐）。
