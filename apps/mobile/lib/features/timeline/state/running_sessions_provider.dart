/// running_sessions_provider.dart — 哪些会话此刻在跑 (2026-10-12).
///
/// 用户原话: 「会话等列表里, 如果运行中的话, 有个运行的动画显示更好」。
///
/// **为什么不直接给列表 watch `timelineStateProvider(sessionId).agentRunning`**:
/// 那会给列表里**每一行**都实例化一个时间线控制器, 每个都要从 drift hydrate 一遍
/// (拉整段历史 + 建 entry 树) —— 25 行的列表直接废掉。
/// 这里只维护一个 id 集合, 由时间线控制器在 `_agentRunning` 翻转时顺手增删
/// (见 `timeline_state.dart` 的 `_setRunning`), 读端是常数代价。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/desktop_run_status.dart';

/// 「在跑 / 等你」合并口径 (2026-10-15): 手机看过的会话 (时间线控制器报的) + 电脑上报的每条会话运行态.
/// 侧栏电脑行、我的电脑卡片、电脑页「正在跑」都读这个, 不各算各的.
final liveSessionsProvider = Provider<({Set<String> running, Set<String> waiting})>((ref) {
  final local = ref.watch(runningSessionsProvider);
  final remote = ref.watch(desktopRunStatusProvider);
  final running = {...local};
  final waiting = <String>{};
  remote.forEach((id, s) {
    if (isWaitingRunStatus(s)) {
      waiting.add(id);
    } else if (s == 'running') {
      running.add(id);
    }
  });
  return (running: running, waiting: waiting);
});

final runningSessionsProvider =
    NotifierProvider<RunningSessionsController, Set<String>>(
      RunningSessionsController.new,
    );

class RunningSessionsController extends Notifier<Set<String>> {
  @override
  Set<String> build() => const <String>{};

  /// 幂等 —— 同一个值重复来不产生新 Set, 免得白刷一遍列表.
  void set(String sessionId, bool running) {
    if (state.contains(sessionId) == running) return;
    final next = {...state};
    if (running) {
      next.add(sessionId);
    } else {
      next.remove(sessionId);
    }
    state = next;
  }
}
