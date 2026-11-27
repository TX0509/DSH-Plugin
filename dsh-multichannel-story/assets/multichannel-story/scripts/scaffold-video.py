#!/usr/bin/env python3
"""生成「根合成 + 每场一个子合成」的竖屏视频骨架（1080×1920 / 30fps）。

用法：
    python3 scaffold-video.py --dir <OpenMotion 工程目录> --scenes scenes.json [--check] [--force]

为什么要这样拆：Studio 的 lint 把「一个 .clip 里嵌子元素」判成 error
（nested_structure_needs_subcomposition），所以根合成只放 host，每个场景独立成
compositions/sN.html，各自一条 paused 时间线。

scenes.json:
{
  "title": "黄仁勋 11 天：抖音竖版",
  "width": 1080, "height": 1920, "fps": 30, "duration": 40.5,
  "theme": {"paper": "#f1f3f5", "ink": "#0a1f3d", "accent": "#315d93"},
  "voice": {"src": "assets/imported/xxx.mp3", "duration": 40.5, "fadeOut": 0.5},
  "scenes": [
    {"id": "s1", "start": 0, "duration": 4.6, "kind": "photo",
     "photo": "assets/imported/portrait.jpg", "photoPos": "50% 16%",
     "kicker": "2026.11.12 辞职 → 11.23 复职",
     "title": ["11 天"], "titleSize": 228,
     "body": "市值 −1.6 万亿 → +9520 亿", "bodySize": 44},
    {"id": "s2", "start": 4.6, "duration": 5.6, "kind": "paper",
     "kicker": "11.12 · 辞职即刻生效",
     "title": ["他辞去", "全部职务"],
     "stats": [{"label": "一周跌幅", "value": "−23%"}, {"label": "蒸发市值", "value": "1.6 万亿"}]},
    {"id": "s3", "start": 10.2, "duration": 4.6, "kind": "ink",
     "kicker": "11.17 · 财报电话会",
     "title": ["“无意让其回归”"],
     "body": "六天后，全票通过。"}
  ]
}

kind: paper（纸色底）/ ink（墨色底）/ photo（照片全屏，可给 veil 压暗 0-1）。
标题字号默认：单行 ≤6 字用 228px（首屏钩子大字特例，见 references/video.md），
其余 120px / 96px，都在文档的 90–130px 区间内；正文默认 42px（≥28px）。

安全区（1080×1920 基准）：顶部 168px、正文下边界 1330px（底部 590px 留给抖音文案/按钮）；
换分辨率时按比例缩放。内容底部越界只警告，不改字号。

所有来自 scenes.json 的文本/属性都会 html.escape 后写入；脚本先在内存里全量校验并渲染，
再写进工程目录下的临时目录，整体替换成功后才算完成——任何校验失败都不会留下半个工程。
生成后仍要逐场改文案与节奏；脚本只保证结构、字体、安全区、动画基线是对的。
"""
import argparse
import html
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile

# Windows 的控制台与管道默认按 GBK 编码：打印中文或 ✓ 会直接 UnicodeEncodeError。
# 这个脚本总是被 mcs / Agent 以管道调用，所以固定成 UTF-8，别让一行日志把整步打挂。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

FONT_FACES = """  @font-face { font-family: 'SongtiSc'; src: local('Songti SC'), local('STSong'), local('Songti TC'); }
  @font-face { font-family: 'HeitiSc'; src: local('Heiti SC'), local('STHeiti'), local('PingFang SC'); }
"""

# 安全区：1080×1920 基准。顶部 168px 内不放正文；正文下边界 1330px（底部 590px 是抖音文案/按钮）。
SAFE_TOP = 168
SAFE_BOTTOM = 1330
SAFE_BASE_HEIGHT = 1920

# 场景 id 会进文件名与 HTML 属性：白名单之外（分隔符、冒号、引号）既不安全也会写出坏路径。
ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
HEX_RE = re.compile(r"#?[0-9A-Fa-f]{6}")
# photoPos 只接受 CSS object-position 的常见写法，杜绝往 CSS 里塞额外声明。
PHOTO_POS_RE = re.compile(
    r"(?:left|center|right|top|bottom|\d+(?:\.\d+)?%)"
    r"(?:\s+(?:left|center|right|top|bottom|\d+(?:\.\d+)?%)){0,3}")
PHOTO_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif")
KINDS = ("paper", "ink", "photo")
TITLE_MIN, TITLE_MAX = 40, 260
TITLE_BODY_LIMIT = 130  # 文档写 90–130px；>130 只允许单行 ≤6 字的封面大字
BODY_MIN, BODY_MAX = 28, 120


def fail(message):
    sys.exit(message)


def _is_number(value):
    """数值校验：bool 是 int 的子类，必须排除；NaN/Inf 也不行。"""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _number(value, label, *, required=False, default=None, minimum=None, maximum=None):
    if value is None:
        if required:
            fail(f"{label} 必填（数值）")
        return default
    if not _is_number(value):
        fail(f"{label} 必须是数值（收到：{value!r}）")
    if minimum is not None and value < minimum:
        fail(f"{label} 必须 >= {minimum}（收到：{value}）")
    if maximum is not None and value > maximum:
        fail(f"{label} 必须 <= {maximum}（收到：{value}）")
    return float(value)


def num_text(value):
    """把数值写进 HTML/CSS：40.5 → "40.5"，1920.0 → "1920"。"""
    text = f"{float(value):.6f}".rstrip("0").rstrip(".")
    return text or "0"


def esc(value):
    """scenes.json 里的所有文本/属性都从这里过一遍，quote=True 连引号一起转义。"""
    return html.escape(str(value), quote=True)


def norm_hex(value, label):
    if not isinstance(value, str) or not HEX_RE.fullmatch(value.strip()):
        fail(f"{label} 必须是 #rrggbb 形式（收到：{value!r}）")
    value = value.strip()
    return value if value.startswith("#") else "#" + value


def hex_to_rgb(c):
    c = c.lstrip("#")
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def project_relative(proj, value, label, *, must_exist=False):
    """只接受工程内相对路径：绝对路径、盘符、`..`、realpath 逃出工程目录都直接失败。"""
    if not isinstance(value, str) or not value.strip():
        fail(f"{label} 必须是非空字符串")
    raw = value.strip()
    if os.path.isabs(raw) or re.match(r"^[A-Za-z]:[\\/]", raw) or raw.startswith(("/", "\\")):
        fail(f"{label} 必须是工程内相对路径，不能是绝对路径（收到：{raw}）")
    normalized = os.path.normpath(raw)
    if normalized == ".." or normalized.startswith(".." + os.sep) or normalized.startswith("../"):
        fail(f"{label} 不能跳出工程目录（收到：{raw}）")
    root = os.path.realpath(proj)
    real = os.path.realpath(os.path.join(proj, normalized))
    try:
        inside = os.path.commonpath([real, root]) == root
    except ValueError:  # Windows 跨盘符
        inside = False
    if not inside or real == root:
        fail(f"{label} 必须指向工程目录内的文件（收到：{raw}）")
    if must_exist and not os.path.isfile(real):
        fail(f"找不到 {label}：{raw}")
    return raw, real


def validate_theme(spec):
    theme_raw = spec.get("theme") or {}
    if not isinstance(theme_raw, dict):
        fail("theme 必须是对象，例：{\"paper\": \"#f1f3f5\"}")
    theme = {key: norm_hex(value, f"theme.{key}") for key, value in theme_raw.items()}
    theme.setdefault("paper", "#f1f3f5")
    theme.setdefault("ink", "#0a1f3d")
    theme.setdefault("accent", "#315d93")
    return {key: theme[key] for key in ("paper", "ink", "accent")}


def validate_scene(sc, index, width, height, proj):
    """单场校验：必填字段/类型、kind 白名单、注入相关字段的类型与白名单。"""
    if not isinstance(sc, dict):
        fail(f"第 {index} 个场景必须是对象")
    sid = sc.get("id")
    if not isinstance(sid, str) or not ID_RE.fullmatch(sid):
        fail(f"场景 id 非法（第 {index} 个）：{sid!r}（只允许字母、数字、下划线、连字符，1–64 字符）")
    where = f"场景 {sid}"
    start = _number(sc.get("start"), f"{where}.start", required=True, minimum=0)
    duration = _number(sc.get("duration"), f"{where}.duration", required=True, minimum=0.001)
    kind = sc.get("kind", "paper")
    if kind not in KINDS:
        fail(f"{where}.kind 只能是 {'/'.join(KINDS)}（收到：{kind!r}）")

    title = sc.get("title")
    title_lines = []
    if title is not None:
        if not isinstance(title, list) or not title:
            fail(f"{where}.title 必须是非空数组，例：[\"11 天\"]")
        for line in title:
            if not isinstance(line, str):
                fail(f"{where}.title 的每一行都必须是字符串（收到：{line!r}）")
            title_lines.append(line)
        if not any(line.strip() for line in title_lines):
            fail(f"{where}.title 不能全是空白")
        for line in title_lines:
            if len(line) > 8:
                print(f"  ! {where}.title 单行 {len(line)} 字，超过竖屏建议的 8 字：拆行或删字")

    def opt_text(key):
        value = sc.get(key)
        if value is None:
            return None
        if not isinstance(value, str):
            fail(f"{where}.{key} 必须是字符串（收到：{value!r}）")
        return value

    kicker = opt_text("kicker")
    body = opt_text("body")

    stats = sc.get("stats")
    if stats is not None:
        if not isinstance(stats, list) or not stats:
            fail(f"{where}.stats 必须是非空数组")
        normalized_stats = []
        for item in stats:
            if not isinstance(item, dict):
                fail(f"{where}.stats 的每一项必须是对象")
            for key in ("label", "value"):
                value = item.get(key)
                if not isinstance(value, str) or not value.strip():
                    fail(f"{where}.stats 的 {key} 必须是非空字符串（收到：{value!r}）")
            normalized_stats.append({"label": item["label"], "value": item["value"]})
        stats = normalized_stats

    title_size = _number(sc.get("titleSize"), f"{where}.titleSize",
                         minimum=TITLE_MIN, maximum=TITLE_MAX)
    body_size = _number(sc.get("bodySize"), f"{where}.bodySize",
                        minimum=BODY_MIN, maximum=BODY_MAX)
    title_top = _number(sc.get("titleTop"), f"{where}.titleTop", minimum=0)

    lines_count = len(title_lines)
    single_short = lines_count == 1 and len(title_lines[0]) <= 6
    if title_size is not None and title_size > TITLE_BODY_LIMIT and not single_short:
        fail(f"{where}.titleSize={num_text(title_size)} 超出文档的 90–{TITLE_BODY_LIMIT}px 常规区间；"
             "只有单行 ≤6 字的封面大字才允许更大字号（默认 228），否则请拆行或调小")

    photo = sc.get("photo")
    photo_pos = sc.get("photoPos")
    veil = sc.get("veil")
    if kind == "photo":
        if photo is None:
            fail(f"{where}.kind=photo 时必须给 photo（工程内相对路径）")
        if not isinstance(photo, str) or not photo.strip():
            fail(f"{where}.photo 必须是非空字符串")
        if os.path.splitext(photo)[1].lower() not in PHOTO_EXTS:
            fail(f"{where}.photo 只接受图片扩展名 {'/'.join(PHOTO_EXTS)}（收到：{photo}）")
        project_relative(proj, photo, f"{where}.photo")
    elif photo is not None and not isinstance(photo, str):
        fail(f"{where}.photo 必须是字符串")
    if photo_pos is not None:
        if not isinstance(photo_pos, str) or not PHOTO_POS_RE.fullmatch(photo_pos.strip()):
            fail(f"{where}.photoPos 只接受 CSS object-position 写法，例：\"50% 40%\"（收到：{photo_pos!r}）")
        photo_pos = photo_pos.strip()
    veil = _number(veil, f"{where}.veil", minimum=0, maximum=1)

    return {
        "id": sid,
        "start": start,
        "duration": duration,
        "kind": kind,
        "title": title_lines,
        "kicker": kicker,
        "body": body,
        "stats": stats,
        "titleSize": title_size,
        "bodySize": body_size,
        "titleTop": title_top,
        "photo": photo.strip() if isinstance(photo, str) else None,
        "photoPos": photo_pos,
        "veil": veil,
    }


def validate_spec(spec, proj):
    """全量校验 scenes.json（失败时一次文件都不写）。"""
    if not isinstance(spec, dict):
        fail("scenes.json 顶层必须是对象")
    width = _number(spec.get("width", 1080), "width", minimum=64, maximum=8192)
    height = _number(spec.get("height", 1920), "height", minimum=64, maximum=8192)
    fps = _number(spec.get("fps", 30), "fps", minimum=1, maximum=240)
    duration = _number(spec.get("duration"), "duration", minimum=0.001)
    title = spec.get("title", "竖屏短片")
    if not isinstance(title, str):
        fail("title 必须是字符串")

    raw_scenes = spec.get("scenes")
    if not isinstance(raw_scenes, list) or not raw_scenes:
        fail("scenes 必须是非空数组（至少一场）")
    scenes = [validate_scene(sc, i, width, height, proj) for i, sc in enumerate(raw_scenes, 1)]

    seen = set()
    for sc in scenes:
        if sc["id"] in seen:
            fail(f"场景 id 重复：{sc['id']}（会互相覆盖 compositions/{sc['id']}.html）")
        seen.add(sc["id"])

    scenes.sort(key=lambda item: item["start"])
    first = scenes[0]
    if abs(first["start"]) > 1e-6:
        fail(f"首场必须从 start=0 开始（最早的是 {first['id']}，start={num_text(first['start'])}）")

    last_end = max(sc["start"] + sc["duration"] for sc in scenes)
    if duration is None:
        # 未声明时长就取所有场景的最晚结束点（向上取到 0.01s），保证不会小于最后一场。
        duration = math.ceil(last_end * 100) / 100
    elif last_end > duration + 1e-6:
        fail(f"最后一场结束于 {num_text(round(last_end, 3))}s，超过 duration={num_text(duration)}s；"
             "调小场景时长或调大 duration")

    voice = None
    raw_voice = spec.get("voice")
    if raw_voice is not None:
        if not isinstance(raw_voice, dict):
            fail("voice 必须是对象，例：{\"src\": \"assets/imported/vo.mp3\"}")
        src, real = project_relative(proj, raw_voice.get("src"), "旁白音频 voice.src", must_exist=True)
        for tool in ("ffprobe", "ffmpeg"):
            if not shutil.which(tool):
                fail(f"缺少 {tool}：旁白音频必须实测时长，不能只信 scenes.json 的声明；"
                     "先安装 ffmpeg（brew install ffmpeg / winget install ffmpeg）")
        real_duration = probe_duration(real)
        if real_duration is None or real_duration <= 0.2:
            fail(f"旁白音频 {src} 时长读不出或过短（{real_duration if real_duration is None else num_text(real_duration) + 's'}）："
                 "用 ffprobe 确认文件，或重新导出/重跑 tts.py")
        if real_duration < duration - 0.5:
            fail(f"旁白音频 {src} 只有 {num_text(real_duration)}s，比视频时长 {num_text(duration)}s "
                 f"短了 {num_text(round(duration - real_duration, 2))}s：按 total_duration={num_text(duration)} "
                 "重跑 tts.py，重新 import_assets 后再 scaffold")
        fade_out = _number(raw_voice.get("fadeOut", 0.5), "voice.fadeOut", minimum=0, maximum=60)
        voice = {
            "src": src,
            "real_duration": real_duration,
            "duration": min(real_duration, duration),
            "fadeOut": fade_out,
        }

    return {
        "title": title,
        "width": int(round(width)),
        "height": int(round(height)),
        "fps": fps,
        "duration": duration,
        "theme": validate_theme(spec),
        "voice": voice,
        "scenes": scenes,
        "first_id": first["id"],
        "safe_top": round(height * SAFE_TOP / SAFE_BASE_HEIGHT),
        "safe_bottom": round(height * SAFE_BOTTOM / SAFE_BASE_HEIGHT),
    }


def scene_css(sid, sc, theme, model):
    kind = sc["kind"]
    lines = sc["title"]
    body = sc["body"] or ""
    stats = sc["stats"] or []
    title_size = sc["titleSize"]
    if title_size is None:
        title_size = 228 if len(lines) == 1 and len(lines[0]) <= 6 else (120 if len(lines) <= 2 else 96)
    title_size = int(round(title_size))
    body_size = int(round(sc["bodySize"] or 42))
    title_top = int(round(sc["titleTop"] if sc["titleTop"] is not None else 250))
    title_h = title_size * 1.12 * max(1, len(lines))
    body_top = title_top + title_h + 44
    stats_top = None
    if stats:
        stats_top = body_top
        if body:
            # 粗估正文行数（中文约 20 字/行，42px），把账本放到正文下方
            est_lines = max(1, -(-len(body) // 20))
            stats_top = body_top + int(body_size * 1.5 * est_lines) + 32
    ink_kind = kind == "ink"
    fg = "#eef2f6" if ink_kind or kind == "photo" else theme["ink"]
    accent = "#7ea3d1" if ink_kind or kind == "photo" else theme["accent"]
    css = [f"    #root{{position:absolute;inset:0;overflow:hidden;background:{theme['paper']};"
           f"color:{theme['ink']};font-family:'HeitiSc',sans-serif}}"]
    if kind == "photo":
        css.append(f"    #{sid}-photo{{position:absolute;inset:0}}")
        css.append(f"    #{sid}-photo img{{width:100%;height:100%;object-fit:cover;"
                   f"object-position:{sc['photoPos'] or '50% 40%'}}}")
        veil = sc["veil"] if sc["veil"] is not None else 0.62
        r, g, b = hex_to_rgb(theme["ink"])
        bottom_pad = max(0, model["height"] - model["safe_bottom"])
        css.append(f"    #{sid}-veil{{position:absolute;inset:0;background:rgba({r},{g},{b},{num_text(veil)});"
                   f"display:flex;flex-direction:column;justify-content:flex-end;padding:0 0 {bottom_pad}px}}")
    elif ink_kind:
        css.append(f"    #{sid}-bg{{position:absolute;inset:0;background:{theme['ink']}}}")
    else:
        css.append(f"    #{sid}-bg{{position:absolute;inset:0;background:{theme['paper']}}}")
    if body:
        content_bottom = stats_top if stats else (
            body_top + int(body_size * 1.5 * max(1, -(-len(body) // 20))))
    elif stats:
        content_bottom = stats_top
    else:
        content_bottom = title_top + title_h
    if content_bottom > model["safe_bottom"]:
        print(f"  ! {sid} 内容底部约 {content_bottom}px，超出正文安全区 {model['safe_bottom']}px"
              "（底部留给抖音文案/按钮）：删字或调小 titleSize/bodySize")
    if title_top < model["safe_top"]:
        print(f"  ! {sid} 标题 top={title_top}px 在顶部安全区 {model['safe_top']}px 之内："
              "会被状态栏/搜索栏压住")
    css.append(f"    #{sid}-kicker{{position:absolute;left:72px;right:72px;top:190px;"
               f"font-family:'HeitiSc',sans-serif;font-size:28px;letter-spacing:.18em;"
               f"text-transform:uppercase;opacity:.6;color:{fg};margin:0}}")
    css.append(f"    #{sid}-title{{position:absolute;left:72px;right:72px;top:{title_top}px;margin:0;"
               f"font-family:'SongtiSc',serif;font-weight:600;font-size:{title_size}px;"
               f"line-height:1.12;letter-spacing:.01em;color:{fg}}}")
    if body:
        css.append(f"    #{sid}-body{{position:absolute;left:72px;right:72px;top:{body_top}px;margin:0;"
                   f"font-size:{body_size}px;line-height:1.5;color:{fg};opacity:.86}}")
    if stats:
        css.append(f"    #{sid}-stats{{position:absolute;left:72px;right:72px;top:{stats_top}px;"
                   f"display:flex;gap:64px;color:{fg}}}")
        css.append(f"    #{sid}-stats .lbl{{font-size:28px;letter-spacing:.16em;opacity:.55}}")
        css.append(f"    #{sid}-stats .val{{font-family:'SongtiSc',serif;font-weight:600;"
                   f"font-size:70px;line-height:1.05;margin-top:10px;color:{accent}}}")
    return "\n".join(css)


def scene_markup(sid, sc):
    kind = sc["kind"]
    parts = []
    if kind == "photo":
        parts.append(f'    <div id="{sid}-photo" data-hf-id="{sid}-photo">'
                     f'<img src="{esc(sc["photo"])}" alt=""></div>')
        parts.append(f'    <div id="{sid}-veil" data-hf-id="{sid}-veil">')
    else:
        parts.append(f'    <div id="{sid}-bg" data-hf-id="{sid}-bg"></div>')
    inner = []
    if sc["kicker"]:
        inner.append(f'      <p id="{sid}-kicker" data-hf-id="{sid}-kicker">{esc(sc["kicker"])}</p>')
    if sc["title"]:
        br = "<br>".join(esc(line) for line in sc["title"])
        inner.append(f'      <h2 id="{sid}-title" data-hf-id="{sid}-title">{br}</h2>')
    if sc["body"]:
        inner.append(f'      <p id="{sid}-body" data-hf-id="{sid}-body">{esc(sc["body"])}</p>')
    if sc["stats"]:
        rows = []
        for i, st in enumerate(sc["stats"]):
            rows.append(f'        <div data-hf-id="{sid}-st{i}">'
                        f'<div class="lbl" data-hf-id="{sid}-st{i}l">{esc(st["label"])}</div>'
                        f'<div class="val" data-hf-id="{sid}-st{i}v">{esc(st["value"])}</div></div>')
        inner.append(f'      <div id="{sid}-stats" data-hf-id="{sid}-stats">\n' + "\n".join(rows) + "\n      </div>")
    parts.extend(inner)
    if kind == "photo":
        parts.append("    </div>")
    return "\n".join(parts)


def scene_script(sid, sc, dur, is_first=False):
    kind = sc["kind"]
    has_title = bool(sc["title"])
    tl = ["    window.__timelines = window.__timelines || {};",
          "    const tl = gsap.timeline({ paused: true });",
          '    const F = "power3.out", E = "power2.out";']
    if kind == "photo":
        tl.append(f'    tl.fromTo("#{sid}-photo img", {{ scale: 1.12 }}, '
                  f'{{ scale: 1.0, duration: {num_text(dur)}, ease: "none" }}, 0);')
    if sc["kicker"]:
        tl.append(f'    tl.fromTo("#{sid}-kicker", {{ opacity: 0, y: 20 }}, '
                  f'{{ opacity: 0.6, y: 0, duration: 0.45, ease: E }}, 0.12);')
    if has_title:
        if is_first:
            # 第 0 帧就是封面：标题直接在场，只做轻微放大，避免 first_frame_empty
            tl.append(f'    tl.fromTo("#{sid}-title", {{ opacity: 1, scale: 1 }}, '
                      f'{{ scale: 1.04, duration: {num_text(max(0.2, dur))}, ease: "none" }}, 0);')
        else:
            tl.append(f'    tl.fromTo("#{sid}-title", {{ opacity: 0, y: 44 }}, '
                      f'{{ opacity: 1, y: 0, duration: 0.65, ease: F }}, 0.26);')
    if sc["body"]:
        tl.append(f'    tl.fromTo("#{sid}-body", {{ opacity: 0, y: 24 }}, '
                  f'{{ opacity: 0.86, y: 0, duration: 0.55, ease: E }}, 0.9);')
    if sc["stats"]:
        tl.append(f'    tl.fromTo("#{sid}-stats", {{ opacity: 0, y: 30 }}, '
                  f'{{ opacity: 1, y: 0, duration: 0.6, ease: E }}, 0.9);')
    # 收尾缓动，避免 dead_stretch（3 秒不动会被 lint 判为空洞）。
    # 只对真实存在的 #sid-title 补动画：没有标题的场次指向它只会换来 target not found 警告。
    if has_title and not is_first:
        tl.append(f'    tl.fromTo("#{sid}-title", {{ scale: 1 }}, '
                  f'{{ scale: 1.03, duration: {num_text(max(0.1, dur - 1.2))}, ease: "none" }}, 1.2);')
    elif not has_title and not sc["body"] and not sc["stats"] and not sc["kicker"] and kind != "photo":
        # 纯底色场次：给背景一个极缓的推近，避免整场静止。
        tl.append(f'    tl.fromTo("#{sid}-bg", {{ scale: 1.02 }}, '
                  f'{{ scale: 1.0, duration: {num_text(max(0.2, dur))}, ease: "none" }}, 0);')
    tl.append(f'    window.__timelines["{sid}"] = tl;')
    return "\n".join(tl)


def render_scene(sid, sc, model):
    dur = sc["duration"]
    return f"""<template>
  <style>
{FONT_FACES}{scene_css(sid, sc, model['theme'], model)}
  </style>
  <div id="root" data-composition-id="{sid}" data-width="{model['width']}" data-height="{model['height']}">
{scene_markup(sid, sc)}
  </div>
  <script>
{scene_script(sid, sc, dur, sid == model['first_id'])}
  </script>
</template>
"""


def render_index(model):
    width, height = model["width"], model["height"]
    duration = model["duration"]
    theme = model["theme"]
    hosts = "\n".join(
        f'  <div id="{s["id"]}" data-hf-id="host-{s["id"]}" data-composition-id="{s["id"]}"'
        f' data-composition-src="compositions/{s["id"]}.html" data-start="{num_text(s["start"])}"'
        f' data-duration="{num_text(s["duration"])}" data-track-index="1"'
        f' data-width="{width}" data-height="{height}"></div>'
        for s in model["scenes"])
    audio = ""
    voice = model["voice"]
    if voice is not None:
        # data-duration 用音频真实长度（不匹配会被 lint 提示 clip_media_fit）。
        audio = (f'  <audio id="vo" data-hf-id="audio-vo" class="clip" data-start="0"'
                 f' data-duration="{num_text(voice["duration"])}" data-track-index="2"'
                 f' data-volume="1" data-fade-out="{num_text(voice["fadeOut"])}"'
                 f' src="{esc(voice["src"])}"></audio>\n')
    first = model["scenes"][0]
    headline = first["title"][0] if first["title"] else ""
    variables = html.escape(json.dumps([
        {"id": "headline", "type": "string", "label": "主标", "default": headline},
    ], ensure_ascii=False), quote=True)

    return f"""<!doctype html>
<html lang="zh-CN" data-composition-variables="{variables}">
<head>
<meta charset="utf-8">
<title>{esc(model["title"])}</title>
<script src="assets/gsap.min.js"></script>
<style>
{FONT_FACES}  :root{{ --paper:{theme['paper']}; --ink:{theme['ink']}; --accent:{theme['accent']}; }}
  html,body{{margin:0;padding:0;background:{theme['ink']}}}
  #main{{position:relative;width:{width}px;height:{height}px;overflow:hidden;background:var(--paper)}}
  #prog{{position:absolute;left:0;bottom:0;height:6px;width:100%;background:var(--accent);
         transform-origin:left center;z-index:50}}
</style>
</head>
<body>
<div id="main" data-hf-id="root-main" data-composition-id="main" data-start="0"
     data-duration="{num_text(duration)}" data-width="{width}" data-height="{height}" data-fps="{num_text(model['fps'])}">
{hosts}
  <div id="prog" data-hf-id="prog"></div>
{audio}</div>
<script>
  window.__timelines = window.__timelines || {{}};
  const tl = gsap.timeline({{ paused: true }});
  tl.fromTo("#prog", {{ scaleX: 0 }}, {{ scaleX: 1, duration: {num_text(duration)}, ease: "none" }}, 0);
  window.__timelines["main"] = tl;
</script>
</body>
</html>
"""


def probe_duration(path):
    """用 ffprobe 读真实时长；读不到（缺 ffprobe/文件损坏）返回 None。"""
    if not shutil.which("ffprobe") or not os.path.exists(path):
        return None
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                              "-of", "default=nw=1:nk=1", path],
                             capture_output=True, encoding="utf-8", errors="replace",
                             check=True).stdout.strip()
        value = float(out)
        return round(value, 3) if value > 0 else None
    except Exception:
        return None


def check_preconditions(proj):
    """前置校验：工程存在、gsap 在、目录可写。全部通过才谈生成。"""
    if not os.path.isdir(proj):
        fail(f"工程目录不存在：{proj}（先 openmotion_create_project 创建工程）")
    gsap = os.path.join(proj, "assets", "gsap.min.js")
    if not os.path.isfile(gsap):
        fail("工程里没有 assets/gsap.min.js —— 先 openmotion_create_project 创建工程")
    if not os.access(proj, os.W_OK):
        fail(f"工程目录不可写：{proj}")
    comp_dir = os.path.join(proj, "compositions")
    if os.path.exists(comp_dir):
        if not os.path.isdir(comp_dir):
            fail(f"compositions 已存在但不是目录：{comp_dir}")
        if not os.access(comp_dir, os.W_OK):
            fail(f"compositions 目录不可写：{comp_dir}")


def commit_files(proj, files):
    """先写工程内的临时目录，再逐个 os.replace 换上去；失败不会留下半套新文件。"""
    stage = tempfile.mkdtemp(prefix=".scaffold-", dir=proj)
    try:
        for relative, content in files.items():
            target = os.path.join(stage, *relative.split("/"))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(content)
        # 入口 index.html 最后换：即使中途失败，旧入口仍然完整可用。
        comp_dir = os.path.join(proj, "compositions")
        os.makedirs(comp_dir, exist_ok=True)
        for relative in files:
            if not relative.startswith("compositions/"):
                continue
            os.replace(os.path.join(stage, *relative.split("/")),
                       os.path.join(proj, *relative.split("/")))
        os.replace(os.path.join(stage, "index.html"), os.path.join(proj, "index.html"))
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description="生成竖屏视频骨架")
    ap.add_argument("--dir", required=True, help="OpenMotion 工程目录（含 assets/gsap.min.js）")
    ap.add_argument("--scenes", required=True, help="scenes.json")
    ap.add_argument("--check", action="store_true", help="生成后跑 hyperframes check")
    ap.add_argument("--force", action="store_true", help="覆盖已存在的 index.html / compositions")
    args = ap.parse_args()

    proj = os.path.abspath(args.dir)
    check_preconditions(proj)

    if not os.path.isfile(args.scenes):
        fail(f"找不到 scenes.json：{args.scenes}")
    try:
        with open(args.scenes, encoding="utf-8") as fh:
            raw_spec = json.load(fh)
    except json.JSONDecodeError as e:
        fail(f"scenes.json 不是合法 JSON：{e}")

    # 全量校验：这一步之前/之中失败都不会写工程文件。
    model = validate_spec(raw_spec, proj)

    # --force 要保护所有会被覆盖的文件：compositions/sN.html 才是逐场手改的地方，
    # 只保护 index.html 会让一次重跑把分镜改回骨架。
    targets = ["index.html"] + [f"compositions/{sc['id']}.html" for sc in model["scenes"]]
    if not args.force:
        overwritten = [name for name in targets if os.path.exists(os.path.join(proj, name))]
        if overwritten:
            fail("已存在：" + "、".join(overwritten)
                 + "；重跑会覆盖逐场手改，确认要覆盖时加 --force")

    # 场景时间窗检查：有空隙会黑屏，重叠会让后面那场看不到前一段（只警告，不改用户时间轴）。
    scenes = model["scenes"]
    for a, b in zip(scenes, scenes[1:]):
        a_end = a["start"] + a["duration"]
        if b["start"] > a_end + 0.001:
            print(f"  ! 时间窗有 {num_text(round(b['start'] - a_end, 2))}s 空隙"
                  f"（{a['id']} → {b['id']}）：会露出空白/黑屏")
        elif b["start"] < a_end - 0.001:
            print(f"  ! 时间窗重叠 {num_text(round(a_end - b['start'], 2))}s"
                  f"（{a['id']} → {b['id']}）：后一场的前段看不到")

    # 全部内容在内存里渲染完（渲染阶段不应再失败），再整体落盘。
    files = {"index.html": render_index(model)}
    for sc in scenes:
        files[f"compositions/{sc['id']}.html"] = render_scene(sc["id"], sc, model)
    commit_files(proj, files)

    print(f"✓ 生成 {len(scenes)} 个场景 + 根合成：{proj}")
    print(f"  时长 {num_text(model['duration'])}s / {model['width']}×{model['height']} / "
          f"{num_text(model['fps'])}fps" + ("  / 含旁白" if model["voice"] else "  / 无音轨"))

    if args.check:
        # 复用 mcs.mjs 的 CLI 探测（install.json / HYPERFRAMES_CLI）：这里再写一份
        # 只能在 ~/openmotion 下找的逻辑，Windows 上就永远“跳过 check”还退 0。
        mcs = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mcs.mjs")
        node = shutil.which("node") or shutil.which("node.exe")
        if node is None or not os.path.exists(mcs):
            fail("--check 需要 node 与同目录的 mcs.mjs：找不到就是没校验，不能当作通过")
        print("\n== hyperframes check（经 mcs.mjs，失败即非 0） ==")
        return subprocess.run([node, mcs, "check", proj]).returncode
    return 0


if __name__ == "__main__":
    sys.exit(main())
