#!/usr/bin/env bash
# 环境自检：按本次要做的产物检查依赖，打印 OK / MISSING 与安装提示。
#
# 实现只有一份，在 scripts/mcs.mjs（同一个文件在 Windows / macOS / Linux 都能跑）。
# 用法：preflight.sh [--page] [--cards] [--video] [--images] [--all] [--json]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${MCS_NODE:-node}" "$DIR/mcs.mjs" preflight "$@"
