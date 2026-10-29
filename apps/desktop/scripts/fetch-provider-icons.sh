#!/usr/bin/env bash
# 从公开许可的 brand icon 仓库拉 SVG 到 assets/icons/providers/
#
#   主源: lobe-icons (MIT) — github.com/lobehub/lobe-icons
#   备源: simple-icons (CC0) — github.com/simple-icons/simple-icons
#
# 跑这个脚本会覆盖 assets/icons/providers/*.svg, 重新同步上游最新版.
# 不要手改这些 SVG — 改了下次跑脚本就被覆盖. 要换 brand mark 改这里 URL.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/src/ui/renderer/assets/icons/providers"
mkdir -p "$OUT"

LOBE_BASE="https://raw.githubusercontent.com/lobehub/lobe-icons/master/packages/static-svg/icons"

# brand → lobe-icons 文件名 (lobe 用什么名我们就跟着取, 第二列是我们项目里的 brand id)
declare -a SPEC=(
  "openai.svg            openai"
  "claude-color.svg      anthropic"
  "gemini-color.svg      gemini"
  "moonshot.svg          kimi"
  "deepseek-color.svg    deepseek"
  "zhipu-color.svg       glm"
  "doubao-color.svg      doubao"
  "qwen-color.svg        qwen"
  "grok.svg              xai"
  "mistral-color.svg     mistral"
  "minimax-color.svg     minimax"
  "hunyuan-color.svg     hunyuan"      # 腾讯混元 — opencode 上的 hy3/hy4-preview 走这个
  "meta-color.svg        meta"         # Meta — Muse Spark / Muse Wonder / Llama (OpenRouter meta/*)
  "openrouter.svg        openrouter"   # 多厂牌网关: 只按服务商名字/地址认, 模型名认出厂牌时让位给厂牌
  "opencode.svg          opencode"
)

ok=0
fail=0
for line in "${SPEC[@]}"; do
  read -r src dst <<< "$line"
  url="$LOBE_BASE/$src"
  out="$OUT/$dst.svg"
  code=$(curl -sL -o "$out.tmp" -w '%{http_code}' "$url" || echo 000)
  if [[ "$code" == "200" ]] && [[ -s "$out.tmp" ]]; then
    mv "$out.tmp" "$out"
    printf "  ✓ %-12s ← %s\n" "$dst" "$src"
    ok=$((ok+1))
  else
    rm -f "$out.tmp"
    printf "  ✗ %-12s (HTTP %s) %s\n" "$dst" "$code" "$src"
    fail=$((fail+1))
  fi
done

# license 说明 — lobe-icons MIT 要保留 attribution
cat > "$OUT/LICENSE-NOTICE.md" <<EOF
# Provider Icons — Source & License

These SVG marks are fetched by \`apps/desktop/scripts/fetch-provider-icons.sh\`
from the **lobe-icons** project, which is published under the **MIT License**.

- Project: https://github.com/lobehub/lobe-icons
- License: https://github.com/lobehub/lobe-icons/blob/master/LICENSE

Each brand mark is the trademark of its respective owner. We use them only to
identify which model provider a given chat is running on, which is descriptive /
nominative use. We don't claim affiliation, endorsement, or sponsorship.

To re-sync after lobe-icons updates:

    bash apps/desktop/scripts/fetch-provider-icons.sh
EOF

echo
echo "Done. ok=$ok fail=$fail"
echo "Output: $OUT"
