#!/usr/bin/env bash
# 渲染小红书/公众号卡片，并在渲染前检查可见文本里是否混入了比例/尺寸标注。
#
# 实现只有一份，在 scripts/mcs.mjs（Windows / macOS / Linux 通用）。
# 用法：
#   build-cards.sh <任务目录> [--no-validate] [--seed editorial|swiss]
#
# 任务目录里应有 index.html（缺省时从 seed 模板拷贝一份并提示填写）。
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${MCS_NODE:-node}" "$DIR/mcs.mjs" cards "$@"
