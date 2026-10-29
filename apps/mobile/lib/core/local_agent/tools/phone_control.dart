/// Phone Use 操控中悬浮层的 Dart 门面 (2026-10-12), 原生在 ControlOverlay.kt。
///
/// phone_ui 每做一步就 [begin] (悬浮层亮着, 胶囊上写当前在干嘛); Agent 这一轮跑完 [end] —— 收起并回到 Neox。
/// 用户点悬浮层上的「停止」→ 原生回调 stop → [onStop] 取消正在跑的 Agent。
///
/// 只有 phone_ui (真的在别的 App 里点点按按) 才亮; 单纯 open_app 打开地图导航不算操控, 不亮也不拉回来。
library;

import 'dart:io';

import 'package:flutter/services.dart';

import '../../i18n/tr.dart';

class PhoneControl {
  PhoneControl._();

  static const _ch = MethodChannel('neox.phone/control');
  static bool _active = false;
  static bool _wired = false;
  /// 这一轮真在别的 App 里点按过 (phone_ui) —— 只有这种结束时才把用户拉回 Neox;
  /// 只是 open_app 打开地图导航的, 收起悬浮层就好, 不拉回来
  static bool _controlled = false;

  /// 用户在悬浮层上点了「停止」—— phone_local_agent 接上, 取消正在跑的那一轮
  static void Function()? onStop;

  static bool get active => _active;

  static void _wire() {
    if (_wired) return;
    _wired = true;
    _ch.setMethodCallHandler((call) async {
      if (call.method == 'stop') {
        _active = false;
        onStop?.call();
      }
      return null;
    });
  }

  /// 亮起 / 更新胶囊上的这一步 (「在读聊天」「在点按」…)
  static Future<void> begin(String step, {bool control = true}) async {
    if (!Platform.isAndroid) return;
    _wire();
    _active = true;
    if (control) _controlled = true;
    try {
      /* 胶囊上的字在这边按界面语言拼好再给原生 —— 原生写死中文, 英文界面也是「Neox 正在操控」 */
      final title = tr('Neox 正在操控');
      await _ch.invokeMethod('show', {
        'step': step,
        'label': step.isEmpty ? title : '$title · ${tr(step)}',
        'stop': tr('停止'),
      });
    } catch (_) {/* 悬浮层出不来不影响操作本身 */}
  }

  /// 收起; [returnHome] 回到 Neox (跳到别的 App 里, 用户自己回不来)
  static Future<void> end({bool returnHome = true}) async {
    if (!_active) return;
    _active = false;
    final back = returnHome && _controlled;
    _controlled = false;
    try {
      await _ch.invokeMethod('hide', {'returnHome': back});
    } catch (_) {}
  }

  /// 回到 Neox 前台 (要在 Neox 里问用户点头时); 悬浮层亮着也一并收起
  static Future<void> bringNeoxFront() async {
    if (!Platform.isAndroid) return;
    _active = false;
    _controlled = false;
    try {
      await _ch.invokeMethod('front');
    } catch (_) {}
  }

  /// phone_ui 每个 op 在胶囊上怎么说
  static String stepOf(String op) => switch (op) {
        'snapshot' => '在看屏幕',
        'read_text' => '在读内容',
        'tap' || 'tap_at' => '在点按',
        'type' => '在输入',
        'scroll' => '在翻页',
        'screenshot' => '在看截图',
        'back' => '在返回',
        'home' => '回桌面',
        _ => '处理中',
      };
}
