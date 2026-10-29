#!/usr/bin/env bash
# NeoxMacSpeech — 编译成 arm64 静态 CLI, 输出到 ../../resources/mac-speech/neox-mac-speech
#
# 用法:
#   ./build.sh           # arm64 (Apple Silicon)
#   ./build.sh universal # 双架构 (arm64 + x86_64)
#
# 需要: Xcode 15+ / Swift 5.9+
# 检查: xcode-select -p 应指向 /Applications/Xcode.app/Contents/Developer 或 CommandLineTools

set -euo pipefail

cd "$(dirname "$0")"

MODE="${1:-arm64}"
OUT_DIR="../../resources/mac-speech"
BIN_NAME="neox-mac-speech"

if ! command -v swift >/dev/null 2>&1; then
  echo "❌ swift 未装 — 需要 Xcode 或 Command Line Tools"
  echo "   装法: xcode-select --install"
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "📦 Building NeoxMacSpeech ($MODE)…"
if [ "$MODE" = "universal" ]; then
  swift build -c release --arch arm64 --arch x86_64
  cp .build/apple/Products/Release/neox-mac-speech "$OUT_DIR/$BIN_NAME"
elif [ "$MODE" = "x86_64" ]; then
  swift build -c release --arch x86_64
  cp .build/x86_64-apple-macosx/release/neox-mac-speech "$OUT_DIR/$BIN_NAME"
else
  swift build -c release --arch arm64
  cp .build/arm64-apple-macosx/release/neox-mac-speech "$OUT_DIR/$BIN_NAME"
fi

chmod +x "$OUT_DIR/$BIN_NAME"

# 📦 打包成 minimal .app bundle — macOS TCC 只对 .app 内的 Info.plist 生效,
# Mach-O 内嵌 __info_plist 对 privacy 权限不认 (2026-07-13 crash log 实证).
APP_BUNDLE="$OUT_DIR/NeoxMacSpeech.app"
echo "📦 Packaging as .app bundle → $APP_BUNDLE"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
cp "$OUT_DIR/$BIN_NAME" "$APP_BUNDLE/Contents/MacOS/$BIN_NAME"
cp Sources/NeoxMacSpeech/Info.plist "$APP_BUNDLE/Contents/Info.plist"

# 🔐 Ad-hoc 签名整个 .app bundle — hardened runtime + mic entitlement
echo "🔐 Codesigning (ad-hoc)…"
codesign --force --deep --sign - \
  --entitlements entitlements.plist \
  --options runtime \
  "$APP_BUNDLE"
codesign -dv --entitlements - "$APP_BUNDLE" 2>&1 | head -10 || true

# 保留独立 binary 以防调试用, 但主进程 spawn 走 .app 版
chmod +x "$APP_BUNDLE/Contents/MacOS/$BIN_NAME"

echo "✅ Built:"
ls -la "$APP_BUNDLE/Contents/MacOS/$BIN_NAME"
ls -la "$APP_BUNDLE/Contents/Info.plist"

# 快速 smoke test — 直接跑 .app 内的 executable
echo ""
echo "🧪 Smoke test (from .app):"
echo '{"cmd":"quit"}' | "$APP_BUNDLE/Contents/MacOS/$BIN_NAME" | head -3 || true
