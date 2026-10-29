/// stream_buffer_provider.dart — Stage 1: in-memory streaming state.
///
/// Mobile 收到 agent_text_delta / agent_thinking_delta / tool_running 等 streaming
/// kind 时, 按 sessionId+turnId 累积到 in-memory buffer. 收到对应 _done / tool_done
/// 时 commit / 清理.
///
/// 不入 drift — drift 只存最终成型消息 (text_complete 后 SessionContext.append 一条).
///
/// 渲染合并: timeline 同时 watch drift + 本 provider, in-flight turn 用 buffer 渲染.
library;

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../attachments/local_attachment_store.dart';

/// 单条流中 assistant message 累积 state.
class StreamingTurn {
  StreamingTurn({
    required this.turnId,
    required this.pinnedAfterSeq,
    this.pendingFirstToken = false,
  });
  final String turnId;

  /// 钉位 — 创建本 turn 那一刻 timeline 已知的最大 drift seq.
  /// 渲染时本 streaming turn 会**夹在 drift seq <= pinnedAfterSeq 之后, > pinnedAfterSeq
  /// 之前**, 而不是永远落在 timeline 末尾。
  ///
  /// 为啥要钉:
  ///   原来 streaming 永远渲在末尾, 等内容 commit 成 drift 时 drift 又落到它的 seq 位置
  ///   (可能在中间), 视觉就"跳"了一下。钉位之后, in-flight 跟 drift commit 同位置, 不跳。
  ///
  /// 0 = 还没钉过 / 没有 drift item, 渲染兜底放末尾。
  final int pinnedAfterSeq;

  /// 流式 agent text — token delta 累积
  final StringBuffer textBuffer = StringBuffer();
  bool textDone = false;

  /// 流式 thinking — reasoning delta 累积
  final StringBuffer thinkingBuffer = StringBuffer();
  bool thinkingDone = false;

  /// 当前正在跑的工具 (live status), key=tool_call_id
  final Map<String, RunningTool> runningTools = {};

  /// "user 已发出, 等 agent 第一个事件" 占位.
  ///   true 时 isEmpty=false → renderer 会显示 typing dots 等待态.
  ///   第一个 delta 或 tool 事件到达后由 _markActive() 关闭.
  bool pendingFirstToken;

  /// 是否完全无内容 — 包含 pending 状态判定
  bool get isEmpty =>
      !pendingFirstToken &&
      textBuffer.isEmpty &&
      thinkingBuffer.isEmpty &&
      runningTools.isEmpty;
}

class RunningTool {
  RunningTool({
    required this.toolCallId,
    required this.toolName,
    required this.args,
    this.done = false,
    this.ok = true,
  });
  final String toolCallId;
  final String toolName;
  final Map<String, dynamic> args;
  bool done;
  bool ok;

  /// 实时增量输出 — shell/edit_file 的 *_stream chunk 累在这, UI 显尾部 N 行
  final StringBuffer progressBuffer = StringBuffer();
}

/// Per-session streaming state. Key = sessionId.
class _StreamState {
  /// turnId → StreamingTurn
  final Map<String, StreamingTurn> turns = {};

  /// 用户刚点发送, drift 还没收到 Desktop echo 回来的 user_message 这段时间的占位文本.
  /// timeline 直接渲一条 user bubble, 给用户秒级"我发出去了"反馈, 不再因为 RTT 等空白.
  /// 真 user_message session.event 到达时 (ws_client_provider 那边) 调 clearPendingUserText 删掉.
  String? pendingUserText;
  int? pendingUserTs;

  /// 占位气泡上的附件 (图片缩略图 / 文件 chip) —— 发送那一刻已经落盘的本地引用.
  List<LocalAttachmentRef> pendingUserAttachments = const [];

  /// pendingUser 钉位 — 跟 StreamingTurn.pinnedAfterSeq 同语义.
  int pendingUserAfterSeq = 0;

  /// 最近见到的 drift seq — ws_client_provider 收 session.event 时持续 update.
  /// 给新创建的 StreamingTurn / pendingUser 钉位用。
  int latestDriftSeq = 0;
}

class StreamBufferController extends StateNotifier<Map<String, _StreamState>> {
  StreamBufferController() : super(<String, _StreamState>{});

  _StreamState _ensure(String sessionId) {
    final s = state[sessionId];
    if (s != null) return s;
    final fresh = _StreamState();
    state = {...state, sessionId: fresh};
    return fresh;
  }

  StreamingTurn _ensureTurn(String sessionId, String turnId) {
    final ss = _ensure(sessionId);
    return ss.turns.putIfAbsent(
      turnId,
      () => StreamingTurn(turnId: turnId, pinnedAfterSeq: ss.latestDriftSeq),
    );
  }

  /// ws_client_provider 每收到一条 session.event (带 seq) 都调一次 — 把"当前 drift
  /// 已知最大 seq"更新进 buffer, 让后续新建的 StreamingTurn 能拿到准确的钉位点。
  ///
  /// 不触发 _notify (这是纯内部跟踪, UI 不需要重画)。
  void updateLatestDriftSeq(String sessionId, int seq) {
    final ss = _ensure(sessionId);
    if (seq > ss.latestDriftSeq) {
      ss.latestDriftSeq = seq;
    }
  }

  void _notify() {
    _coalesce?.cancel();
    _coalesce = null;
    /* StateNotifier 浅比较 map ref, 强制 new map 触发 watch */
    state = {...state};
  }

  /* ─── 高频增量的合流 ────────────────────────────────────────────
   *
   * 2026-09-18 用户: 「apk 的 60fps 120hz 等要丝滑 丝滑 性能必须优异」。
   *
   * 每个 token delta 原来都直接 _notify() 一次。模型一秒吐几十个 token, 就是
   * 一秒几十次整列重建 —— 而正在流的那条消息每次重建都要**把整段文本重新解析
   * 一遍 markdown**, 文本越长越慢: 总代价是 O(n²)。屏幕升到 120Hz 之后每帧预算
   * 从 16.7ms 降到 8.3ms, 这件事只会更明显。
   *
   * 合流到 [_kCoalesce] 一次: 人读不了比这更快的更新, 而重建次数降一个量级。
   * 状态跳变 (done / commit / 工具起停) 仍然立刻 _notify —— 那些是"变了个样",
   * 晚 50ms 会看出来; 文字长出几个字晚 50ms 看不出来。
   * ──────────────────────────────────────────────────────────── */
  static const _kCoalesce = Duration(milliseconds: 50);
  Timer? _coalesce;

  void _notifySoon() {
    if (_coalesce != null) return; // 已经排了一次, 这一批增量搭它的车
    _coalesce = Timer(_kCoalesce, () {
      _coalesce = null;
      if (!mounted) return;
      state = {...state};
    });
  }

  @override
  void dispose() {
    _coalesce?.cancel();
    super.dispose();
  }

  /// composer 点发送时 immediately 设, timeline 立刻渲一条 user 消息占位 + 思考中 dots.
  /// drift 收到 Desktop echo 回来的 user_message 时 (ws_client_provider 那边) 由
  /// clearPendingUserText 清掉, 让 drift 的版本替换 (drift 有真 seq, 永久持久化).
  void setPendingUserText(
    String sessionId,
    String text, {
    List<LocalAttachmentRef>? attachments,
  }) {
    final ss = _ensure(sessionId);
    /* composer 先带附件设一次, 路由层紧接着只带文本再设一次 —— 后者不能把附件抹掉 */
    if (attachments != null) {
      ss.pendingUserAttachments = attachments;
    } else if (ss.pendingUserText != text) {
      ss.pendingUserAttachments = const [];
    }
    ss.pendingUserText = text;
    ss.pendingUserTs = DateTime.now().millisecondsSinceEpoch;
    /* 钉在当前 latestDriftSeq 后, 这样 drift 的真 user_message 到达 (seq=latest+1)
     *   时位置不变, 不再"跳"。 */
    ss.pendingUserAfterSeq = ss.latestDriftSeq;
    _notify();
  }

  void clearPendingUserText(String sessionId) {
    final ss = state[sessionId];
    if (ss == null) return;
    if (ss.pendingUserText != null || ss.pendingUserTs != null) {
      ss.pendingUserText = null;
      ss.pendingUserTs = null;
      ss.pendingUserAttachments = const [];
      _notify();
    }
  }

  /// user 发送完消息后 immediately 创建一个 placeholder turn —
  /// 让 timeline 显示 "思考中…" typing dots, 不再有 user 发送后到第一个 agent
  /// 事件之间的死板空白. 第一个 delta 到达后, _markActive 把 pending 关掉.
  void ensureWaitingTurn(String sessionId) {
    final ss = _ensure(sessionId);
    /* 用固定 id, 防止重复创建; 第一个 real turn 事件如果带不同 turnId 会另起一条,
     *   这条 __waiting__ 会在第一个 delta 时被 _markActive 找出来删掉. */
    if (!ss.turns.containsKey('__waiting__')) {
      ss.turns['__waiting__'] = StreamingTurn(
        turnId: '__waiting__',
        pendingFirstToken: true,
        pinnedAfterSeq: ss.latestDriftSeq,
      );
    }
    _notify();
  }

  /// 任意 agent 实际事件 (delta / tool) 到达时, 清掉 __waiting__ placeholder
  /// (它已经被真 turn 接管).
  void _consumeWaitingPlaceholder(String sessionId) {
    final ss = state[sessionId];
    if (ss == null) return;
    if (ss.turns.remove('__waiting__') != null) {
      _notify();
    }
  }

  void onTextDelta(String sessionId, String turnId, String content) {
    _consumeWaitingPlaceholder(sessionId);
    final t = _ensureTurn(sessionId, turnId);
    t.pendingFirstToken = false;
    t.textBuffer.write(content);
    _notifySoon();
  }

  void onTextDone(String sessionId, String turnId) {
    final ss = state[sessionId];
    final t = ss?.turns[turnId];
    if (t == null) return;
    /* 立刻清 — 之前等 onTextFinalCommit (drift 到达) 才清, 但 drift 的 seq 可能
     *   小于当前还在跑的 tool seq, 这时 streaming buffer 在 timeline 末尾渲 text,
     *   drift commit 后 text 跳到中间位置 — 视觉"跳上去"。
     *   实测 drift 在 text_done 之后 5ms 内就到 (forwarder 顺序保证), 立刻清比闪烁
     *   1 帧好得多, 比跳位置好太多。 */
    t.textBuffer.clear();
    t.thinkingBuffer.clear();
    t.textDone = false;
    t.thinkingDone = false;
    _maybeRemoveTurn(sessionId, turnId);
  }

  /// drift 已写入对应 turn 的 final assistant text → 清掉 buffer.
  /// 防止 streaming bubble 跟 drift 同一消息双渲染.
  ///
  /// 重要 — 同时清掉 thinking buffer: text complete 意味着整个 turn 在 mobile 视角已结束,
  /// 而 reasoning_complete 在 server 端如果带空 text 不会触发 drift agent_thinking 事件,
  /// 导致 thinkingBuffer 永远卡在那里 → turn 永远不 remove → "扎堆" 视觉.
  /// 这里强制双清, 是单向截断 — drift 那边 agent_thinking 真到来时 (kind=agent_thinking 路径)
  /// 已经从 drift 渲染了, 不依赖 streaming buffer.
  void onTextFinalCommit(String sessionId, String turnId) {
    final ss = state[sessionId];
    final t = ss?.turns[turnId];
    if (t == null) return;
    t.textBuffer.clear();
    t.textDone = false;
    t.thinkingBuffer.clear();
    t.thinkingDone = false;
    _maybeRemoveTurn(sessionId, turnId);
  }

  void onThinkingDelta(String sessionId, String turnId, String content) {
    _consumeWaitingPlaceholder(sessionId);
    final t = _ensureTurn(sessionId, turnId);
    t.pendingFirstToken = false;
    t.thinkingBuffer.write(content);
    _notifySoon();
  }

  void onThinkingDone(String sessionId, String turnId) {
    final ss = state[sessionId];
    final t = ss?.turns[turnId];
    if (t == null) return;
    t.thinkingDone = true;
    _notify();
  }

  void onThinkingFinalCommit(String sessionId, String turnId) {
    final ss = state[sessionId];
    final t = ss?.turns[turnId];
    if (t == null) return;
    t.thinkingBuffer.clear();
    t.thinkingDone = false;
    _maybeRemoveTurn(sessionId, turnId);
  }

  void onToolRunning(
    String sessionId,
    String turnId,
    String toolCallId,
    String toolName,
    Map<String, dynamic> args,
  ) {
    _consumeWaitingPlaceholder(sessionId);
    final t = _ensureTurn(sessionId, turnId);
    t.pendingFirstToken = false;
    t.runningTools[toolCallId] = RunningTool(
      toolCallId: toolCallId,
      toolName: toolName,
      args: args,
    );
    _notify();
  }

  void onToolDone(String sessionId, String toolCallId, bool ok) {
    final ss = state[sessionId];
    if (ss == null) return;
    for (final t in ss.turns.values) {
      final tool = t.runningTools[toolCallId];
      if (tool != null) {
        tool.done = true;
        tool.ok = ok;
        _notify();
        return;
      }
    }
  }

  /// drift 已写入 tool result, 移除 live 状态.
  void onToolFinalCommit(String sessionId, String toolCallId) {
    final ss = state[sessionId];
    if (ss == null) return;
    for (final entry in ss.turns.entries) {
      if (entry.value.runningTools.remove(toolCallId) != null) {
        _maybeRemoveTurn(sessionId, entry.key);
        return;
      }
    }
  }

  void _maybeRemoveTurn(String sessionId, String turnId) {
    final ss = state[sessionId];
    final t = ss?.turns[turnId];
    if (t == null) return;
    if (t.isEmpty) {
      ss!.turns.remove(turnId);
    }
    _notify();
  }

  /// 整轮 agent 收尾 — 由 desktop forwarder 的 turn_complete 触发.
  ///
  /// 行为: 强清掉这一 turn 的所有 in-flight 状态 (text/thinking/runningTools/pending),
  /// 顺带清掉 __waiting__ placeholder. drift 那侧 final agent_text/tool_result 仍会到达,
  /// 它们走的是各自 onTextFinalCommit/onToolFinalCommit 路径, 跟这个清理互不冲突.
  ///
  /// 这是 "phone 上思考中... 永远不消失" bug 的根治: 之前 ZeroToken turn (用户发完 agent
  /// 直接没动作或返个 tool 调用) 没有 agent_text_done / 没有 tool_done, pendingFirstToken
  /// 永远 true, dots 永远转.
  void onTurnDone(String sessionId, String turnId) {
    final ss = state[sessionId];
    if (ss == null) return;
    /* 显式删: 当前 turn + __waiting__ (如果 placeholder 还在). 不在乎是否清 0,
     *   就算 turn 还有 partial state, drift final 路径会把真消息持久化, in-memory 没用了. */
    ss.turns.remove(turnId);
    ss.turns.remove('__waiting__');
    _notify();
  }

  /// 整 session 一刀切清 — session_interrupted / 退页 / 显式 abort 用.
  void clearAllTurns(String sessionId) {
    final ss = state[sessionId];
    if (ss == null) return;
    if (ss.turns.isEmpty) return;
    ss.turns.clear();
    _notify();
  }

  /// tool 实时输出 chunk — desktop forwarder 的 shell_output_stream / *_file_stream 触发.
  /// 累在对应 RunningTool 的 progressBuffer 里, UI 显尾部 N 行做"工具在跑"反馈.
  void onToolProgress(String sessionId, String toolCallId, String chunk) {
    final ss = state[sessionId];
    if (ss == null) return;
    for (final t in ss.turns.values) {
      final tool = t.runningTools[toolCallId];
      if (tool != null) {
        tool.progressBuffer.write(chunk);
        _notifySoon();
        return;
      }
    }
  }

  /// 退出 session timeline 时清掉对应 session 的所有 buffer.
  void clearSession(String sessionId) {
    if (!state.containsKey(sessionId)) return;
    final m = {...state};
    m.remove(sessionId);
    state = m;
  }
}

final streamBufferProvider =
    StateNotifierProvider<StreamBufferController, Map<String, _StreamState>>(
      (ref) => StreamBufferController(),
    );

/// Watch 指定 session 的当前 streaming turns. 空 → 没 in-flight.
final sessionStreamingTurnsProvider =
    Provider.family<List<StreamingTurn>, String>((ref, sessionId) {
      final map = ref.watch(streamBufferProvider);
      final ss = map[sessionId];
      if (ss == null) return const [];
      return ss.turns.values.where((t) => !t.isEmpty).toList();
    });

/// Watch 指定 session 的 pending user 占位文本 — drift echo 未到那段 RTT 显的临时 user msg.
/// afterSeq 是钉位点: pendingUser 显示在 drift seq <= afterSeq 之后, > afterSeq 之前。
final pendingUserTextProvider =
    Provider.family<
      ({String text, int ts, int afterSeq, List<LocalAttachmentRef> attachments})?,
      String
    >((ref, sessionId) {
      final map = ref.watch(streamBufferProvider);
      final ss = map[sessionId];
      if (ss == null) return null;
      final t = ss.pendingUserText;
      final ts = ss.pendingUserTs;
      if (t == null || ts == null) return null;
      return (
        text: t,
        ts: ts,
        afterSeq: ss.pendingUserAfterSeq,
        attachments: ss.pendingUserAttachments,
      );
    });

/// Watch 某个工具调用 (按 tool_call_id) 的 in-flight 数据 — 命令文本 + 实时输出.
///
/// 给 drift orphan tool_call 用: orphan tool_call (没 result, status=running) 时
/// ToolBlock watch 它的实时进度, 渲 LiveOutputTail.
///
/// 之前 streaming_widgets 在 timeline 末尾再渲一遍 runningTools, 导致 agent 的
/// "最后总结文字" 上方有 drift tool, 下方又出现 streaming tool 重复 — 体验混乱。
final runningToolProgressProvider =
    Provider.family<({String? command, String progress}), String>((
      ref,
      toolCallId,
    ) {
      final map = ref.watch(streamBufferProvider);
      for (final ss in map.values) {
        for (final turn in ss.turns.values) {
          final tool = turn.runningTools[toolCallId];
          if (tool != null) {
            String? cmd;
            for (final k in const ['command', 'cmd', 'code', 'script']) {
              final v = tool.args[k];
              if (v is String && v.isNotEmpty) {
                cmd = v;
                break;
              }
            }
            return (command: cmd, progress: tool.progressBuffer.toString());
          }
        }
      }
      return (command: null, progress: '');
    });

// ────────────────────────────────────────────────────────────────
// PendingApproval — 工具审批拦截状态
// ────────────────────────────────────────────────────────────────

/// 单次工具审批拦截 — agent 卡在 PermissionManager 等用户回应.
/// requestId 是 server 端 PermissionManager 给的唯一 id, approve/reject 时回传.
class PendingApproval {
  const PendingApproval({
    required this.requestId,
    required this.toolName,
    required this.args,
    required this.reason,
    required this.allowRemember,
  });
  final String requestId;
  final String toolName;
  final Map<String, dynamic> args;
  final String reason;
  final bool allowRemember;
}

class PendingApprovalsController
    extends StateNotifier<Map<String, List<PendingApproval>>> {
  PendingApprovalsController() : super(const {});

  void add(String sessionId, PendingApproval a) {
    final cur = state[sessionId] ?? const <PendingApproval>[];
    /* 同 requestId 去重 (forwarder 偶尔会重推) */
    final next = [...cur.where((x) => x.requestId != a.requestId), a];
    state = {...state, sessionId: next};
  }

  void remove(String sessionId, String requestId) {
    final cur = state[sessionId];
    if (cur == null) return;
    final next = cur.where((x) => x.requestId != requestId).toList();
    if (next.isEmpty) {
      final m = {...state}..remove(sessionId);
      state = m;
    } else {
      state = {...state, sessionId: next};
    }
  }

  void clearSession(String sessionId) {
    if (!state.containsKey(sessionId)) return;
    final m = {...state}..remove(sessionId);
    state = m;
  }
}

final pendingApprovalsProvider =
    StateNotifierProvider<
      PendingApprovalsController,
      Map<String, List<PendingApproval>>
    >((ref) => PendingApprovalsController());

/// Watch 指定 session 的待审批列表 (按到达顺序).
final sessionPendingApprovalsProvider =
    Provider.family<List<PendingApproval>, String>((ref, sessionId) {
      return ref.watch(pendingApprovalsProvider)[sessionId] ?? const [];
    });

// ────────────────────────────────────────────────────────────────
// PendingAskUser — agent 追问用户状态
// ────────────────────────────────────────────────────────────────

class PendingAskUserOption {
  const PendingAskUserOption({required this.label, this.description});

  final String label;
  final String? description;
}

class PendingAskUserQuestion {
  const PendingAskUserQuestion({
    required this.question,
    required this.options,
    required this.multiSelect,
  });

  final String question;
  final List<PendingAskUserOption> options;
  final bool multiSelect;
}

class PendingAskUser {
  const PendingAskUser({
    required this.requestId,
    required this.questions,
    this.turnId,
    this.answers,
  });

  final String requestId;
  final List<PendingAskUserQuestion> questions;
  final String? turnId;
  /// 电脑终端里先答了: 有值 = 已答 (卡片翻成「已在电脑上回答」, 不能再点)
  final Map<String, String>? answers;

  bool get answered => answers != null;
}

class PendingAskUsersController
    extends StateNotifier<Map<String, List<PendingAskUser>>> {
  PendingAskUsersController() : super(const {});

  void add(String sessionId, PendingAskUser ask) {
    final cur = state[sessionId] ?? const <PendingAskUser>[];
    final next = [...cur.where((x) => x.requestId != ask.requestId), ask];
    state = {...state, sessionId: next};
  }

  void remove(String sessionId, String requestId) {
    final cur = state[sessionId];
    if (cur == null) return;
    final next = cur.where((x) => x.requestId != requestId).toList();
    if (next.isEmpty) {
      final m = {...state}..remove(sessionId);
      state = m;
    } else {
      state = {...state, sessionId: next};
    }
  }

  /// 电脑终端里先答了 — 卡片不撤, 翻成「已答」并带上答案 (2026-10-18).
  /// 只撤卡的话用户看不出是谁答的、答了什么; 真正的清理由 tool_done 收尾.
  void answered(String sessionId, String requestId, Map<String, String> answers) {
    final cur = state[sessionId];
    if (cur == null) return;
    var changed = false;
    final next = cur.map((x) {
      if (x.requestId != requestId || x.answered) return x;
      changed = true;
      return PendingAskUser(
        requestId: x.requestId,
        questions: x.questions,
        turnId: x.turnId,
        answers: answers,
      );
    }).toList();
    if (changed) state = {...state, sessionId: next};
  }

  void clearSession(String sessionId) {
    if (!state.containsKey(sessionId)) return;
    final m = {...state}..remove(sessionId);
    state = m;
  }
}

final pendingAskUsersProvider =
    StateNotifierProvider<
      PendingAskUsersController,
      Map<String, List<PendingAskUser>>
    >((ref) => PendingAskUsersController());

final sessionPendingAskUsersProvider =
    Provider.family<List<PendingAskUser>, String>((ref, sessionId) {
      return ref.watch(pendingAskUsersProvider)[sessionId] ?? const [];
    });
