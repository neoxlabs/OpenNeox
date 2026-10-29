/// agent_notifier.dart — Agent 事件 → 用户通知的统一路由 + 远程推送能力保留层.
///
/// 现状: app 活着 (前台/后台) 时 WS 事件仍在流入, 后台时用本地通知提醒;
/// app 被杀后收不到 — 那需要 APNs/FCM 服务端推送 (云端暂未建设).
///
/// **能力保留设计**: [RemotePushRegistrar] 是远程推送的席位 —
/// 未来接 APNs/FCM 时实现它 (拿 device token → POST 云端注册),
/// 换掉 [remotePushRegistrarProvider] 的 Noop 实现即可, 触发点/文案/降噪
/// 逻辑全部复用本文件, 调用侧零改动.
library;

import 'package:flutter/foundation.dart' show debugPrint, kDebugMode;
import 'package:flutter/scheduler.dart' show SchedulerBinding, AppLifecycleState;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'local_notifications.dart';
import 'notify_prefs.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 远程推送注册器 — 能力保留接口.
///
/// 未来实现 (FCM/APNs):
///   1. 拿平台 device token
///   2. POST NeoxCloud /api/v1/push/register (待云端建设)
///   3. 云端在 approval_needed / session_done 时对离线设备发推送
abstract class RemotePushRegistrar {
  /// 尝试注册远程推送. 返回 false = 当前渠道不可用 (Noop / 无权限 / 未登录).
  Future<bool> register();

  Future<void> unregister();

  bool get isSupported;
}

/// 默认空实现 — 云端推送服务未建设, 本地通知兜底.
class NoopRemotePushRegistrar implements RemotePushRegistrar {
  const NoopRemotePushRegistrar();

  @override
  Future<bool> register() async => false;

  @override
  Future<void> unregister() async {}

  @override
  bool get isSupported => false;
}

final remotePushRegistrarProvider = Provider<RemotePushRegistrar>(
  (ref) => const NoopRemotePushRegistrar(),
);

/// Agent 事件通知路由 — ws_client_provider 在收到关键事件时调.
///
/// 原则:
///   - 只在 app 非前台时弹 (前台用户正盯着 timeline, 弹通知是骚扰)
///   - 同 session 同类事件 30s 降噪 (agent 连续多次审批不轰炸)
class AgentNotifier {
  AgentNotifier();

  final Map<String, int> _lastShownAt = {};

  bool get _inBackground {
    final state = SchedulerBinding.instance.lifecycleState;
    return state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.inactive;
  }

  bool _debounced(String key) {
    final now = DateTime.now().millisecondsSinceEpoch;
    final last = _lastShownAt[key] ?? 0;
    if (now - last < 30000) return true;
    _lastShownAt[key] = now;
    /* 防 map 无界膨胀 */
    if (_lastShownAt.length > 64) {
      final cutoff = now - 300000;
      _lastShownAt.removeWhere((_, t) => t < cutoff);
    }
    return false;
  }

  void _show(String key, String title, String? body, String sessionId, NotifyKind kind) {
    if (!_inBackground) return;
    /* 设置 → 通知 关掉了这一类 / 在安静时段 */
    if (!NotifyPrefs.allows(kind)) return;
    if (_debounced(key)) return;
    if (kDebugMode) debugPrint('[agent-notifier] $title ($sessionId)');
    LocalNotifications.showAgentEvent(
      title: title,
      body: body,
      sessionId: sessionId,
      /* 消息页按这个分: 等你确认的那条带「去确认」, 做完的打勾 */
      inboxKind: kind == NotifyKind.waiting ? 'wait' : 'agent',
    );
  }

  /// agent 卡在工具审批等用户 — 最高价值通知 (不批 agent 就停着).
  void approvalNeeded(String sessionId, String toolName) {
    _show(
      'approval-$sessionId',
      tr('Neox 在等你审批'),
      tr('Agent 想执行 $toolName，点开确认'),
      sessionId,
      NotifyKind.waiting,
    );
  }

  /// agent 追问用户.
  void askUserNeeded(String sessionId, String question) {
    _show(
      'ask-$sessionId',
      tr('Neox 有问题问你'),
      question.isEmpty ? tr('点开回答后任务继续') : question,
      sessionId,
      NotifyKind.waiting,
    );
  }

  /// 整轮跑完.
  void turnDone(String sessionId, {String? sessionTitle}) {
    _show(
      'done-$sessionId',
      tr('任务跑完了'),
      sessionTitle == null || sessionTitle.isEmpty
          ? tr('点开查看结果')
          : tr('「$sessionTitle」已完成'),
      sessionId,
      NotifyKind.done,
    );
  }

  /// 会话出错 / 被中断.
  void sessionError(String sessionId, String reason) {
    _show(
      'err-$sessionId',
      tr('任务中断了'),
      reason.isEmpty ? tr('点开查看原因') : reason,
      sessionId,
      NotifyKind.done,
    );
  }
}

final agentNotifierProvider = Provider<AgentNotifier>(
  (ref) => AgentNotifier(),
);
