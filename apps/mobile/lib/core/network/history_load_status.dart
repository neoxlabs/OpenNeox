/// history_load_status.dart — 「这条会话的历史到底加载成功了没有」.
///
/// **为什么需要它** (2026-09-18 用户: 「历史会话 无法传输加载」)
///
/// 之前拉历史这条链上, **失败和"本来就是空的"是同一个值 `0`**:
///   · `fetchSessionHistory` 出错 → 返回 written:0
///   · 多页回填的循环读到 0 → `break; // 没更多了`
///   · 向上翻页读到 0 → `_noMoreOlder = true` (从此这一页再也不翻了)
///   · 界面连接着 → 显示「还没有消息」
/// 于是一次超时 / 一次解析失败, 用户看到的跟"这个会话真的没消息"**一模一样**,
/// 而且之后不会再试。没有任何一处告诉他出了问题。
///
/// 这个状态就是把那两件事分开: 失败要说失败, 空要说空。
///
/// 另外一类问题也在这里报: 会话属于**另一台电脑**。手机的会话列表是云端索引,
/// 里面有没连着的电脑的会话; 打开它时当前连的电脑根本不认识这个 id, 于是
/// subscribe 回 latest_seq:0、history 回空 —— 一样长得像"空会话"。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

enum HistoryLoadPhase {
  /// 还没开始 / 不需要 (手机本地会话).
  idle,

  /// 正在拉.
  loading,

  /// 拉完了 (可能确实是空的, 但那是真的空).
  ok,

  /// 拉失败了 —— 超时 / 连接断 / 对端报错. 界面必须说出来并给重试.
  failed,

  /// 这条会话在另一台电脑上, 当前连的这台不认识它.
  otherDesktop,
}

class HistoryLoadStatus {
  const HistoryLoadStatus({required this.phase, this.desktopName});

  final HistoryLoadPhase phase;

  /// [HistoryLoadPhase.otherDesktop] 时: 它属于哪台电脑 (拿不到名字就是 null).
  final String? desktopName;

  static const idle = HistoryLoadStatus(phase: HistoryLoadPhase.idle);

  bool get isFailure =>
      phase == HistoryLoadPhase.failed ||
      phase == HistoryLoadPhase.otherDesktop;
}

class HistoryLoadStatusController extends StateNotifier<HistoryLoadStatus> {
  HistoryLoadStatusController() : super(HistoryLoadStatus.idle);

  void set(HistoryLoadPhase phase, {String? desktopName}) {
    /* mounted 检查: 会话可能在拉历史的途中被关掉 (family autoDispose),
     * 那时候写 state 会抛 StateError —— 已经被这个坑咬过一次
     * (见 presence_provider 里的同类注释)。 */
    if (!mounted) return;
    state = HistoryLoadStatus(phase: phase, desktopName: desktopName);
  }
}

/// 按 sessionId 分桶 —— 不做成全局 Map: 一个会话的状态变化不该让别的会话重渲染
/// (后台流式让前台整树每帧重渲染那次的教训)。
final historyLoadStatusProvider = StateNotifierProvider.family
    .autoDispose<HistoryLoadStatusController, HistoryLoadStatus, String>(
      (ref, sessionId) {
        /* 拉历史是后台任务, 页面切走之后回执还会回来 —— 状态得活过这一瞬,
         * 否则用户切回来看到的是 idle (又变成"看不出发生过什么")。 */
        ref.keepAlive();
        return HistoryLoadStatusController();
      },
    );
