#!/usr/bin/env bash
# 从 simple-icons (CC0) 拉文件类型 brand SVG 到 assets/icons/file-types/
#
#   主源: simple-icons — github.com/simple-icons/simple-icons (CC0, 完全公共领域)
#   备源: vscode-icons — github.com/vscode-icons/vscode-icons (MIT)
#
# 跑这个脚本会覆盖 assets/icons/file-types/*.svg, 重新同步上游最新版.
# 不要手改这些 SVG — 改了下次跑脚本就被覆盖. 要换 mark 改这里 URL.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/src/ui/renderer/assets/icons/file-types"
mkdir -p "$OUT"

# jsDelivr CDN — 国内可达性比 raw.githubusercontent 好很多
SI_BASE="https://cdn.jsdelivr.net/npm/simple-icons@latest/icons"

# 文件类型 → simple-icons slug → 我们项目里的 brand id (.svg 文件名)
# slug 在 https://simpleicons.org/ 上能搜
declare -a SPEC=(
  # 编程语言
  "typescript.svg          typescript"
  "javascript.svg          javascript"
  "react.svg               react"
  "python.svg              python"
  "ruby.svg                ruby"
  "php.svg                 php"
  "openjdk.svg             java"
  "kotlin.svg              kotlin"
  "scala.svg               scala"
  "rust.svg                rust"
  "go.svg                  go"
  "c.svg                   c"
  "cplusplus.svg           cpp"
  "csharp.svg              csharp"
  "swift.svg               swift"
  "dart.svg                dart"
  "lua.svg                 lua"
  "r.svg                   r"
  "gnubash.svg             shell"
  "perl.svg                perl"
  # Web 前端
  "html5.svg               html"
  # ⚠️ css 故意不在这里 — 2026-07-19 已换成 devicon 的 CSS3 盾牌 (与 html5 盾牌成对),
  #    simple-icons 新版 CSS mark 是实心圆角方块, 14px 下像个色块 (用户拍板"太丑")。
  #    从这里拉会把它覆盖回去, 详见 assets/icons/file-types/LICENSE-NOTICE.md。
  "sass.svg                sass"
  "less.svg                less"
  "vuedotjs.svg            vue"
  "svelte.svg              svelte"
  "astro.svg               astro"
  # 数据 / 配置
  "json.svg                json"
  "yaml.svg                yaml"
  "toml.svg                toml"
  "xml.svg                 xml"
  "graphql.svg             graphql"
  "mysql.svg               sql"
  # 文档
  "markdown.svg            markdown"
  "mdx.svg                 mdx"
  "latex.svg               latex"
  "adobeacrobatreader.svg  pdf"
  # 工具 / 平台
  "docker.svg              docker"
  "git.svg                 git"
  "npm.svg                 npm"
  "yarn.svg                yarn"
  "pnpm.svg                pnpm"
  "nodedotjs.svg           nodejs"
  "eslint.svg              eslint"
  "prettier.svg            prettier"
  "webpack.svg             webpack"
  "vite.svg                vite"
  "gnu.svg                 makefile"
  # 服务类型 (ServicesSurfaceViewer 的 ConfigKind — 每个服务卡片前的真实品牌 logo)
  "spring.svg              spring"
  "apachemaven.svg         maven"
  "gradle.svg              gradle"
  "bun.svg                 bun"
  "deno.svg                deno"
  "dotnet.svg              dotnet"
  "flutter.svg             flutter"
  # 媒体
  "svg.svg                 svg"
  # Office 类 (微软商标; 仅作 nominative use)
  "microsoftword.svg       word"
  "microsoftexcel.svg      excel"
  "microsoftpowerpoint.svg powerpoint"
)

ok=0
fail=0
for line in "${SPEC[@]}"; do
  read -r src dst <<< "$line"
  url="$SI_BASE/$src"
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

# license 说明 — simple-icons CC0 public domain
#
# ⚠️ 只在 NOTICE 不存在时生成。这个文件底部记着「哪些 mark 被手工换掉了、为什么」
#    (例: css.svg 换成 devicon 版), 无条件重写会把这些例外说明冲掉,
#    下一个人就不知道为什么不能直接从 simple-icons 拉 css 了。
if [[ ! -f "$OUT/LICENSE-NOTICE.md" ]]; then
cat > "$OUT/LICENSE-NOTICE.md" <<'EOF'
# File Type Icons — Source & License

These SVG marks are fetched by `apps/desktop/scripts/fetch-file-type-icons.sh`
from the **simple-icons** project, which is published under the **CC0 1.0 Universal**
(public domain dedication).

- Project: https://github.com/simple-icons/simple-icons
- License: https://creativecommons.org/publicdomain/zero/1.0/

Each brand mark is the trademark of its respective owner. We use them only to
identify the file type / language a given source file uses (nominative use),
which is descriptive and does not imply affiliation, endorsement, or sponsorship.

To re-sync after simple-icons updates:

    bash apps/desktop/scripts/fetch-file-type-icons.sh
EOF
else
  echo "  · LICENSE-NOTICE.md 已存在, 保留 (内含手工替换的例外说明)"
fi

echo
echo "Done. ok=$ok fail=$fail"
echo "Output: $OUT"
