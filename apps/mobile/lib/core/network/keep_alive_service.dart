/// 电脑上任务在跑时切后台的保活前台服务 (Android 原生侧见 KeepAliveService.kt)。
///
/// 只有安卓有这个问题 (进程被冻结); 其他平台调用直接忽略。
library;

import 'dart:io';

import 'package:flutter/services.dart';

import 'package:neox_app/core/i18n/tr.dart';

class KeepAliveService {
  KeepAliveService._();
  static const _ch = MethodChannel('neox.sync/keepalive');
  static bool _running = false;

  static Future<void> start() async {
    if (!Platform.isAndroid || _running) return;
    try {
      _running = await _ch.invokeMethod<bool>('start', {'title': tr('Neox 正在跟电脑同步任务')}) ?? false;
    } catch (_) {
      _running = false;
    }
  }

  static Future<void> stop() async {
    if (!Platform.isAndroid || !_running) return;
    _running = false;
    try {
      await _ch.invokeMethod<void>('stop');
    } catch (_) {}
  }
}
