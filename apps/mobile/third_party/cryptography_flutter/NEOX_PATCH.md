# cryptography_flutter 2.3.2 — Neox 本地补丁

上游: https://pub.dev/packages/cryptography_flutter (Apache-2.0, 见 LICENSE), 原样拷自 2.3.2,
去掉了 example/ 和 test/。

为什么不用 pub 上的版本:
- iOS 出口合规要它 (加密走系统 CryptoKit, 见 内部设计文档), 不能去掉。
- 2.3.4 用了 `meta` 的 `@internal`, 跟 Flutter 3.32 钉的 meta 编不过。
- 2.3.2 的安卓部分在当前 Flutter / AGP 8 下编不过, 安卓包整个打不出来。

改了两处, 都只在安卓侧:
1. `android/build.gradle` 加 `namespace` (AGP 8 必填)。
2. `CryptographyFlutterPlugin.kt` 删掉没用到的 `import ...PluginRegistry.Registrar`
   (v1 插件接口, Flutter 3.29 起已删除)。

3. `lib/src/flutter/flutter_hmac.dart`: 空密钥换成 32 字节全零再交给原生 HMAC。安卓 javax.crypto
   拒收空密钥, 而 HKDF 不给 salt 时 extract 就是空密钥 HMAC —— 安卓扫码配对派生会话密钥必挂
   (2026-10-28 开源版安卓模拟器实测 "Empty key")。HMAC 把短密钥补 0, 两者结果逐位相同。
   升级插件时这条要么保留, 要么确认上游已修。

升级 Flutter 后如果 2.3.4+ 能编过, 删掉这个目录和 pubspec 里的 dependency_overrides 即可。
