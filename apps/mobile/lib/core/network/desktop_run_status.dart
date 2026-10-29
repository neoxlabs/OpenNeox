/// desktop_run_status.dart — 电脑上每条会话此刻的运行态 (2026-10-15).
///
/// 手机自己只知道它订阅过 (打开过) 的会话在不在跑 (见 runningSessionsProvider)。电脑页的「正在跑」、
/// 侧栏电脑行的「N 个在跑 / 等你」要对电脑上每条会话都准, 所以电脑端在 session.list 里带 `run_status`,
/// 翻转时广播 `session.run_status`; 这里收着。老版本电脑不带这个字段 —— 表就是空的, 界面照旧只认手机看过的。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

/// sessionId → 非 idle 的运行态 (running / paused / awaiting_approval / awaiting_user). idle 不存.
final desktopRunStatusProvider =
    NotifierProvider<DesktopRunStatusController, Map<String, String>>(DesktopRunStatusController.new);

class DesktopRunStatusController extends Notifier<Map<String, String>> {
  @override
  Map<String, String> build() => const {};

  void set(String sessionId, String? status) {
    final s = (status ?? '').trim();
    final idle = s.isEmpty || s == 'idle';
    if (idle ? !state.containsKey(sessionId) : state[sessionId] == s) return;
    final next = {...state};
    idle ? next.remove(sessionId) : next[sessionId] = s;
    state = next;
  }

  /// session.list / session.snapshot 整页: 带了 run_status 的才算数 (老电脑不带, 不动现有记录)
  void ingest(List<dynamic> rawSessions) {
    final next = {...state};
    var touched = false;
    for (final r in rawSessions) {
      if (r is! Map) continue;
      final id = r['id'];
      final st = r['run_status'];
      if (id is! String || st is! String) continue;
      touched = true;
      if (st == 'idle' || st.isEmpty) {
        next.remove(id);
      } else {
        next[id] = st;
      }
    }
    if (touched) state = next;
  }
}

bool isWaitingRunStatus(String? s) => s == 'awaiting_approval' || s == 'awaiting_user';
