#!/usr/bin/env bash
# 成片核查：画幅/帧率/时长/音轨/响度/语句落点。
#
# 实现只有一份，在 scripts/mcs.mjs（Windows / macOS / Linux 通用）。
# 用法：
#   verify-av.sh <file.mp4> [--expect-w 1080] [--expect-h 1920] [--expect-fps 30]
#                            [--expect-dur 40.5] [--expect-audio required|silent|optional]
# 退出码 1 表示有 FAIL。
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${MCS_NODE:-node}" "$DIR/mcs.mjs" verify "$@"
