#!/usr/bin/env bash
# 生成「品牌主题」并可选注入到 HTML / 输出给视频用。
#
# 插件的 gz-theme.mjs 会把品牌色收进杂志风（压彩度）或瑞士风（保留鲜度）的明度/彩度区间，
# 直接生成一套完整 token，不要让模型自己写颜色值。
#
# 实现只有一份，在 scripts/mcs.mjs（Windows / macOS / Linux 通用）。
# 用法：
#   brand-theme.sh "#76B900"                      # 打印注释 + [data-theme="brand"] 块
#   brand-theme.sh "#76B900" --family swiss
#   brand-theme.sh "#76B900" --apply page.html     # 注入 <style id="brand-theme"> 并切到 data-theme="brand"
#   brand-theme.sh "#76B900" --tokens              # 输出 paper/ink/accent（给视频 scenes.json 用）
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${MCS_NODE:-node}" "$DIR/mcs.mjs" brand "$@"
