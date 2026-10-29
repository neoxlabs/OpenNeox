/// home_mode_switch.dart — 切首页模式 (对话 / 工作 / 编码) 时, 当前会话的归属处理 (chat:C1-03).
///
/// 以前切标签只改 `homeModeProvider`, 当前会话还留在 `currentSessionProvider` 里:
/// 用户在工作会话里点「改在对话里问」, 界面变成 Chat 了, 发出去的消息却还进那条工作会话
/// (跑的是工作档 prompt + 工具) —— 用户看到的是「明明在对话里, 它怎么开始干活了」。
///
/// 现在: 当前会话属于别的模式就**新开一条对话** (清掉 currentSession), 并把刚才那条会话的
/// 模式返回给调用方, 由它给一行提示说明会话留在了原处。
library;

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/storage/database.dart';
import 'current_session_provider.dart';
import 'home_mode_provider.dart';

/// 切到 [next] 时是否要把当前会话留在原处。返回被留下的会话的模式; null = 不用动。
///
/// 未知模式 (电脑会话没同步到 agentMode) 不拦: 判断不了归属就先按老行为走,
/// 比凭一次误判把用户的会话关掉强。
HomeMode? modeSwitchLeavesSession({
  required HomeMode? sessionMode,
  required HomeMode next,
}) {
  if (sessionMode == null) return null;
  return sessionMode == next ? null : sessionMode;
}

/// 只读 provider 的最小接口 —— 同时兼容 WidgetRef (界面) 和 ProviderContainer (测试)。
typedef ModeReader = T Function<T>(ProviderListenable<T> provider);

/// 切模式 + 该新开就新开。返回被留在原处的那条会话的模式 (用于提示), 没动会话时 null。
Future<HomeMode?> switchHomeMode(WidgetRef ref, HomeMode next) =>
    switchHomeModeWith(ref.read, next);

@visibleForTesting
Future<HomeMode?> switchHomeModeWith(ModeReader read, HomeMode next) async {
  final currentSessionId = read(currentSessionProvider);
  HomeMode? sessionMode;
  if (currentSessionId != null) {
    try {
      final row = await read(appDatabaseProvider).sessionMirrorDao.findById(currentSessionId);
      sessionMode = homeModeOfSession(
        agentMode: row?.agentMode,
        desktopDeviceId: row?.desktopDeviceId,
      );
    } catch (_) {
      /* 镜像读不到 / 已删: 按未知处理, 不动会话 */
      sessionMode = null;
    }
  }
  final leftBehind = modeSwitchLeavesSession(sessionMode: sessionMode, next: next);
  if (leftBehind != null) read(currentSessionProvider.notifier).set(null);
  read(homeModeProvider.notifier).set(next);
  return leftBehind;
}
