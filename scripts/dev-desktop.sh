#!/usr/bin/env bash
#
# Neox 桌面 dev 启动 (全调试 + CDP + 缓存探针)
# ------------------------------------------------------------------
# 一键起桌面 dev,带满调试环境。给"用 CDP 驱动测试 / 排查缓存·上下文"用。
# 正式版这些 flag 全默认关,只在这里(dev)显式打开。
#
# 用法:
#   bash scripts/dev-desktop.sh
#   ./scripts/dev-desktop.sh          # chmod +x 后
#
# 关键端口:
#   CDP        127.0.0.1:41777   (Playwright connectOverCDP 驱动)
#   DevTools   127.0.0.1:7399
#   Vite(UI)   127.0.0.1:5180
# 日志:
#   server → /tmp/neox-server.log
#   UI/vite → /tmp/uidev.log (本脚本 tee)
# ------------------------------------------------------------------

set -o pipefail
cd "$(dirname "$0")/.." || exit 1

env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    NEOX_PROFILE=prod \
    NEOX_API_BASE=https://neox-dev.com \
    NEOX_GATEWAY_BASE=https://gateway.neox-dev.com \
    NEOX_WEB_BASE=https://neox-dev.com \
    NEOX_CDP_PORT=41777 NEOX_ENABLE_CDP=1 \
    NEOX_DEBUG=1 NEOX_ASSISTANT_DEBUG=1 \
    NEOX_COMPACTION_DEBUG=1 NEOX_DUMP_COMPACTION=1 NEOX_DUMP_COMPACTION_TEXT=1 \
    NEOX_DEVTOOLS=1 NEOX_DEVTOOLS_PORT=7399 \
    NEOX_PROFILE_STARTUP=1 NEOX_VERBOSITY=debug \
    NEOX_DEV_ALLOW=1 NEOX_SKIP_ANTI_DEBUG=1 \
    NEOX_CACHE_PROBE=1 \
    NEOX_DUMP_LLM_PAYLOAD=1 \
    NEOX_LOG_FILE=/tmp/neox-server.log \
    ELECTRON_ENABLE_LOGGING=1 DEBUG='electron*,vite:*' \
    npm run dev:desktop 2>&1 | tee /tmp/uidev.log

# NEOX_CACHE_PROBE=1 → 开启逐推理前缀缓存诊断 (runner.ts):
#   每次推理 hash system/tools/每条消息, 与上一次对比, 标出第一个变动的段/消息索引,
#   随 token_usage 事件进 PERF 日志的 cacheBreak 字段 (~/.neox/logs/neox-app-*.log)。
#   排查"缓存命中低/前缀被打穿"用。有 per-message hash 开销, 正式版默认关。
