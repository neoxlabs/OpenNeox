/// high_refresh_rate.dart — 让 Android 用上屏幕的最高刷新率.
///
/// **为什么需要显式请求** (2026-09-18 用户: 「apk 的 60fps 120hz 等要丝滑
/// 丝滑 性能必须优异」)
///
/// Android 上 Flutter **默认跑在 60Hz**, 即使手机是 90/120/144Hz 的屏。
/// 系统只对自己认识的场景自动升频, app 不申请就一直是 60 —— 也就是说我们之前
/// 在任何高刷手机上都是 60 帧封顶, 再怎么优化也不可能"丝滑"。这跟掉帧是两件
/// 不同的事: 一个是帧数上限, 一个是每帧来不来得及。
///
/// iOS 不需要做任何事: ProMotion 由系统按内容自动切, 而 Flutter 的
/// CADisplayLink 已经声明了它要高刷。
///
/// 失败一律吞掉: 拿不到高刷是"不够好", 不是"用不了"。
library;

import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter_displaymode/flutter_displaymode.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 已经切到的模式 —— 只为诊断打印, 不参与任何判断.
String? lastAppliedDisplayMode;

/// 申请屏幕支持的最高刷新率 (同分辨率里挑最高帧率).
///
/// 挑法上**不换分辨率**: `setHighRefreshRate` 会在多档分辨率里挑,
/// 有些机型的最高帧率档位分辨率更低 —— 那是拿清晰度换帧率, 不该我们替用户定。
/// 这里锁住当前分辨率, 只在同分辨率的模式里选帧率最高的那个。
Future<void> applyHighRefreshRate() async {
  if (kIsWeb || !Platform.isAndroid) return;
  try {
    final modes = await FlutterDisplayMode.supported;
    if (modes.isEmpty) return;
    final active = await FlutterDisplayMode.active;

    /* 同分辨率的候选; 一台机器上通常是 60 / 90 / 120 三档 */
    final sameSize = modes
        .where((m) => m.width == active.width && m.height == active.height)
        .toList();
    final pool = sameSize.isEmpty ? modes : sameSize;
    pool.sort((a, b) => b.refreshRate.compareTo(a.refreshRate));
    final best = pool.first;

    if (best.refreshRate <= active.refreshRate) {
      lastAppliedDisplayMode = tr('${active.refreshRate}Hz (已是最高)');
      return;
    }
    await FlutterDisplayMode.setPreferredMode(best);
    lastAppliedDisplayMode =
        '${best.width}x${best.height}@${best.refreshRate}Hz';
    if (kDebugMode) {
      debugPrint('[display] 切到 $lastAppliedDisplayMode (原 ${active.refreshRate}Hz)');
    }
  } catch (e) {
    /* 不支持 / 厂商 ROM 拒绝 / 插件不可用 —— 保持 60Hz 继续跑 */
    if (kDebugMode) debugPrint('[display] 申请高刷失败: $e');
  }
}
