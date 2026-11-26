#!/usr/bin/env python3
"""逐句 TTS + 延时混音，输出一条与视频等长的音轨（默认中文男声）。

用法：
    python3 tts.py spec.json --out vo.mp3
    python3 tts.py --list-voices [--locale zh-CN]

spec.json:
{
  "voice": "zh-CN-YunjianNeural",
  "rate": "+8%",
  "pitch": "-1Hz",
  "total_duration": 40.5,
  "min_gap": 0.15,
  "segments": [
    {"id": "s1", "start": 0.15, "text": "辞职十一天，他又回来了。"},
    {"id": "s2", "start": 4.75, "text": "十一月十二号，他辞掉全部职务。一周跌掉两成三。"}
  ]
}

做的事：逐句生成（每句独立节奏）→ ffprobe 实测时长 → 检查相邻句是否重叠 →
adelay 逐句延时 + amix 混音 + loudnorm 响度归一 + apad 补到视频时长 → 48kHz 立体声 192kbps MP3。
同时写出 <out>.json 记录每句实测时长与落点，方便审片。
"""
import argparse
import asyncio
import json
import os
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

DEFAULT_VOICE = "zh-CN-YunjianNeural"


def _ensure_deps():
    """保证当前解释器能 import edge_tts；否则找一个能用的重新执行自己。"""
    try:
        import edge_tts  # noqa: F401
        return
    except Exception:
        pass
    import os as _os
    cands = [_os.environ.get("DSH_PYTHON"),
             _os.path.expanduser("~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3"),
             "/opt/homebrew/bin/python3", "/usr/local/bin/python3"]
    for name in ("python3", "python3.13", "python3.12", "python3.11"):
        found = shutil.which(name)
        if found:
            cands.append(found)
    for cand in cands:
        if not cand or not _os.path.exists(cand):
            continue
        try:
            subprocess.run([cand, "-c", "import edge_tts"], check=True,
                           capture_output=True)
        except Exception:
            continue
        _os.execv(cand, [cand, _os.path.abspath(__file__)] + sys.argv[1:])
    sys.exit("找不到装有 edge-tts 的 python：python3 -m pip install edge-tts（或设 DSH_PYTHON）")


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def probe_duration(path):
    out = run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", path,
    ]).stdout.strip()
    return round(float(out), 3)


async def list_voices(locale_filter):
    import edge_tts
    voices = await edge_tts.list_voices()
    rows = []
    for v in voices:
        if locale_filter and not v["Locale"].startswith(locale_filter):
            continue
        rows.append((v["ShortName"], v.get("Gender", ""),
                     ",".join(v.get("VoiceTag", {}).get("VoicePersonalities", []))))
    return rows


async def synth(text, voice, rate, pitch, path):
    import edge_tts
    comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
    await comm.save(path)
    if not os.path.getsize(path):
        raise RuntimeError(f"空音频：{text[:20]}")


def main():
    ap = argparse.ArgumentParser(description="逐句 TTS + 延时混音")
    ap.add_argument("spec", nargs="?", help="spec.json 路径")
    ap.add_argument("--out", default="vo.mp3", help="输出音轨（默认 vo.mp3）")
    ap.add_argument("--list-voices", action="store_true", help="列出可用音色")
    ap.add_argument("--locale", default="zh-CN", help="音色语言过滤（默认 zh-CN）")
    ap.add_argument("--workdir", default=None, help="临时目录（默认系统临时目录）")
    args = ap.parse_args()

    if args.list_voices:
        _ensure_deps()
        for name, gender, tags in asyncio.run(list_voices(args.locale)):
            print(f"{name:32s} {gender:6s} {tags}")
        return 0

    if not args.spec:
        ap.error("需要 spec.json（或用 --list-voices）")

    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"缺少 {tool}，先安装（brew install ffmpeg）")
    _ensure_deps()

    if not os.path.exists(args.spec):
        sys.exit(f"找不到 spec：{args.spec}")
    try:
        spec = json.load(open(args.spec, encoding="utf-8"))
    except json.JSONDecodeError as e:
        sys.exit(f"spec.json 不是合法 JSON：{e}")
    voice = spec.get("voice", DEFAULT_VOICE)
    rate = spec.get("rate", "+8%")
    pitch = spec.get("pitch", "-1Hz")
    total = float(spec.get("total_duration") or 0)
    min_gap = float(spec.get("min_gap", 0.15))
    segments = spec.get("segments") or []
    if not segments:
        sys.exit("spec.segments 为空")
    # 允许乱序书写：按起点排序后再做重叠检查与混音
    segments = sorted(segments, key=lambda x: float(x.get("start", 0)))

    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    work = tempfile.mkdtemp(prefix="tts-", dir=args.workdir)
    try:
        metas = []
        for seg in segments:
            sid = seg.get("id") or f"seg{len(metas)+1}"
            path = os.path.join(work, f"{sid}.mp3")
            asyncio.run(synth(seg["text"], voice, rate, pitch, path))
            dur = probe_duration(path)
            metas.append({
                "id": sid,
                "start": round(float(seg["start"]), 3),
                "text": seg["text"],
                "duration": dur,
                "end": round(float(seg["start"]) + dur, 3),
                "file": path,
            })
            print(f"  {sid:6s} start={metas[-1]['start']:6.2f}s  dur={dur:5.2f}s  end={metas[-1]['end']:6.2f}s  {seg['text']}")

        # 重叠检查
        problems = []
        for a, b in zip(metas, metas[1:]):
            if a["end"] + min_gap > b["start"]:
                problems.append(
                    f"{a['id']} 结束于 {a['end']:.2f}s，{b['id']} 起于 {b['start']:.2f}s（间隔不足 {min_gap}s）"
                )
        last_end = metas[-1]["end"] if metas else 0
        if total and last_end > total:
            problems.append(f"最后一句结束于 {last_end:.2f}s，超过总时长 {total:.2f}s")
        if problems:
            print("\n✗ 时间冲突，先改词或挪起点：", file=sys.stderr)
            for p in problems:
                print("  - " + p, file=sys.stderr)
            return 1

        # 混音
        cmd = ["ffmpeg", "-y", "-loglevel", "error"]
        for m in metas:
            cmd += ["-i", m["file"]]
        chains = []
        for idx, m in enumerate(metas):
            ms = int(round(m["start"] * 1000))
            chains.append(f"[{idx}:a]adelay={ms}|{ms}[a{idx}]")
        if len(metas) == 1:
            mix_in = "[a0]"
        else:
            mix_in = "".join(f"[a{idx}]" for idx in range(len(metas)))
        loud = spec.get("loudness", {})
        I = loud.get("I", -16)
        TP = loud.get("TP", -1.5)
        tail = f"loudnorm=I={I}:TP={TP}:LRA=11"
        if total:
            tail += f",apad=whole_dur={total:.3f}"
        if len(metas) == 1:
            chains.append(f"{mix_in}{tail}[out]")
        else:
            chains.append(f"{mix_in}amix=inputs={len(metas)}:normalize=0:duration=longest[mix];[mix]{tail}[out]")
        cmd += ["-filter_complex", ";".join(chains), "-map", "[out]",
                "-ar", "48000", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "192k", args.out]
        try:
            run(cmd)
        except subprocess.CalledProcessError as e:
            msg = (e.stderr or "").strip().splitlines()
            sys.exit("混音失败：" + (" / ".join(msg[-3:]) if msg else f"ffmpeg 退出码 {e.returncode}"))

        out_dur = probe_duration(args.out)
        side = {"voice": voice, "rate": rate, "pitch": pitch,
                "total_duration": total or out_dur, "output": os.path.abspath(args.out),
                "output_duration": out_dur, "segments": metas}
        with open(args.out + ".json", "w", encoding="utf-8") as f:
            json.dump(side, f, ensure_ascii=False, indent=1)

        # 响度体检
        vd = subprocess.run(["ffmpeg", "-hide_banner", "-i", args.out, "-af", "volumedetect", "-f", "null", "-"],
                            capture_output=True, text=True).stderr
        stats = [l.split("]")[-1].strip() for l in vd.splitlines() if "volume:" in l]
        print(f"\n✓ 生成 {args.out}  {out_dur:.2f}s  " + (" / ".join(stats) if stats else ""))
        print(f"  每句落点见 {args.out}.json")
        return 0
    finally:
        if not os.environ.get("KEEP_TTS_TMP"):
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
