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
生成后仍要逐场改文案与节奏；脚本只保证结构、字体、安全区、动画基线是对的。
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

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


def hex_to_rgb(c):
    c = c.lstrip("#")
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def norm_hex(c):
    return c if c.startswith("#") else "#" + c


def scene_css(sid, sc, theme):
    kind = sc.get("kind", "paper")
    lines = sc.get("title") or [""]
    body = sc.get("body")
    stats = sc.get("stats") or []
    title_size = sc.get("titleSize") or (228 if len(lines) == 1 and len(lines[0]) <= 6 else
                                         120 if len(lines) <= 2 else 96)
    body_size = sc.get("bodySize") or 42
    title_top = sc.get("titleTop", 250)
    title_h = title_size * 1.12 * len(lines)
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
                   f"object-position:{sc.get('photoPos','50% 40%')}}}")
        veil = sc.get("veil", 0.62)
        r, g, b = hex_to_rgb(theme["ink"])
        css.append(f"    #{sid}-veil{{position:absolute;inset:0;background:rgba({r},{g},{b},{veil});"
                   f"display:flex;flex-direction:column;justify-content:flex-end;padding:0 0 380px}}")
    elif ink_kind:
        css.append(f"    #{sid}-bg{{position:absolute;inset:0;background:{theme['ink']}}}")
    else:
        css.append(f"    #{sid}-bg{{position:absolute;inset:0;background:{theme['paper']}}}")
    content_bottom = stats_top if stats else (body_top + int(body_size * 1.5 * max(1, -(-len(body) // 20))) if body else title_top + title_h)
    if content_bottom > 1300:
        print(f"  ! {sid} 内容底部约 {content_bottom}px，超出 1300px 安全区：删字或调小 titleSize/bodySize")
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
    kind = sc.get("kind", "paper")
    parts = []
    if kind == "photo":
        parts.append(f'    <div id="{sid}-photo" data-hf-id="{sid}-photo">'
                     f'<img src="{sc["photo"]}" alt=""></div>')
        parts.append(f'    <div id="{sid}-veil" data-hf-id="{sid}-veil">')
    else:
        parts.append(f'    <div id="{sid}-bg" data-hf-id="{sid}-bg"></div>')
    inner = []
    if sc.get("kicker"):
        inner.append(f'      <p id="{sid}-kicker" data-hf-id="{sid}-kicker">{sc["kicker"]}</p>')
    lines = sc.get("title") or []
    if lines:
        br = "<br>".join(lines)
        inner.append(f'      <h2 id="{sid}-title" data-hf-id="{sid}-title">{br}</h2>')
    if sc.get("body"):
        inner.append(f'      <p id="{sid}-body" data-hf-id="{sid}-body">{sc["body"]}</p>')
    if sc.get("stats"):
        rows = []
        for i, st in enumerate(sc["stats"]):
            rows.append(f'        <div data-hf-id="{sid}-st{i}">'
                        f'<div class="lbl" data-hf-id="{sid}-st{i}l">{st["label"]}</div>'
                        f'<div class="val" data-hf-id="{sid}-st{i}v">{st["value"]}</div></div>')
        inner.append(f'      <div id="{sid}-stats" data-hf-id="{sid}-stats">\n' + "\n".join(rows) + "\n      </div>")
    parts.extend(inner)
    if kind == "photo":
        parts.append("    </div>")
    return "\n".join(parts)


def scene_script(sid, sc, dur, is_first=False):
    kind = sc.get("kind", "paper")
    tl = ["    window.__timelines = window.__timelines || {};",
          "    const tl = gsap.timeline({ paused: true });",
          '    const F = "power3.out", E = "power2.out";']
    if kind == "photo":
        tl.append(f'    tl.fromTo("#{sid}-photo img", {{ scale: 1.12 }}, '
                  f'{{ scale: 1.0, duration: {dur}, ease: "none" }}, 0);')
    if sc.get("kicker"):
        tl.append(f'    tl.fromTo("#{sid}-kicker", {{ opacity: 0, y: 20 }}, '
                  f'{{ opacity: 0.6, y: 0, duration: 0.45, ease: E }}, 0.12);')
    if sc.get("title"):
        if is_first:
            # 第 0 帧就是封面：标题直接在场，只做轻微放大，避免 first_frame_empty
            tl.append(f'    tl.fromTo("#{sid}-title", {{ opacity: 1, scale: 1 }}, '
                      f'{{ scale: 1.04, duration: {max(0.2, dur):.2f}, ease: "none" }}, 0);')
        else:
            tl.append(f'    tl.fromTo("#{sid}-title", {{ opacity: 0, y: 44 }}, '
                      f'{{ opacity: 1, y: 0, duration: 0.65, ease: F }}, 0.26);')
    if sc.get("body"):
        tl.append(f'    tl.fromTo("#{sid}-body", {{ opacity: 0, y: 24 }}, '
                  f'{{ opacity: 0.86, y: 0, duration: 0.55, ease: E }}, 0.9);')
    if sc.get("stats"):
        tl.append(f'    tl.fromTo("#{sid}-stats", {{ opacity: 0, y: 30 }}, '
                  f'{{ opacity: 1, y: 0, duration: 0.6, ease: E }}, 0.9);')
    # 收尾缓动，避免 dead_stretch（3 秒不动会被 lint 判为空洞）
    if not is_first:
        tl.append(f'    tl.fromTo("#{sid}-title", {{ scale: 1 }}, '
                  f'{{ scale: 1.03, duration: {max(0.1, dur - 1.2):.2f}, ease: "none" }}, 1.2);')
    tl.append(f'    window.__timelines["{sid}"] = tl;')
    return "\n".join(tl)


def probe_duration(path):
    """用 ffprobe 读真实时长；读不到返回 None。"""
    if not shutil.which("ffprobe") or not os.path.exists(path):
        return None
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                              "-of", "default=nw=1:nk=1", path],
                             capture_output=True, text=True, check=True).stdout.strip()
        return round(float(out), 2)
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser(description="生成竖屏视频骨架")
    ap.add_argument("--dir", required=True, help="OpenMotion 工程目录（含 assets/gsap.min.js）")
    ap.add_argument("--scenes", required=True, help="scenes.json")
    ap.add_argument("--check", action="store_true", help="生成后跑 hyperframes check")
    ap.add_argument("--force", action="store_true", help="覆盖已存在的 index.html / compositions")
    args = ap.parse_args()

    proj = os.path.abspath(args.dir)
    spec = json.load(open(args.scenes, encoding="utf-8"))
    width = spec.get("width", 1080)
    height = spec.get("height", 1920)
    fps = spec.get("fps", 30)
    duration = spec.get("duration")
    theme = {k: norm_hex(v) for k, v in (spec.get("theme") or {}).items()}
    theme.setdefault("paper", "#f1f3f5")
    theme.setdefault("ink", "#0a1f3d")
    theme.setdefault("accent", "#315d93")
    scenes = spec["scenes"]
    # 场景 id 会进文件名与 HTML 属性，白名单外的字符（分隔符、冒号、引号）既不安全也会写出坏路径。
    for sc in scenes:
        sid = str(sc.get("id", ""))
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", sid):
            sys.exit(f"场景 id 只能是字母、数字、下划线和连字符（收到：{sid!r}）")
    if not duration:
        duration = round(max(s["start"] + s["duration"] for s in scenes), 2)
    # 场景时间窗检查：有空隙会黑屏，重叠会让后面那场看不到前一段
    ordered = sorted(scenes, key=lambda x: float(x["start"]))
    for a, b in zip(ordered, ordered[1:]):
        a_end = float(a["start"]) + float(a["duration"])
        b_start = float(b["start"])
        if b_start > a_end + 0.001:
            print(f"  ! 时间窗有 {b_start - a_end:.2f}s 空隙（{a['id']} → {b['id']}）：会露出空白/黑屏")
        elif b_start < a_end - 0.001:
            print(f"  ! 时间窗重叠 {a_end - b_start:.2f}s（{a['id']} → {b['id']}）：后一场的前段看不到")
    comp_dir = os.path.join(proj, "compositions")
    os.makedirs(comp_dir, exist_ok=True)
    if not os.path.exists(os.path.join(proj, "assets", "gsap.min.js")):
        sys.exit("工程里没有 assets/gsap.min.js —— 先 openmotion_create_project 创建工程")
    # --force 要保护所有会被覆盖的文件：compositions/sN.html 才是逐场手改的地方，
    # 只保护 index.html 会让一次重跑把分镜改回骨架。
    if not args.force:
        overwritten = [name for name in
                       ["index.html", *[f"compositions/{sc['id']}.html" for sc in scenes]]
                       if os.path.exists(os.path.join(proj, name))]
        if overwritten:
            sys.exit("已存在：" + "、".join(overwritten)
                     + "；重跑会覆盖逐场手改，确认要覆盖时加 --force")

    # 场景文件
    for sc in scenes:
        sid = sc["id"]
        dur = float(sc["duration"])
        html = f"""<template>
  <style>
{FONT_FACES}{scene_css(sid, sc, theme)}
  </style>
  <div id="root" data-composition-id="{sid}" data-width="{width}" data-height="{height}">
{scene_markup(sid, sc)}
  </div>
  <script>
{scene_script(sid, sc, dur, float(sc['start']) == 0)}
  </script>
</template>
"""
        open(os.path.join(proj, "compositions", f"{sid}.html"), "w", encoding="utf-8").write(html)

    # 根合成
    hosts = "\n".join(
        f'  <div id="{s["id"]}" data-hf-id="host-{s["id"]}" data-composition-id="{s["id"]}"'
        f' data-composition-src="compositions/{s["id"]}.html" data-start="{s["start"]}"'
        f' data-duration="{s["duration"]}" data-track-index="1"'
        f' data-width="{width}" data-height="{height}"></div>'
        for s in scenes)
    voice = spec.get("voice") or {}
    audio = ""
    if voice.get("src"):
        fade = voice.get("fadeOut", 0.5)
        src = voice["src"]
        voice_path = src if os.path.isabs(src) else os.path.join(proj, src)
        # 缺音频仍写 <audio src> 会得到一条指向空文件的音轨，而成片必须有声：
        # 这是硬失败，不是警告（继续生成还要 --force 才能重跑，等于把问题埋进工程）。
        if not os.path.exists(voice_path):
            sys.exit(f"找不到旁白音频 {src}：先导入音频（openmotion_import_assets），"
                     f"或从 scenes.json 里删掉 voice 再重新生成")
        # data-duration 要用音频文件的真实长度（不匹配会被 lint 提示 clip_media_fit）
        real = probe_duration(voice_path)
        if real is None:
            want = voice.get("duration")
            print("  ! 读不出旁白音频时长（ffprobe 缺失或文件损坏）："
                  + (f"暂用声明时长 {want}s" if want else "先用 ffprobe 确认文件"))
        adur = min(real or voice.get("duration") or duration, duration)
        audio = (f'  <audio id="vo" data-hf-id="audio-vo" class="clip" data-start="0"'
                 f' data-duration="{adur}" data-track-index="2"'
                 f' data-volume="1" data-fade-out="{fade}" src="{voice["src"]}"></audio>\n')
    variables = json.dumps([
        {"id": "headline", "type": "string", "label": "主标", "default": (spec.get("scenes") or [{}])[0].get("title", [""])[0]},
    ], ensure_ascii=False)

    index = f"""<!doctype html>
<html lang="zh-CN" data-composition-variables='{variables}'>
<head>
<meta charset="utf-8">
<title>{spec.get("title", "竖屏短片")}</title>
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
     data-duration="{duration}" data-width="{width}" data-height="{height}" data-fps="{fps}">
{hosts}
  <div id="prog" data-hf-id="prog"></div>
{audio}</div>
<script>
  window.__timelines = window.__timelines || {{}};
  const tl = gsap.timeline({{ paused: true }});
  tl.fromTo("#prog", {{ scaleX: 0 }}, {{ scaleX: 1, duration: {duration}, ease: "none" }}, 0);
  window.__timelines["main"] = tl;
</script>
</body>
</html>
"""
    open(os.path.join(proj, "index.html"), "w", encoding="utf-8").write(index)
    print(f"✓ 生成 {len(scenes)} 个场景 + 根合成：{proj}")
    print(f"  时长 {duration}s / {width}×{height} / {fps}fps" + ("  / 含旁白" if audio else "  / 无音轨"))

    if args.check:
        # 复用 mcs.mjs 的 CLI 探测（install.json / HYPERFRAMES_CLI）：这里再写一份
        # 只能在 ~/openmotion 下找的逻辑，Windows 上就永远“跳过 check”还退 0。
        mcs = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mcs.mjs")
        node = shutil.which("node") or shutil.which("node.exe")
        if node is None or not os.path.exists(mcs):
            sys.exit("--check 需要 node 与同目录的 mcs.mjs：找不到就是没校验，不能当作通过")
        print("\n== hyperframes check（经 mcs.mjs，失败即非 0） ==")
        return subprocess.run([node, mcs, "check", proj]).returncode
    return 0


if __name__ == "__main__":
    sys.exit(main())
