/// secure_screen.dart — 屏蔽截屏 + Recents 任务里的缩略图.
///
/// Android: FLAG_SECURE 走 native MainActivity 的 MethodChannel.
/// iOS: 用 `UIScreen.capturedDidChangeNotification` + 模糊覆盖层. 当前先 no-op,
///      iOS 出第一版前再补.
///
/// 用法:
///   - 全局 default: ON (MainActivity onCreate 已 set, 兜底)
///   - 想"信任的页面"放开 (e.g. 聊天页面) 可以 push 个 [SecureScreenScope](relax: true)
library;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

const _channel = MethodChannel('neox.security/screen');

class SecureScreen {
  static Future<void> setSecure() async {
    if (!defaultTargetPlatform.isAndroid) return;
    try {
      await _channel.invokeMethod('setSecure');
    } catch (_) {/* 老系统 / non-Android 静默忽略 */}
  }

  static Future<void> clearSecure() async {
    if (!defaultTargetPlatform.isAndroid) return;
    try {
      await _channel.invokeMethod('clearSecure');
    } catch (_) {}
  }
}

extension on TargetPlatform {
  bool get isAndroid => this == TargetPlatform.android;
}
