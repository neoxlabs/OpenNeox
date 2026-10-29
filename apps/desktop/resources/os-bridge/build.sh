#!/bin/bash
# 构建 neox-os-bridge —— 通用二进制 (arm64 + x86_64), 包成 .app bundle。
#
# 为什么要 .app 而不是裸二进制: macOS 的 TCC 认 bundle 身份 (Info.plist 里的
# bundle id + 用途说明). wakeWord 那座桥也是这么做的 (见 NeoxMacSpeech.app),
# 同一个坑不必再踩一次。裸二进制会同时保留一份, 供 dev 直跑。
#
# 用法: bash apps/desktop/resources/os-bridge/build.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
# ⚠️ bundle 的**目录名**就是用户在辅助功能列表里看到的名字 —— macOS 那个列表用文件名,
# 不用 CFBundleDisplayName。实测: 叫 NeoxOSBridge.app 时列表里就写着 "NeoxOSBridge"。
# 对标 "Codex Computer Use", 我们叫 "Neox Computer Use"。
APP_NAME="Neox Computer Use"
APP_DIR="$DIR/$APP_NAME.app"
OUT="$APP_DIR/Contents/MacOS"
BIN="$DIR/neox-os-bridge"

echo "[os-bridge] 编译 (arm64 + x86_64 通用二进制)…"
rm -rf "$DIR/NeoxOSBridge.app"   # 旧名字, 别留两份
mkdir -p "$OUT" "$APP_DIR/Contents/Resources"

SOURCES=("$DIR/src/Protocol.swift" "$DIR/src/SocketServer.swift" "$DIR/src/AXTree.swift" "$DIR/src/Input.swift" "$DIR/src/AXWatch.swift" "$DIR/src/Guard.swift" "$DIR/src/main.swift")

swiftc -O -whole-module-optimization \
  -target arm64-apple-macos11.0 \
  -o "$DIR/.build-arm64" "${SOURCES[@]}"

if swiftc -O -whole-module-optimization \
  -target x86_64-apple-macos11.0 \
  -o "$DIR/.build-x86_64" "${SOURCES[@]}" 2>/dev/null; then
  lipo -create -output "$BIN" "$DIR/.build-arm64" "$DIR/.build-x86_64"
  rm -f "$DIR/.build-x86_64"
else
  echo "[os-bridge] ⚠️  x86_64 交叉编译不可用, 只出 arm64"
  cp "$DIR/.build-arm64" "$BIN"
fi
rm -f "$DIR/.build-arm64"

cp "$BIN" "$OUT/neox-os-bridge"
# 图标 —— 列表里没图标的那一行看着像个来路不明的东西, 用户不敢勾
REPO_ROOT="$(cd "$DIR/../../../.." && pwd)"
[ -f "$REPO_ROOT/build/icon.icns" ] && cp "$REPO_ROOT/build/icon.icns" "$APP_DIR/Contents/Resources/icon.icns"
chmod +x "$BIN" "$OUT/neox-os-bridge"

cat > "$APP_DIR/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>neox-os-bridge</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundleIdentifier</key><string>com.mk.neox.os-bridge</string>
  <key>CFBundleName</key><string>Neox Computer Use</string>
  <key>CFBundleDisplayName</key><string>Neox Computer Use</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>LSBackgroundOnly</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSAccessibilityUsageDescription</key>
  <string>Neox Computer Use 需要辅助功能权限来读取界面元素并代你操作。</string>
</dict>
PLIST
echo '</plist>' >> "$APP_DIR/Contents/Info.plist"

# 签名 —— 两件事都指着它:
#
# ① **不签的 .app 会被系统直接 SIGKILL**。实测: 裸二进制跑得好好的, 同一份拷进
#    .app bundle 后一启动就死, 宿主看到的是 "桥进程退出 (signal=SIGKILL)"。
#
# ② **ad-hoc 签名的身份是 cdhash, 二进制一变就变** —— 于是每次重建桥, TCC 里那条
#    「Neox Computer Use」的授权立刻失效, 用户前脚勾完后脚就不认了 (真机上撞到过:
#    用户说"勾了啊", 而 trusted 仍然是 false)。
#    用 Developer ID 签则 requirement 是 team id + bundle id, 重建不影响, 而且跟
#    打包版是**同一个身份** —— dev 授权一次, 打包版直接就是授权的。
#
# 所以: 有 Developer ID 就用它, 没有才退回 ad-hoc (并说清楚代价)。
SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null \
  | grep -o '"Developer ID Application: [^"]*"' | head -1 | tr -d '"')"
if [ -n "$SIGN_ID" ]; then
  if codesign --force --sign "$SIGN_ID" --options runtime --timestamp=none "$APP_DIR" >/dev/null 2>&1; then
    echo "[os-bridge] 签名 ✓ $SIGN_ID  (重建不掉授权)"
  else
    codesign --force --sign - --timestamp=none "$APP_DIR" >/dev/null 2>&1
    echo "[os-bridge] ⚠️  Developer ID 签名失败, 退回 ad-hoc —— 每次重建都要重新授权"
  fi
else
  codesign --force --sign - --timestamp=none "$APP_DIR" >/dev/null 2>&1
  echo "[os-bridge] ⚠️  没有 Developer ID, 用 ad-hoc —— 每次重建都要重新授权"
fi

echo "[os-bridge] ✓ $(lipo -archs "$BIN" 2>/dev/null || echo arm64) · $(du -h "$BIN" | cut -f1)"
"$BIN" --probe || true
