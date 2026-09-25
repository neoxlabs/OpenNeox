#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# cdp-eval —— 桌面端 CDP 全能力评测, **独立于发包流程**。
#
# 定位 (2026-09-09 用户拍板):
#   · 不进打包/发版脚本。发包前要测是"我让你测"的时候单独跑, 不是每次打包都跑。
#   · 可以定时跑 (见底部 launchd 示例), 跑完出报告, 报告里带 token 消耗。
#   · 判据取界面上看得见的东西, 用真模型跑 —— 单测绿而界面错的那一类只有这里能拦。
#
# 前置: 桌面 dev 或打包版带 NEOX_CDP_PORT=41777 起着, 且配好了可用 provider。
#       这脚本**不负责启动应用** —— 启动方式因人而异 (dev / 打包版 / 不同 profile),
#       混进来只会让失败原因变得含糊。应用没起就直接退出并说清楚。
#
# 用法:
#   scripts/cdp-eval.sh                      # 跑所有 cdp 用例
#   scripts/cdp-eval.sh --module desktop.approval
#   scripts/cdp-eval.sh --tier deep          # 只跑花 token 的深度用例
#   NEOX_EVAL_OUT=~/neox-evals scripts/cdp-eval.sh
# ══════════════════════════════════════════════════════════════════════════════
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CDP_URL="${NEOX_CDP:-http://127.0.0.1:41777}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_ROOT="${NEOX_EVAL_OUT:-$REPO_ROOT/.tmp-test/cdp-eval}"
OUT_DIR="$OUT_ROOT/$STAMP"

# 代理会吞掉 127.0.0.1 的 CDP 连接 —— 这条坑踩过, 直接在这里摘掉
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy

if ! curl -s --max-time 3 "$CDP_URL/json/version" >/dev/null 2>&1; then
  echo "✗ 连不上 CDP ($CDP_URL) —— 桌面端没起, 或者没带 NEOX_CDP_PORT=41777。"
  echo "  dev:  NEOX_CDP_PORT=41777 NEOX_ENABLE_CDP=1 npm run dev:desktop:prod:debug"
  exit 2
fi

mkdir -p "$OUT_DIR"
echo "▶ CDP 评测 → $OUT_DIR"

cd "$REPO_ROOT"
npx tsx packages/test-harness/src/cli.ts run \
  --mode cdp \
  --cdp "$CDP_URL" \
  --out "$OUT_DIR" \
  "$@" 2>&1 | tee "$OUT_DIR/console.log"
STATUS=${PIPESTATUS[0]}

echo
if [ -f "$OUT_DIR/report.md" ]; then
  echo "── 报告 ──"
  sed -n '1,12p' "$OUT_DIR/report.md"
  echo "完整报告: $OUT_DIR/report.md"
fi
exit "$STATUS"

# ── 定时跑 (macOS launchd) ────────────────────────────────────────────────────
# 每天 03:00 跑一次, 报告堆在 ~/neox-evals/<时间戳>/:
#
# cat > ~/Library/LaunchAgents/com.mk-co.neox.cdp-eval.plist <<'PLIST'
# <?xml version="1.0" encoding="UTF-8"?>
# <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
# <plist version="1.0"><dict>
#   <key>Label</key><string>com.mk-co.neox.cdp-eval</string>
#   <key>ProgramArguments</key>
#   <array>
#     <string>/bin/bash</string>
#     <string>-lc</string>
#     <string>NEOX_EVAL_OUT=$HOME/neox-evals /Users/你/AI/OpenNeox/scripts/cdp-eval.sh</string>
#   </array>
#   <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
#   <key>StandardOutPath</key><string>/tmp/neox-cdp-eval.log</string>
#   <key>StandardErrorPath</key><string>/tmp/neox-cdp-eval.err</string>
# </dict></plist>
# PLIST
# launchctl load ~/Library/LaunchAgents/com.mk-co.neox.cdp-eval.plist
#
# ⚠️ 定时跑的前提是那台机器上桌面端**一直开着**且带 CDP 端口。没开就是 exit 2,
#    报告里不会有假绿 —— 这是故意的, "没跑" 不能长得像 "跑过了没问题"。
