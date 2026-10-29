#!/usr/bin/env bash
# build-release.sh — Neox mobile 发布构建 (Android)
#
# 为什么必须走这个脚本, 不能裸跑 `flutter build apk --release`:
#
#   1. 后端地址显式打印并写进归档 (2026-08-08 加)
#      默认就是生产 (https://neox-dev.com — 域名带 dev 只是历史命名, 它是正式
#      环境). 不传 NEOX_API_BASE 完全正常, 脚本会把实际用的地址打出来并写进
#      build-info.txt, 这样将来拿到任何一个包都说得清它连的是谁.
#      要出连别的环境的包时显式传:
#        NEOX_API_BASE=http://<gateway-host> ./scripts/build-release.sh apk
#
#   2. --obfuscate --split-debug-info
#      这是 Flutter 侧**唯一真正有效的反逆向手段**. 不加的话, Dart AOT 产物
#      (libapp.so) 里完整保留类名/方法名/字段名符号表, 用 Blutter / reFlutter
#      这类现成工具能把业务逻辑还原到接近源码的可读程度 —— R8 只混淆 Java 层,
#      对 Dart 代码一点作用都没有.
#      加上之后符号被替换成无意义短名, 符号表被剥离到外部 symbols 目录.
#
#   3. symbols 目录必须留档
#      混淆后线上 crash 堆栈是乱码, 只有配套的 symbols 才能 `flutter symbolize`
#      还原. 每个发布版本的 symbols 必须归档, 丢了就永远读不懂那个版本的崩溃日志.
#
#   4. 代理必须摘掉
#      本机 HTTP_PROXY 指向 127.0.0.1:7890 时会劫持构建过程里的本地回环连接,
#      表现为 pub / gradle 各种玄学失败 (flutter test 也踩过同一个坑).
#
# 用法:
#   NEOX_API_BASE=https://api.example.com ./scripts/build-release.sh apk
#   NEOX_API_BASE=https://api.example.com ./scripts/build-release.sh bundle
#   ./scripts/build-release.sh ipa                    # App Store 上传包 (iOS)
#   IOS_EXPORT=release-testing ./scripts/build-release.sh ipa   # Ad Hoc, 数据线直装登记过的 iPhone
#
#   iOS 必须用 Xcode 26 (上传要 iOS 26 SDK): 脚本默认指向 /Applications/Xcode-26.3.0.app,
#   不改全局 xcode-select。签名走自动签名 (Xcode 里登录的 24D88Q3K3S 账号)。
#
#   可选 NEOX_RELAY_BASE (不给则跟 NEOX_API_BASE 同值 — 跟客户端常量的默认口径
#   一致: relay 现在跟 control-plane 共用一个 host, 将来独立域名时再分).
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="${1:-apk}"
VERSION=$(grep '^version:' pubspec.yaml | awk '{print $2}')
SYMBOLS_DIR="build/symbols/${VERSION}"
# iOS 的符号表跟安卓的同版本号, 分开放 —— 混在一个目录里 symbolize 时分不清是哪端的
[ "$TARGET" = "ipa" ] && SYMBOLS_DIR="build/symbols/${VERSION}-ios"

# ── 1. 后端地址 ────────────────────────────────────────────────────────────
# 默认取代码里的生产常量, 保持跟 neox_constants.dart 单一真相一致.
PROD_API_BASE=$(grep -oE "kNeoxProductionApiBase = '[^']+'" lib/core/neox_constants.dart | head -1 | sed "s/.*'\(.*\)'/\1/")
NEOX_API_BASE="${NEOX_API_BASE:-$PROD_API_BASE}"
# relay 不给就跟 api 同值 (对齐 neox_constants.dart 里两个常量的默认关系)
NEOX_RELAY_BASE="${NEOX_RELAY_BASE:-$NEOX_API_BASE}"

if [ "$NEOX_API_BASE" != "$PROD_API_BASE" ]; then
  echo "⚠ 非生产后端: $NEOX_API_BASE (生产是 $PROD_API_BASE)" >&2
  echo "  这个包不要发到应用商店." >&2
fi

case "$NEOX_API_BASE" in
  https://*) ;;
  http://*)
    echo "⚠ NEOX_API_BASE 是明文 http:// — 仅限内网/测试, 发行包不要这样." >&2
    ;;
  *)
    echo "✗ NEOX_API_BASE 必须带 scheme (https:// 或 http://): $NEOX_API_BASE" >&2
    exit 1
    ;;
esac

# ── 2. 签名 ────────────────────────────────────────────────────────────────
EXTRA_ARGS=()
if [ "$TARGET" = "ipa" ]; then
  export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode-26.3.0.app/Contents/Developer}"
  # 先整段读进变量再取行 —— `xcodebuild -version | head -1` 在 pipefail 下会因 SIGPIPE (141) 把脚本带崩
  XCODE_LINE=$(xcodebuild -version)
  XCODE_LINE=${XCODE_LINE%%$'\n'*}
  XCODE_MAJOR=$(awk '{print $2}' <<<"$XCODE_LINE" | cut -d. -f1)
  if [ "${XCODE_MAJOR:-0}" -lt 26 ]; then
    echo "✗ iOS 包要 Xcode 26+ (App Store 只收 iOS 26 SDK 编的包), 现在是 $XCODE_LINE" >&2
    exit 1
  fi
  IOS_EXPORT="${IOS_EXPORT:-app-store-connect}"
  EXPORT_PLIST="build/ios-export-${IOS_EXPORT}.plist"
  mkdir -p build
  cat > "$EXPORT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>${IOS_EXPORT}</string>
  <key>teamID</key><string>24D88Q3K3S</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST
  EXTRA_ARGS+=(--export-options-plist="$EXPORT_PLIST")
  echo "▸ 导出   $IOS_EXPORT · $XCODE_LINE"
elif [ ! -f android/key.properties ]; then
  echo "✗ android/key.properties 不存在 — 会回落 debug 签名, 发布产物绝不能这样." >&2
  echo "  见 android/app/build.gradle.kts 顶部注释配置真 keystore." >&2
  exit 1
fi

mkdir -p "$SYMBOLS_DIR"

# ── 3. 构建 ────────────────────────────────────────────────────────────────
echo "▸ 版本   $VERSION"
echo "▸ 后端   $NEOX_API_BASE"
echo "▸ 中继   $NEOX_RELAY_BASE"
echo "▸ symbols → $SYMBOLS_DIR"
echo

env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    -u http_proxy -u https_proxy -u all_proxy \
  flutter build "$TARGET" \
    --release \
    --obfuscate \
    --split-debug-info="$SYMBOLS_DIR" \
    --dart-define=NEOX_API_BASE="$NEOX_API_BASE" \
    --dart-define=NEOX_RELAY_BASE="$NEOX_RELAY_BASE" \
    ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} \
    "${@:2}"

# 构建元信息落盘, 跟 symbols 一起归档 —— 将来拿到一个包问"这是哪版、连的谁",
# 有据可查. app 内也能自证 (设置 → 关于 → 服务器环境), 两边对得上.
cat > "$SYMBOLS_DIR/build-info.txt" <<EOF
version   = $VERSION
target    = $TARGET
api_base  = $NEOX_API_BASE
relay_base= $NEOX_RELAY_BASE
built_at  = $(date -u '+%Y-%m-%dT%H:%M:%SZ')
git_sha   = $(git rev-parse --short HEAD 2>/dev/null || echo unknown)
EOF

echo
echo "✓ 构建完成 · 后端 $NEOX_API_BASE"
echo "  归档提醒: $SYMBOLS_DIR 必须跟版本一起留档 (含 build-info.txt),"
echo "  否则该版本线上崩溃堆栈无法 symbolize, 也说不清它连的哪个环境."
