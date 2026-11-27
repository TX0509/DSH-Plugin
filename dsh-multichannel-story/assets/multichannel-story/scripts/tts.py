#!/usr/bin/env python3
"""逐句 TTS + 延时混音，输出一条与视频等长的音轨（默认中文男声）。

用法：
    python3 tts.py spec.json --out vo.mp3 [--force] [--workdir DIR]
    python3 tts.py --list-voices [--locale zh-CN]

spec.json:
{
  "voice": "zh-CN-YunjianNeural",
  "rate": "+8%",
  "pitch": "-1Hz",
  "total_duration": 40.5,          ← 必填且 > 0：混音按它补齐并校验长度
  "min_gap": 0.2,           ← 句间最小停顿（秒），与 voice.md 的口播节奏一致
  "loudness": {"I": -16, "TP": -1.5},
  "segments": [
    {"id": "s1", "start": 0.15, "text": "辞职十一天，他又回来了。"},
    {"id": "s2", "start": 4.75, "text": "十一月十二号，他辞掉全部职务。一周跌掉两成三。"}
  ]
}

做的事：入口一次性校验 spec（id 白名单 + 唯一、text 非空、start 数值、total_duration 必填、
响度区间）→ 逐句生成（失败退避重试）→ ffprobe 实测时长 → 检查相邻句是否重叠 →
adelay 逐句延时 + amix 混音 + loudnorm 响度归一 + apad 补到视频时长 → 48kHz 立体声 192kbps MP3。
混音后校验输出时长与 total_duration 的偏差，并打印整轨 LUFS / 真峰（不达标只警告，不假装通过）。
同时写出 <out>.json 记录每句实测时长与落点，方便审片。
"""
import argparse
import asyncio
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

# Windows 的控制台与管道默认按 GBK 编码：打印中文或 ✓ 会直接 UnicodeEncodeError。
# 这个脚本总是被 mcs / Agent 以管道调用，所以固定成 UTF-8，别让一行日志把整步打挂。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

DEFAULT_VOICE = "zh-CN-YunjianNeural"
# 片段 id 只做日志/元数据：白名单与 scaffold-video.py 保持一致，杜绝路径穿越。
ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
# 每句最多尝试 3 次（首发 + 2 次重试），退避 0.5s / 1s。
RETRY_DELAYS = (0.5, 1.0)
# 混音后允许的输出时长偏差（秒）；超过就是某一截被截断或 total_duration 写错。
DUR_TOLERANCE = 0.15
# 响度体检阈值：整轨积分响度偏离目标超过 1 LUFS、或真峰高于 -1.0 dBFS 就警告。
LOUDNESS_TOLERANCE = 1.0
TRUE_PEAK_LIMIT = -1.0
# 允许的 loudnorm 取值范围（超出基本可判定是写错，而不是想调风格）。
I_RANGE = (-70.0, -5.0)
TP_RANGE = (-9.0, 0.0)


def _interpreters():
    """列出可能装有 edge-tts 的解释器（按优先级）；不写死任何用户目录。"""
    cands = []

    env_python = os.environ.get("DSH_PYTHON")
    if env_python:
        cands.append([env_python])
    for name in ("python3", "python", "python3.13", "python3.12", "python3.11"):
        found = shutil.which(name)
        if found:
            cands.append([found])
    # Windows 的启动器：py -3（`python` 往往是 Store 别名，不能直接用）。
    launcher = shutil.which("py")
    if launcher:
        cands.append([launcher, "-3"])
    # 与当前解释器同级的兄弟解释器（嵌入式 runtime / 虚拟环境常见形态）。
    exe_dir = os.path.dirname(os.path.abspath(sys.executable or ""))
    for name in ("python3", "python", "python3.exe", "python.exe"):
        sibling = os.path.join(exe_dir, name)
        if os.path.exists(sibling):
            cands.append([sibling])
    # 去重但保持顺序
    seen = set()
    uniq = []
    for cand in cands:
        key = tuple(cand)
        if key not in seen:
            seen.add(key)
            uniq.append(cand)
    return uniq


def _ensure_deps():
    """保证当前解释器能 import edge_tts；否则找一个能用的重新执行自己。"""
    try:
        import edge_tts  # noqa: F401
        return
    except Exception:
        pass
    hint = "找不到装有 edge-tts 的 python：python3 -m pip install edge-tts（或设 DSH_PYTHON）"
    if os.environ.get("DSH_TTS_REEXEC"):
        # 已经换过一次解释器还是 import 不到，说明候选也不带 edge-tts，别再来回 exec 成死循环。
        sys.exit(hint)
    here = os.path.abspath(__file__)
    for cand in _interpreters():
        if len(cand) == 1 and not os.path.exists(cand[0]):
            continue
        try:
            probe = subprocess.run(cand + ["-c", "import edge_tts"], capture_output=True,
                                   encoding="utf-8", errors="replace")
        except Exception:
            continue
        if probe.returncode != 0:
            continue
        env = dict(os.environ, DSH_TTS_REEXEC="1")
        os.execve(cand[0], cand + [here] + sys.argv[1:], env)
    sys.exit(hint)


def run(cmd, **kw):
    # 固定 UTF-8：Windows 默认 GBK 会让 ffmpeg 输出里的中文/符号解码失败。
    return subprocess.run(cmd, check=True, capture_output=True,
                          encoding="utf-8", errors="replace", **kw)


def probe_duration(path):
    """ffprobe 读真实时长；读不到就抛错（由上层决定是重试还是失败）。"""
    out = run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", path,
    ]).stdout.strip()
    if not out:
        raise RuntimeError(f"ffprobe 没有返回时长：{os.path.basename(path)}")
    return round(float(out), 3)


def _is_number(value):
    """数值校验：bool 是 int 的子类，这里必须排除。"""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _fmt_db(value):
    if value is None:
        return "?"
    if math.isinf(value):
        return "-∞"
    return f"{value:.1f}"


def validate_spec(spec):
    """入口一次性校验 spec：全部通过才返回规范化结果，绝不先花 TTS 请求再失败。"""
    if not isinstance(spec, dict):
        sys.exit("spec.json 顶层必须是对象")
    segments = spec.get("segments")
    if not isinstance(segments, list) or not segments:
        sys.exit("spec.segments 必须是非空数组（每句一个 {id,text,start}）")

    total = spec.get("total_duration")
    if total is None:
        sys.exit("spec.total_duration 必填：混音要按它补足长度并校验音轨，缺失会静默生成过短的旁白")
    if not _is_number(total) or total <= 0:
        sys.exit(f"spec.total_duration 必须是 > 0 的数值（收到：{total!r}）")

    loud = spec.get("loudness", {}) or {}
    if not isinstance(loud, dict):
        sys.exit("spec.loudness 必须是对象，例：{\"I\": -16, \"TP\": -1.5}")
    loud_i = loud.get("I", -16)
    loud_tp = loud.get("TP", -1.5)
    for key, value, (low, high) in (("I", loud_i, I_RANGE), ("TP", loud_tp, TP_RANGE)):
        if not _is_number(value):
            sys.exit(f"spec.loudness.{key} 必须是数值（收到：{value!r}）")
        if not low <= value <= high:
            sys.exit(f"spec.loudness.{key} 超出合理区间 {low}~{high}（收到：{value}）")

    min_gap = spec.get("min_gap", 0.2)
    if not _is_number(min_gap) or min_gap < 0:
        sys.exit(f"spec.min_gap 必须是 >= 0 的数值（收到：{min_gap!r}）")

    voice = spec.get("voice", DEFAULT_VOICE)
    if not isinstance(voice, str) or not voice.strip():
        sys.exit(f"spec.voice 必须是非空字符串（收到：{voice!r}）")
    rate = spec.get("rate", "+8%")
    pitch = spec.get("pitch", "-1Hz")
    for label, value in (("rate", rate), ("pitch", pitch)):
        if not isinstance(value, str) or not value.strip():
            sys.exit(f"spec.{label} 必须是非空字符串（收到：{value!r}）")

    seen = set()
    normalized = []
    for index, seg in enumerate(segments, 1):
        if not isinstance(seg, dict):
            sys.exit(f"第 {index} 条 segment 必须是对象")
        sid = seg.get("id")
        if not isinstance(sid, str) or not ID_RE.fullmatch(sid):
            sys.exit(f"第 {index} 条 segment 的 id 非法：{sid!r}"
                     "（只允许字母、数字、下划线、连字符，1–64 字符）")
        if sid in seen:
            sys.exit(f"第 {index} 条 segment 的 id 重复：{sid!r}（重复 id 会让后一句覆盖前一句的音频）")
        seen.add(sid)
        text = seg.get("text")
        if not isinstance(text, str) or not text.strip():
            sys.exit(f"第 {index} 条（id={sid}）text 不能为空")
        start = seg.get("start")
        if not _is_number(start) or start < 0:
            sys.exit(f"第 {index} 条（id={sid}）start 必须是 >= 0 的数值（收到：{start!r}）")
        if start >= total:
            sys.exit(f"第 {index} 条（id={sid}）start={start}s 不小于 total_duration={total}s，"
                     "会被整句截掉")
        normalized.append({"id": sid, "text": text, "start": round(float(start), 3)})

    return {
        "voice": voice.strip(),
        "rate": rate,
        "pitch": pitch,
        "total_duration": float(total),
        "min_gap": float(min_gap),
        "loudness": {"I": float(loud_i), "TP": float(loud_tp)},
        # 允许乱序书写：按起点排序后再做重叠检查与混音
        "segments": sorted(normalized, key=lambda item: item["start"]),
    }


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
    if not os.path.exists(path) or not os.path.getsize(path):
        raise RuntimeError(f"空音频：{text[:20]}")


def synthesize_with_retry(index, sid, text, voice, rate, pitch, path):
    """单句合成：最多 3 次尝试，退避 0.5s / 1s；仍失败就给出可操作的退出信息。"""
    last_error = None
    for attempt in range(len(RETRY_DELAYS) + 1):
        try:
            asyncio.run(synth(text, voice, rate, pitch, path))
            return
        except Exception as error:  # 网络断流 / 返回空音频 / 文件写不出
            last_error = error
            if attempt < len(RETRY_DELAYS):
                delay = RETRY_DELAYS[attempt]
                print(f"  ! 第 {index} 句（id={sid}）合成失败（{type(error).__name__}: {error}），"
                      f"{delay}s 后重试（第 {attempt + 2}/{len(RETRY_DELAYS) + 1} 次）",
                      file=sys.stderr)
                time.sleep(delay)
    sys.exit(f"第 {index} 句（id={sid}）合成失败，已重试 {len(RETRY_DELAYS)} 次："
             f"{type(last_error).__name__}: {last_error}\n"
             "  建议：换一个音色（改 spec.voice，可用 tts.py --list-voices 看候选）、"
             "检查网络后重跑，或稍后再试")


def measure_loudness(path):
    """用 ebur128 解析整轨积分响度与真峰；两个都可能读到 -inf。读不到返回 (None, None)。"""
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", path,
         "-af", "ebur128=peak=true", "-f", "null", "-"],
        capture_output=True, encoding="utf-8", errors="replace")
    text = result.stderr or ""
    # 逐帧行与结尾 Summary 都会命中，取最后一个（Summary）。
    loudness = re.findall(r"(?:^|\s)I:[ \t]*(-?(?:\d+(?:\.\d+)?|inf))[ \t]*LUFS", text)
    peak = re.findall(r"Peak:[ \t]*(-?(?:\d+(?:\.\d+)?|inf))[ \t]*dBFS", text)
    return (float(loudness[-1]) if loudness else None,
            float(peak[-1]) if peak else None)


def main():
    ap = argparse.ArgumentParser(description="逐句 TTS + 延时混音")
    ap.add_argument("spec", nargs="?", help="spec.json 路径")
    ap.add_argument("--out", default="vo.mp3", help="输出音轨（默认 vo.mp3）")
    ap.add_argument("--force", action="store_true", help="允许覆盖已存在的输出与 sidecar")
    ap.add_argument("--list-voices", action="store_true", help="列出可用音色")
    ap.add_argument("--locale", default="zh-CN", help="音色语言过滤（默认 zh-CN）")
    ap.add_argument("--workdir", default=None, help="临时目录（默认系统临时目录；不存在会自动创建）")
    args = ap.parse_args()

    if args.list_voices:
        _ensure_deps()
        for name, gender, tags in asyncio.run(list_voices(args.locale)):
            print(f"{name:32s} {gender:6s} {tags}")
        return 0

    if not args.spec:
        ap.error("需要 spec.json（或用 --list-voices）")

    if not os.path.exists(args.spec):
        sys.exit(f"找不到 spec：{args.spec}")
    try:
        with open(args.spec, encoding="utf-8") as fh:
            raw_spec = json.load(fh)
    except json.JSONDecodeError as e:
        sys.exit(f"spec.json 不是合法 JSON：{e}")

    # 先把 spec 全量校验完（一次也不发 TTS 请求），再检查环境与输出路径。
    spec = validate_spec(raw_spec)

    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"缺少 {tool}，先安装（brew install ffmpeg / winget install ffmpeg）")

    out_path = os.path.abspath(args.out)
    out_side = out_path + ".json"
    if not args.force:
        if os.path.exists(out_path):
            sys.exit(f"输出已存在：{args.out}；确认覆盖时加 --force")
        if os.path.exists(out_side):
            sys.exit(f"sidecar 已存在：{args.out}.json；确认覆盖时加 --force")

    _ensure_deps()

    try:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
    except OSError as e:
        sys.exit(f"输出目录无法创建：{os.path.dirname(out_path)}（{e}）")

    if args.workdir:
        try:
            os.makedirs(args.workdir, exist_ok=True)
        except OSError as e:
            sys.exit(f"--workdir 无法创建：{args.workdir}（{e}）")

    out_tmp = out_path + ".tmp"
    side_tmp = out_side + ".tmp"
    work = None
    try:
        work = tempfile.mkdtemp(prefix="tts-", dir=args.workdir)
        metas = []
        total = spec["total_duration"]
        for index, seg in enumerate(spec["segments"], 1):
            sid = seg["id"]
            # 临时文件名用序号，id 只进日志/元数据：id 再怪也不会拼进路径。
            path = os.path.join(work, f"{index:03d}.mp3")
            synthesize_with_retry(index, sid, seg["text"], spec["voice"],
                                  spec["rate"], spec["pitch"], path)
            try:
                dur = probe_duration(path)
            except Exception as error:
                sys.exit(f"第 {index} 句（id={sid}）生成的音频读不出时长：{type(error).__name__}: {error}\n"
                         "  建议：检查 ffprobe 是否可用，或换音色重跑")
            if dur < 0.2:
                sys.exit(f"第 {index} 句（id={sid}）音频只有 {dur:.2f}s（疑似空音频）："
                         "换音色重跑（tts.py --list-voices）")
            metas.append({
                "id": sid,
                "start": seg["start"],
                "text": seg["text"],
                "duration": dur,
                "end": round(seg["start"] + dur, 3),
                # 只记临时文件名（basename），sidecar 里不出现临时目录的绝对路径。
                "file": os.path.basename(path),
            })
            print(f"  {sid:6s} start={metas[-1]['start']:6.2f}s  dur={dur:5.2f}s  "
                  f"end={metas[-1]['end']:6.2f}s  {seg['text']}")

        # 重叠检查
        problems = []
        for a, b in zip(metas, metas[1:]):
            if a["end"] + spec["min_gap"] > b["start"]:
                problems.append(
                    f"{a['id']} 结束于 {a['end']:.2f}s，{b['id']} 起于 {b['start']:.2f}s"
                    f"（间隔不足 {spec['min_gap']}s）"
                )
        last_end = metas[-1]["end"] if metas else 0
        if last_end > total:
            problems.append(f"最后一句结束于 {last_end:.2f}s，超过总时长 {total:.2f}s")
        if problems:
            print("\n✗ 时间冲突，先改词或挪起点：", file=sys.stderr)
            for p in problems:
                print("  - " + p, file=sys.stderr)
            return 1

        # 混音：先写 out.tmp，校验通过后再 os.replace，失败不会留下半条音轨。
        cmd = ["ffmpeg", "-y", "-loglevel", "error"]
        for m in metas:
            cmd += ["-i", os.path.join(work, m["file"])]
        chains = []
        for idx, m in enumerate(metas):
            ms = int(round(m["start"] * 1000))
            chains.append(f"[{idx}:a]adelay={ms}|{ms}[a{idx}]")
        if len(metas) == 1:
            mix_in = "[a0]"
        else:
            mix_in = "".join(f"[a{idx}]" for idx in range(len(metas)))
        loud = spec["loudness"]
        tail = f"loudnorm=I={loud['I']}:TP={loud['TP']}:LRA=11"
        tail += f",apad=whole_dur={total:.3f}"
        if len(metas) == 1:
            chains.append(f"{mix_in}{tail}[out]")
        else:
            chains.append(f"{mix_in}amix=inputs={len(metas)}:normalize=0:duration=longest[mix];"
                          f"[mix]{tail}[out]")
        cmd += ["-filter_complex", ";".join(chains), "-map", "[out]",
                "-ar", "48000", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "192k",
                "-f", "mp3", out_tmp]
        try:
            run(cmd)
        except subprocess.CalledProcessError as e:
            msg = (e.stderr or "").strip().splitlines()
            sys.exit("混音失败：" + (" / ".join(msg[-3:]) if msg else f"ffmpeg 退出码 {e.returncode}"))

        try:
            out_dur = probe_duration(out_tmp)
        except Exception as e:
            sys.exit(f"读不出混音产物时长：{type(e).__name__}: {e}")

        # 混音后长度校验：堵住「音轨被截断 / total_duration 写错」却 exit 0 的情况。
        diff = out_dur - total
        if abs(diff) > DUR_TOLERANCE:
            last = metas[-1]
            sys.exit(
                f"混音后时长 {out_dur:.2f}s 与 total_duration {total:.2f}s 相差 {diff:+.2f}s"
                f"（允许 ±{DUR_TOLERANCE}s）：最后一句 id={last['id']} 结束于 {last['end']:.2f}s。\n"
                "  检查 total_duration 是否写错，或某句过长把音轨撑长/被 apad 截断"
            )

        # 响度体检：正常路径用 loudnorm 归一，这里只实测并报告，不达标就明确警告。
        lufs, peak = measure_loudness(out_tmp)
        warnings = []
        if lufs is None:
            warnings.append("读不到整轨响度（ebur128 解析失败），请人工听一遍")
        else:
            if abs(lufs - loud["I"]) > LOUDNESS_TOLERANCE:
                warnings.append(f"整轨响度 {_fmt_db(lufs)} LUFS 偏离目标 {loud['I']} LUFS 超过 "
                                f"±{LOUDNESS_TOLERANCE}")
            if peak is None:
                warnings.append("读不到真峰（ebur128 解析失败）")
            elif peak > TRUE_PEAK_LIMIT:  # -inf（纯静音）不会命中这里
                warnings.append(f"真峰 {_fmt_db(peak)} dBFS 高于上限 {TRUE_PEAK_LIMIT} dBFS（有削波风险）")

        os.replace(out_tmp, out_path)
        side = {
            "voice": spec["voice"],
            "rate": spec["rate"],
            "pitch": spec["pitch"],
            "total_duration": total,
            # 只记 basename：sidecar 与音频同目录，写死绝对路径迁移时会失效。
            "output": os.path.basename(out_path),
            "output_duration": out_dur,
            "loudness": {"I": loud["I"], "TP": loud["TP"],
                         # ±inf 不是合法 JSON（Python 会写 -Infinity），落盘时换成 null
                         "measured_I": lufs if lufs is not None and math.isfinite(lufs) else None,
                         "measured_TP": peak if peak is not None and math.isfinite(peak) else None},
            "segments": metas,
        }
        with open(side_tmp, "w", encoding="utf-8") as f:
            json.dump(side, f, ensure_ascii=False, indent=1)
            f.write("\n")
        os.replace(side_tmp, out_side)

        print(f"\n✓ 生成 {args.out}  {out_dur:.2f}s / total_duration {total:.2f}s")
        print(f"  响度 {_fmt_db(lufs)} LUFS（目标 {loud['I']} ±{LOUDNESS_TOLERANCE}）"
              f" / 真峰 {_fmt_db(peak)} dBFS（上限 {TRUE_PEAK_LIMIT}）")
        for warning in warnings:
            print(f"  ⚠ 响度体检未通过：{warning}（仅警告，请人工复查）", file=sys.stderr)
        print(f"  每句落点见 {args.out}.json")
        return 0
    finally:
        # 失败时也清掉半成品，避免下次被 --force 保护挡在门外。
        for leftover in (out_tmp, side_tmp):
            try:
                os.remove(leftover)
            except OSError:
                pass
        if work and not os.environ.get("KEEP_TTS_TMP"):
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
