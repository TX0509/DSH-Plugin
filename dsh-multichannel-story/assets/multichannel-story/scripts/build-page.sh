#!/usr/bin/env bash
# 渲染网页长文并做两条必要后处理：竖幅人像收窄、删除工具品牌页脚。
#
# 实现只有一份，在 scripts/mcs.mjs（Windows / macOS / Linux 通用）。
# 用法：
#   build-page.sh <项目目录> [--out 文件名.html] [--style magazine|swiss]
#                [--theme ink-classic|indigo-porcelain|…] [--embed]
#                [--brand "#76B900"]        # 品牌色（插件会生成受约束主题）
#                [--cap-fig "文件名:宽:高"]   # 可重复；竖幅人像按栏宽收窄
#
# 项目目录里需要有 article.md 与 annotations.json。
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${MCS_NODE:-node}" "$DIR/mcs.mjs" page "$@"
