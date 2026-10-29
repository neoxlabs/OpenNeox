#!/usr/bin/env bash
# 从 simple-icons (CC0) 拉浏览器 brand SVG 到 assets/icons/browsers/
#
#   跟 fetch-file-type-icons.sh 同源同协议, 只是产物目录和用途不同:
#   这些 mark 用来标识「外置浏览器模式下真正被拉起的是哪个浏览器」
#   (Chrome / Edge / Brave —— 见 services/externalChrome/chromeLauncher.ts 的查找顺序)。
#
# 跑这个脚本会覆盖 assets/icons/browsers/*.svg, 重新同步上游最新版.
# 不要手改这些 SVG — 改了下次跑脚本就被覆盖.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/src/ui/renderer/assets/icons/browsers"
mkdir -p "$OUT"

# jsDelivr CDN — 国内可达性比 raw.githubusercontent 好很多
SI_BASE="https://cdn.jsdelivr.net/npm/simple-icons@latest/icons"

# simple-icons slug → 我们项目里的 brand id (.svg 文件名)
#
# ⚠️ chromium 不在这里: simple-icons 已下架 chromium mark (2026-08 实测 404)。
#    Chromium 与 Chrome 是同一套外形, 渲染时复用 googlechrome.svg + Chromium 蓝,
#    详见 assets/icons/browsers/LICENSE-NOTICE.md。
declare -a SPEC=(
  "googlechrome.svg   googlechrome"
  "microsoftedge.svg  microsoftedge"
  "brave.svg          brave"
)

ok=0; fail=0
for line in "${SPEC[@]}"; do
  read -r src dst <<< "$line"
  url="$SI_BASE/$src"
  out="$OUT/$dst.svg"
  code=$(curl -sL -o "$out.tmp" -w "%{http_code}" -m 20 "$url" || echo 000)
  if [[ "$code" == "200" && -s "$out.tmp" ]]; then
    mv "$out.tmp" "$out"
    printf "  ✓ %-16s ← %s\n" "$dst.svg" "$src"
    ok=$((ok+1))
  else
    rm -f "$out.tmp"
    printf "  ✗ %-16s (HTTP %s) %s\n" "$dst.svg" "$code" "$url"
    fail=$((fail+1))
  fi
done

if [[ ! -f "$OUT/LICENSE-NOTICE.md" ]]; then
cat > "$OUT/LICENSE-NOTICE.md" <<'EOF'
# Browser Brand Icons — Source & License

Fetched by `apps/desktop/scripts/fetch-browser-icons.sh` from the
**simple-icons** project, published under **CC0 1.0 Universal** (public domain).

- Project: https://github.com/simple-icons/simple-icons
- License: https://creativecommons.org/publicdomain/zero/1.0/

Each mark is the trademark of its respective owner. We use them only to identify
which browser Neox launched on the user's machine (nominative use) — descriptive,
and implying no affiliation, endorsement, or sponsorship.

## Chromium 没有独立 mark
simple-icons 已下架 `chromium` slug (2026-08 实测 404)。Chromium 与 Google Chrome
外形本就是同一套, 区别只在配色, 所以渲染层对 chromium 复用 `googlechrome.svg`,
配 Chromium 蓝 (#4587F3) 而不是 Chrome 的 #4285F4。见
`modules/surface/viewers/BrowserBrandIcon.tsx` 的 BROWSER_BRANDS。

## 为什么是单色
simple-icons 的 mark 一律是单 path 无 fill 的单色图形。渲染时由
`BrowserBrandIcon` 注入官方 brand hex —— 跟 FileTypeIcon 完全同一套做法
(见 assets/icons/file-types/LICENSE-NOTICE.md)。

To re-sync:

    bash apps/desktop/scripts/fetch-browser-icons.sh
EOF
else
  echo "  · LICENSE-NOTICE.md 已存在, 保留"
fi

echo
echo "Done. ok=$ok fail=$fail"
echo "Output: $OUT"
