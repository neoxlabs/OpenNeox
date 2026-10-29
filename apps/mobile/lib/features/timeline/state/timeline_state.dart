/// timeline_state.dart — Phone timeline **Projector** (同构桌面时间轴投影).
///
/// 双通道 (与桌面一致, 不是第二套同步业务):
///   A. EntryLog  — `_applyDrift` / streaming content → TimelineEntry[]
///   B. ExecutionState — `applyExecution` / `applyRunStateChange` → busy/idle
///
/// Composer busy 只看 ExecutionState; idle 时收敛 entry 上的 streaming/pending.
/// 禁止手机私自推断 turn 结束.
///
/// 设计原则 (从 Desktop timelineStore / useStreamHandler 抄):
///   - ONE in-memory mutable list per session.
///   - entry 按 id (toolCallId / msgId) 索引, 可原地更新.
///   - tool_call 跟 tool_result 是同一条 entry, 状态从 pending→done 演化 (不是 2 行).
///   - streaming agent_text 也是同一条 entry, 内容追加.
///   - 渲染读 entries 列表 (= map 层), 不拥有真相.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/attachments/local_attachment_store.dart';
import '../../../core/local_agent/answer_versions.dart'
    show answerVersionsFromPayload;
import '../../../core/network/projector_transport.dart';
import '../../../core/network/stream_buffer_provider.dart';
import 'running_sessions_provider.dart';
import '../../../core/session_routing/send_failure_note.dart'
    show kClientErrorKind;
import '../../../core/storage/database.dart';
import 'stream_freeze.dart';

const _kTimelineDebugLogs = false;

/// 单条 entry — 时间轴上一格.
///
/// 同 id 的事件 (e.g., tool_call seq N + tool_result seq M) 进来时, 找到原 entry
/// 原地更新 pending/output, sequence 保留, 不新建 entry.
class TimelineEntry {
  TimelineEntry({
    required this.id,
    required this.kind,
    required this.sequence,
    required this.timestamp,
    this.pending = false,
    this.text,
    this.toolName,
    this.args,
    this.output,
    this.toolCallId,
    this.toolSuccess = true,
    this.liveOutput,
    this.streaming = false,
    this.thinking,
    this.turnId,
  });

  /// 所属 turn — 用于"first agent_text 提到 turn 内所有 tool 之上" 的重排.
  /// OpenAI streaming 协议下, drift agent_text 到达晚于 tool, 但用户感知是
  /// "agent 先说话再做事", 所以渲染前做一次 turn 级重排.
  String? turnId;

  /// 稳定 id — agent_text/agent_thinking 按 "${kind}-${turnId}"; tool 按 toolCallId;
  ///   user_message 按 "user-${seq}". 用于 update-in-place 查找.
  final String id;

  /// 渲染分派用. 'user_message' | 'agent_text' | 'agent_thinking' | 'tool' | ...
  final String kind;

  /// 在 timeline 中的位置, 单调递增. 第一次插入时拿到 drift seq 或 next-counter, 之后不变.
  int sequence;
  int timestamp;

  /// tool entry: pending=true 表 running; false 表 done.
  bool pending;

  /// agent_text / user_message 内容.
  String? text;

  /// agent_thinking 内容.
  String? thinking;

  /// tool entry 字段
  String? toolName;
  Map<String, dynamic>? args;
  String? output;
  String? toolCallId;
  bool toolSuccess;

  /// 这个工具做出来的、手机能下载的产物 (桌面 artifactRegistry 登记后随
  /// tool_result 一起下发)。每项 {id, name, size_bytes, mime}。
  /// 手机本地会话额外带 local_path —— 文件就在本机沙箱, 不用走网络。
  List<Map<String, dynamic>>? artifacts;

  /// user_message: 用户发的图片 / 文件 (本机留底, 见 LocalAttachmentStore)。
  List<LocalAttachmentRef>? attachments;

  /// shell/edit 长命令的 live progress (running 时累积).
  String? liveOutput;

  /// 仅 streaming agent_text 用: true 表示 text 还在流, 渲染需要 cursor effect.
  bool streaming;

  /// 这一轮保留的旧回答 (chat:C1-06) — 来自上一条 user_message payload 的
  /// `answer_versions`. 非空时回复底下给「旧版 N」入口, 可切回。
  List<String>? answerVersions;

  /// 旧回答挂在哪条 user_message 上 (切换版本要写回它的 payload).
  int? answerAnchorSeq;

  /// agent_thinking 用: 思考耗时 (ms). streaming 结束时由状态机写入,
  /// UI 显示 "thinking · 4s". 历史回放 (hydrate) 拿不到 — null 不显示.
  int? thinkingDurationMs;

  /// 这条 entry 对应的**服务端落库序号** (最小的那个) —— 实时流式还没落库时为 null.
  ///
  /// 只用来给迟到的 user_message 找位置 (2026-09-17): 服务端一轮里 user_message 最先写,
  /// seq 比本轮所有 agent 事件都小; 手机却按"到达顺序"排, user_message 走落库→watch
  /// 的慢路, 常比 agent 的流式 delta 晚到, 于是被追加到 agent 输出**下面**, 再也不挪回来。
  int? driftSeq;

  /// 手机本地创建时刻 (手机时钟) —— 跟「刚发送」占位气泡的时刻同一个钟, 可比。
  /// entry.timestamp 混着桌面时钟 (drift ev.ts) 和手机时钟 (流式 now), 不能拿来排序。
  int createdAtMs = 0;
}

/// 计划卡单步 — 对齐协议 v1.1 plan_update payload { step, status }.
class PlanStepState {
  const PlanStepState({required this.step, required this.status});
  final String step;

  /// pending | in_progress | completed (未知值当 pending 渲)
  final String status;
}

/// 计划卡状态 — plan_update 全量覆盖; session.subscribe ui_state.plan 恢复.
/// 渲染为 timeline 顶部 pinned 卡 (移动端不占消息流, 跟桌面 inline 卡不同的取舍).
class PlanCardState {
  const PlanCardState({
    required this.steps,
    this.explanation,
    required this.updatedAt,
  });
  final List<PlanStepState> steps;
  final String? explanation;
  final int updatedAt;

  int get completedCount =>
      steps.where((s) => s.status == 'completed').length;
}

/// LLM 流重试 pill — stream_retry 置位, stream_recovered / 任意 delta / turn 结束清.
class RetryPillState {
  const RetryPillState({
    required this.attempt,
    required this.maxRetries,
    required this.kindLabel,
  });
  final int attempt;
  final int maxRetries;

  /// 'rate_limit' | 'timeout' | 'network' | 'other'
  final String kindLabel;
}

class TimelineSnapshot {
  const TimelineSnapshot(
    this.entries, {
    this.agentRunning = false,
    this.runStatus = 'idle',
    this.initiatedBy,
    this.pendingTools = const [],
    this.plan,
    this.retry,
    this.streamFrozen = false,
  });
  final List<TimelineEntry> entries;

  /// 当前计划卡 — null = 该 session 没跑过 update_plan.
  final PlanCardState? plan;

  /// 非 null 时 UI 显 "网络波动重试中" pill.
  final RetryPillState? retry;

  /// 用户已点停止, 但这一轮还没收口 —— 正文/思考的残留增量不再上屏,
  /// 打字机立即停帧 (chat:C9-08)。渲染层读它决定 `StreamingTypewriter.frozen`。
  final bool streamFrozen;

  /// agent 是否在跑 — composer 用它切 send/stop 按钮, timeline 用它显"思考中..."
  /// 占位行 (entry 列表为空 / 末尾不是 streaming agent_text 时).
  /// 任何 streaming event 到达 → true; agent_turn_done / session_interrupted → false.
  final bool agentRunning;

  /// M2 接力 — 来自 server runState. composer 用它决定显示 resume 按钮还是 pause/stop.
  /// idle / running / paused / awaiting_approval / awaiting_user
  final String runStatus;
  final String? initiatedBy;
  final List<PendingToolRef> pendingTools;
}

/// 接力时 timeline 顶部显示的 pending tool — agent 跑到一半 desktop 关了, mobile 拉
/// runState 知道还有 X 个 tool 正在跑, 让用户能继续看 / 干预.
class PendingToolRef {
  const PendingToolRef({
    required this.toolCallId,
    required this.toolName,
    this.args,
    this.startedAt,
  });
  final String toolCallId;
  final String toolName;
  final Map<String, dynamic>? args;
  final int? startedAt;
}

class TimelineStateController extends StateNotifier<TimelineSnapshot> {
  TimelineStateController(this._ref, this._sessionId)
    : _ephemeral = false,
      super(TimelineSnapshot(<TimelineEntry>[])) {
    /* 注: 必须用 growable list, 不能 const []. _upsert 直接 .insert/.removeAt
     *   on state.entries — const 空 list 会抛 Unsupported operation. */
    _hydrate();
  }

  /// 内存态投影 — **不碰 drift**: 不回放本地历史, 不订阅 watch.
  /// 用于子 agent 会话悬浮窗: 事件由调用方 [applyRemoteEvents] 灌进来,
  /// 控制器随窗口 autoDispose 释放。子会话事件不进主会话 drift 表 (性能红线)。
  TimelineStateController.ephemeral(this._ref, this._sessionId)
    : _ephemeral = true,
      super(TimelineSnapshot(<TimelineEntry>[]));

  final Ref _ref;
  final String _sessionId;
  final bool _ephemeral;
  StreamSubscription<List<SessionEvent>>? _driftSub;

  /// 当前这一轮的旧回答列表 + 锚点 (user_message seq). 按事件顺序回放时,
  /// user_message 先更新它, 后面到达的 agent_text 再挂到 entry 上 (chat:C1-06).
  List<String> _turnAnswerVersions = const [];
  int? _turnAnswerAnchor;

  /// 每个 entry 在内存里的索引, 按 id 锚定. 用于 update-in-place.
  final Map<String, int> _byId = {};

  /// In-memory monotonic sequence counter — 跟 Desktop `timelineStore.tsx`
  /// `getNextMemorySequence` 同款策略.
  ///
  /// 设计抉择 (2026-05-19): 之前用 drift `ev.seq` 当 sequence 是错的, 因为 drift seq
  /// 是 Desktop SessionContext 的"落库顺序" — OpenAI streaming 协议下 text_complete
  /// fire 早于 tool_call_start 的 appendMessage (text drift seq < tool drift seq 不一定,
  /// 反之亦然), 跟用户感知的"agent 说话 → 调工具 → 总结"顺序不匹配。
  ///
  /// 现在策略: **完全不用 drift seq 排序**, 用 "事件到达 mobile 的顺序" counter++ 分配。
  /// 第一次插入 entry 时 sequence=++counter; update 已存在 entry 时**保留原 sequence**。
  ///
  /// **关键**: 同一 turn 可能有多段正文 (intro → tool → 答案)。每段用
  /// `stream-text-{turnId}` 流式累积, **`agent_text_done` 必须 retire 该 id**
  /// (改成冻结 id, 腾出 stream key)。否则第二段 delta 仍 upsert 到第一段,
  /// sequence 卡在 tool 之前 → UI 答案跑到工具上面 (2026-07-21 真机实锤).
  /// thinking 同理 (`stream-think-{turnId}` + `agent_thinking_done`).
  int _seqCounter = 0;
  int _nextSeq() => ++_seqCounter;

  /// 已经 apply 过的 drift seq 集合 — 仅用作 drift watch 的 dedup,
  /// **不用来排序**。第一次 apply 给 entry 分配 ++_seqCounter, 后续重放跳过。
  final Set<int> _appliedDriftSeqs = <int>{};

  /// 已经收到完成 (流式 tool_done 或落库 tool_result) 的工具 callId。
  /// 「开始」类事件 (落库 tool_call / 流式 tool_running) 晚于「完成」到达时 —— 落库那路重连补拉、
  /// 按 seq 插回、两路先后不定 —— 原来无条件把这行改回 pending, 而完成事件不会再来一遍,
  /// 于是一直挂着「正在改文件 69s」直到整轮结束 (2026-10-22 真机; 电脑日志里每个 tool_done 都发到了)。
  final Set<String> _doneToolCallIds = <String>{};

  /// 已应用的最大 drift seq — watch 流里检出"比现有更旧"的历史回填页用.
  int _maxAppliedDriftSeq = 0;

  /// 历史回填 prepend 模式 (见 _applyOlderDriftBatch) — _upsert 据此改插前端.
  bool _prepending = false;

  /// 断线补缺模式 (见 _applyMiddleDriftBatch) — _upsert 据此按 driftSeq 插回原位.
  bool _insertingMiddle = false;
  int _prependInsertPos = 0;
  int _prependFloor = 0;

  Future<void> _hydrate() async {
    final db = _ref.read(appDatabaseProvider);
    /* 一次性回放历史 — 先做 turn 级重排, 模拟 streaming 时的事件到达顺序。
     * 原因: drift 上 agent_text 的 seq 晚于同 turn 的 tool_call (OpenAI 协议
     * text_complete 最后 fire), 直接按 drift seq 回放会让 intro 跑到 tool 之后。
     * 实时路径靠 streaming entry 先占位 sequence 自然对; hydrate 没 streaming,
     * 必须显式重排。 */
    /* 附件留底索引先进内存 —— 回放 user_message 时按文本 + 时间窗同步匹配 */
    await LocalAttachmentStore.instance.load(_sessionId);
    final initial = await db.sessionEventsDao.getBySessionId(_sessionId);
    /* phone-local 会话不重排 — 本地 Agent SDK 落库顺序就是用户感知顺序
     * (tool_call → tool_result → 最终 agent_text). 桌面式重排会把最终回答
     * 错误提到工具行上面 (真机实锤). 重排只为桌面 OpenAI 协议的 drift 时序. */
    final reordered = _sessionId.startsWith('phone-')
        ? initial
        : _reorderForHydrate(initial);
    _turnAnswerVersions = const [];
    _turnAnswerAnchor = null;
    for (final ev in reordered) {
      _applyDrift(ev);
    }
    /* 历史全部属于"之前" —— 之后实时建的无 driftSeq entry 才算新一轮 */
    _turnBoundarySeq = _seqCounter;
    _flush();
    /* 后续 drift 变化 — 增量 apply 还没见过的 seq.
     * 实时增量不需要重排: 上游已按真实事件顺序推, agent_text 进来时 streaming entry
     * 还在或刚 upgrade in-place, 顺序自然对。 */
    _driftSub = db.sessionEventsDao.watchBySessionId(_sessionId).listen((all) {
      var changed = false;
      /* 比已应用最大 seq 更旧的未见事件 = 历史回填页 (向上翻页 / 多页 catch-up
       * 的第 2+ 页)。它们必须 prepend 到列表前端 — 走普通 _applyDrift 会被
       * append 到末尾, 旧消息出现在 timeline 底部。 */
      final older = <SessionEvent>[];
      /* 夹在中间那一档: 比屏上最旧新、比已应用最旧旧 —— 断线补缺 / 丢包补拉回采的。
       * 它们既不能 prepend (不是向上翻页), 也不能 append (那是把旧消息长在列表底部),
       * 必须按 seq 插回原位 (2026-10-12 用户: 「最后一条不是这个, 顺序不对」)。 */
      final middle = <SessionEvent>[];
      /* 已在屏上的最小 driftSeq —— 比它还旧才是"向上翻页"; 夹在中间的是**断线补缺**
       * (重连 catch-up / 丢包补拉), 必须按 seq 插回原位, 不能 prepend 到最顶上
       * (2026-09-17: 补回来的 user_message 被甩到整个会话最前面)。 */
      final minShownDriftSeq = state.entries
          .map((e) => e.driftSeq)
          .whereType<int>()
          .fold<int?>(null, (m, s) => m == null || s < m ? s : m);
      for (final ev in all) {
        if (_appliedDriftSeqs.contains(ev.seq)) continue;
        if (_maxAppliedDriftSeq > 0 && ev.seq < _maxAppliedDriftSeq) {
          if (minShownDriftSeq == null || ev.seq < minShownDriftSeq) {
            older.add(ev);
          } else {
            middle.add(ev);
          }
          continue;
        }
        _applyDrift(ev);
        changed = true;
      }
      if (older.isNotEmpty) {
        _applyOlderDriftBatch(older);
        changed = true;
      }
      if (middle.isNotEmpty) {
        _applyMiddleDriftBatch(middle);
        changed = true;
      }
      if (changed) _flush();
    });
  }

  /// 内存态灌入 (ephemeral 专用) — 把远端拉回来的事件按顺序 apply, 不落 drift.
  ///
  /// 幂等: `_appliedDriftSeqs` 已见过的 seq 直接跳过, 所以子 agent 在跑时可以
  /// 反复整段重拉 (轮询) 而不会重复渲染。返回本次真正新增的条数。
  int applyRemoteEvents(List<SessionEvent> events) {
    if (events.isEmpty) return 0;
    final ordered = _sessionId.startsWith('phone-')
        ? events
        : _reorderForHydrate(events);
    var applied = 0;
    for (final ev in ordered) {
      if (_appliedDriftSeqs.contains(ev.seq)) continue;
      _applyDrift(ev);
      applied++;
    }
    if (applied > 0) _flush();
    return applied;
  }

  /// 子 agent 悬浮窗: 子会话还在跑时列表尾部要显示"思考中"占位.
  /// ephemeral 控制器没有 execution 通道, 由调用方直接置位。
  void setEphemeralRunning(bool running) {
    if (!_ephemeral || _agentRunning == running) return;
    _setRunning(running);
    _flush();
  }

  /// 历史回填页 — 保持批内时序 prepend 到 timeline 前端.
  /// 桌面会话沿用 hydrate 同款 turn 级重排, 回放与实时渲染一致.
  void _applyOlderDriftBatch(List<SessionEvent> events) {
    final ordered = _sessionId.startsWith('phone-')
        ? events
        : _reorderForHydrate(events);
    _prepending = true;
    _prependInsertPos = 0;
    /* 每事件最多产 2 个 entry, ×4+16 冗余保证本批 sequence 全部低于上一批 */
    _prependFloor -= ordered.length * 4 + 16;
    try {
      for (final ev in ordered) {
        _applyDrift(ev);
      }
    } finally {
      _prepending = false;
    }
  }

  /// 断线补缺 — 比屏上最旧新、比已应用最旧旧的那些, **按 driftSeq 插回原位**.
  ///
  /// 2026-09-17 那条注释写的就是这件事 (「夹在中间的是断线补缺, 必须按 seq 插回原位」),
  /// 但只写了注释、没写代码: 这类事件原来直接走 `_applyDrift` → append 到列表末尾,
  /// 于是重连补回来的旧消息长在时间线底部 —— 用户看到的就是「最后一条不是最新的那个,
  /// 顺序不对」(2026-10-12 真机实拍)。三条路现在齐了:
  ///   比屏上最旧还旧 → [_applyOlderDriftBatch] prepend (向上翻页)
  ///   夹在中间       → 这里, 按 seq 插回中间
  ///   比已应用最新还新 → 普通 `_applyDrift` append
  void _applyMiddleDriftBatch(List<SessionEvent> events) {
    /* 批内按 seq 升序处理: 每条的落点由 driftSeq 算, 顺序错了会互相挤位 */
    final ordered = [...events]..sort((a, b) => a.seq.compareTo(b.seq));
    _insertingMiddle = true;
    try {
      for (final ev in ordered) {
        _applyDrift(ev);
      }
    } finally {
      _insertingMiddle = false;
    }
  }

  /// 补缺事件该插在下标几 —— 末尾往前扫, 停在最后一个 driftSeq 比它小的 entry 之后.
  /// 列表本身是按事件序排的, 所以这个位置就是它在时间线上的原位。
  int _insertIndexForDriftSeq(int driftSeq) {
    final es = state.entries;
    for (var i = es.length - 1; i >= 0; i--) {
      final ds = es[i].driftSeq;
      if (ds != null && ds < driftSeq) return i + 1;
    }
    return 0;
  }

  /// 从 [at] 起重建 id→下标 (插在中间之后, 后面的都挪了一位).
  void _reindexFrom(int at) {
    for (var i = at; i < state.entries.length; i++) {
      _byId[state.entries[i].id] = i;
    }
  }

  /// Hydrate 专用回放重排.
  ///
  /// v1.3 起桌面 forwarder 在 payload 里带 `stream_order` (每轮真实流序戳,
  /// 正文/思考按段首 token 时刻取号) — 全员有戳的 turn 直接按它排, 回放顺序
  /// == 用户实时看到的顺序 (user_message 恒排轮首)。
  ///
  /// 无戳老数据: **不再**用"首正文提前到首工具前"启发式 — 那会把「工具后的答案」
  /// 错误抬到工具上面 (真机实锤)。无戳时保持 drift 到达/seq 序; 要精确序请用
  /// 带 stream_order 的桌面重拉 (⋯ → 重新同步会话).
  List<SessionEvent> _reorderForHydrate(List<SessionEvent> events) {
    if (events.length < 2) return events;
    final turnOf = <int, String>{}; // ev.seq → turnId
    final orderOf = <int, int?>{}; // ev.seq → stream_order
    final turnFirstIdx = <String, int>{}; // turnId → 首现 index
    final turnFullyStamped = <String, bool>{};
    for (var i = 0; i < events.length; i++) {
      final ev = events[i];
      final tid = _peekTurnId(ev) ?? 'default';
      turnOf[ev.seq] = tid;
      turnFirstIdx.putIfAbsent(tid, () => i);
      final order = _peekStreamOrder(ev);
      orderOf[ev.seq] = order;
      /* user_message 由 server 写入无戳, 视作轮首 (order -1), 不影响全员判定 */
      final stamped = order != null || ev.kind == 'user_message';
      turnFullyStamped[tid] = (turnFullyStamped[tid] ?? true) && stamped;
    }
    final anyStamped = turnFullyStamped.values.any((v) => v);
    if (!anyStamped) return events;

    final idxOf = <int, int>{
      for (var i = 0; i < events.length; i++) events[i].seq: i,
    };
    final out = List<SessionEvent>.of(events);
    out.sort((a, b) {
      final ta = turnOf[a.seq]!, tb = turnOf[b.seq]!;
      if (ta != tb) {
        return turnFirstIdx[ta]!.compareTo(turnFirstIdx[tb]!);
      }
      if (turnFullyStamped[ta] == true) {
        final oa = a.kind == 'user_message' ? -1 : orderOf[a.seq]!;
        final ob = b.kind == 'user_message' ? -1 : orderOf[b.seq]!;
        if (oa != ob) return oa.compareTo(ob);
      }
      /* Dart sort 不稳定 — 原 index 兜底保持稳定序 */
      return idxOf[a.seq]!.compareTo(idxOf[b.seq]!);
    });
    return out;
  }

  /* payload 解析的单槽缓存 —— 2026-09-22.
   *
   * [_peekStreamOrder] / [_peekTurnId] 各自 jsonDecode(ev.payload), 而它们经常对
   * **同一条事件**被连着调用 (排序时先取 stream_order 再取 turn_id), 再加上
   * `_safeDecode` 就是同一份 payload 解三遍 —— drift 事件可以每秒来好几条。
   *
   * 命中判据用 `identical`: 同一个 SessionEvent 实例的 payload 字段永远是同一个
   * String 对象 (它是 final field), 所以这里不需要值比较, 也不会跨事件误命中。 */
  String? _peekPayloadSrc;
  Map<String, dynamic>? _peekPayloadMap;

  /// 把 ev.payload 解析成 Map; 解析不了返回 null (各行各自兜底).
  Map<String, dynamic>? _peekPayload(SessionEvent ev) {
    if (identical(ev.payload, _peekPayloadSrc)) return _peekPayloadMap;
    Map<String, dynamic>? out;
    try {
      final p = jsonDecode(ev.payload);
      if (p is Map) out = p.cast<String, dynamic>();
    } catch (_) {
      /* 不是 JSON — 调用方按 null 处理 */
    }
    _peekPayloadSrc = ev.payload;
    _peekPayloadMap = out;
    return out;
  }

  int? _peekStreamOrder(SessionEvent ev) {
    final o = _peekPayload(ev)?['stream_order'];
    if (o is int) return o;
    if (o is num) return o.toInt();
    return null;
  }

  String? _peekTurnId(SessionEvent ev) {
    final t = _peekPayload(ev)?['turn_id'];
    return (t is String && t.isNotEmpty) ? t : null;
  }

  @override
  void dispose() {
    _firstEventGuard?.cancel();
    _transportReattachTimer?.cancel();
    _flushTimer?.cancel();
    _driftSub?.cancel();
    super.dispose();
  }

  /// drift event → entry (新建或原地更新).
  ///
  /// **不用 ev.seq 排序** — 给所有新 entry 分配 _nextSeq() 内存计数器.
  /// drift 的 ev.seq 只用作 entry id 锚点 (防止 _hydrate 跟 stream 重复 apply 同一条) +
  /// dedup (_appliedDriftSeqs).
  void _applyDrift(SessionEvent ev) {
    final prev = _applyingDriftSeq;
    _applyingDriftSeq = ev.seq;
    try {
      _applyDriftInner(ev);
    } finally {
      _applyingDriftSeq = prev;
    }
  }

  void _applyDriftInner(SessionEvent ev) {
    _appliedDriftSeqs.add(ev.seq);
    if (ev.seq > _maxAppliedDriftSeq) _maxAppliedDriftSeq = ev.seq;
    _clearFirstEventGuard();
    _noteProjectorActivity();
    if (_kTimelineDebugLogs && kDebugMode) {
      debugPrint('[TIMELINE_APPLY_DRIFT] seq=${ev.seq} kind=${ev.kind}');
    }
    final payload = _safeDecode(ev.payload);
    final turnId = _turnIdOf(payload);
    switch (ev.kind) {
      case 'user_message':
        {
          /* 2026-06-24 真因 (从 adb pull DB 看真数据):
           *   一条 user 发送在 DB 里存了 2 条 session_events:
           *     seq=1 turn_id="chat-XXX"  message_id="msg-srv-XXX"  ← server echo (LAN/cloud)
           *     seq=4 turn_id=""          (无 message_id)             ← 本地 phone 自发 echo
           *   ts 相差 ~300ms-2s. turnId 路径 dedup 完全没用 — 一个是 "chat-XXX",
           *   一个是空字符串.
           *   真 dedup: 同 session 内, 内容相同 + 5s 时间窗口 = 同一条 user message.
           *   message_id 优先 (server 给的全局唯一), 没有时退到 (text+5s 窗口).
           *
           * 2026-07-20 联调补: 桌面 chat() 会往 user text 追加 <current-time> 等
           *   隐藏上下文标签 — history 版带标签, 手机 echo 版不带, 文本 hash 不同
           *   → dedup 失效双渲染, 且标签裸露. 先剥标签再 dedup/渲染, 双修. */
          final fullText = _stripHiddenContextTags(
            _stringFrom(payload, ev.payload),
          );
          /* 手机发的图, 电脑回显时在正文末尾挂一段 `![](neox-image://<sha>.<ext>)` (桌面瘦身落盘的引用)。
           * 这张图本机发的时候就留了底, 按引用去电脑上拉既慢又可能卡死 (2026-10-11 真机: 气泡里一个圈一直转);
           * 而且带着这段字, 按文本找留底、跟发送占位去重全都对不上 —— 同一句话出现两条。
           * 所以: 先把引用剥掉去配留底; 配上了就用本机那份图, 正文只留人打的字。 */
          final bare = fullText.replaceAll(RegExp(r'\s*!\[[^\]]*\]\(neox-image://[^)]+\)'), '').trim();
          final localAtts = bare == fullText
              ? null
              : LocalAttachmentStore.instance.match(_sessionId, bare, ev.ts);
          final text = localAtts != null && localAtts.isNotEmpty ? bare : fullText;
          String? messageId;
          if (payload is Map) {
            final m = payload['message_id'];
            if (m is String && m.isNotEmpty) messageId = m;
          }
          final String dedupKey;
          if (messageId != null) {
            dedupKey = 'user-mid-$messageId';
          } else {
            /* 滑动 5s 窗口 dedup (2026-07-21 修): 旧版用 ts~/5000 整除分桶,
             * 两条 echo 落在桶边界两侧 (如 4.9s/5.1s) 就不合并 — 测试 flaky
             * 暴露的真实缺陷. 现在直接扫已有 user entry: 同文本且时差 <5s
             * → 复用同一 entry id. entries 是 in-memory 且 user 消息占比小,
             * 线性扫无感. */
            String? existingId;
            for (final e in state.entries) {
              if (e.kind == 'user_message' &&
                  e.text == text &&
                  (ev.ts - e.timestamp).abs() < 5000) {
                existingId = e.id;
                break;
              }
            }
            dedupKey = existingId ?? 'user-${ev.seq}';
          }
          /* 用户发的图片 / 文件: 回显里没有, 从发送那一刻的本机留底按 (文本, 时间窗) 找回 */
          final attachments = localAtts ??
              LocalAttachmentStore.instance.match(
                _sessionId,
                text,
                ev.ts,
              );
          _upsert(
            id: dedupKey,
            kind: 'user_message',
            timestamp: ev.ts,
            mutate: (e) {
              e.text = text;
              e.turnId = turnId;
              if (attachments != null && attachments.isNotEmpty) {
                e.attachments = attachments;
              }
            },
          );
          /* 这一轮的旧回答入口 (chat:C1-06) — 后面到达的 agent_text 挂上它 */
          _turnAnswerAnchor = ev.seq;
          _turnAnswerVersions = answerVersionsFromPayload(ev.payload);
          return;
        }
      case 'agent_text':
        {
          /* Drift agent_text 到达时: 优先 upgrade 仍在流的 `stream-text-{turn}`
           * (本段还没 done), 保留该段 sequence。
           * 若本段已在 agent_text_done 里 retire, stream key 已空 — 走下方新建
           * 或同 turn 归一化去重, 不会再把答案挂到工具前的旧 entry 上. */
          final text = _stringFrom(payload, ev.payload);
          final tid = turnId ?? 'default';

          /* 空正文的 assistant 信封不建条目 (2026-07-30 真机): 桌面会为某些轮次
           * 落一条 content 为空的 agent_text。建个空条目等于时间轴上多一道空行,
           * 而本轮真正的正文是流式那段 —— 这里只把它就地收口, 别覆盖也别新建. */
          if (text.isEmpty) {
            final idx = _byId['stream-text-$tid'];
            if (idx != null) {
              state.entries[idx].streaming = false;
              state.entries[idx].driftSeq = _minSeq(state.entries[idx].driftSeq, ev.seq);
            }
            return;
          }

          /* 双写合并 (2026-07-20 真机实锤): 桌面偶发对同一轮回复落两条
           * agent_text drift, 文本只差空白 (token 累积版 vs text_complete 版),
           * 入口 content-hash dedup 不命中 → 渲染两遍。这里按 turn 维度做
           * 归一化比对: 同 turn 已有 agent_text 且去空白后相同 → 取更长版
           * 原地更新, 不新建。hydrate 回放同路径, 老会话的历史重复一并治愈. */
          /* 图片地址不参与比对 (2026-10-28): 电脑把落盘版里 `![图](charts/a.png)` 换成了
           * `neox-image://` 引用, 流式那版还是原路径 —— 只差这一处也是同一条, 留落盘版 (能显示图)。 */
          final normalized = _normalizeForDedup(text);
          final hasImageRef = text.contains('neox-image://');
          for (final e in state.entries) {
            if (e.kind != 'agent_text') continue;
            if ((e.turnId ?? 'default') != tid) continue;
            final existing = _normalizeForDedup(e.text ?? '');
            if (existing == normalized && existing.isNotEmpty) {
              if (hasImageRef || text.length > (e.text ?? '').length) e.text = text;
              e.streaming = false;
              e.driftSeq = _minSeq(e.driftSeq, ev.seq);
              e.answerVersions = _turnAnswerVersions.isEmpty
                  ? null
                  : List<String>.from(_turnAnswerVersions);
              e.answerAnchorSeq = _turnAnswerAnchor;
              return;
            }
          }

          final streamId = 'stream-text-$tid';
          final streamIdx = _byId[streamId];
          if (streamIdx != null) {
            /* 改 id 到 text-${ev.seq} 防 dedup 失效, 保留 sequence/turnId */
            final old = state.entries[streamIdx];
            final upgraded = TimelineEntry(
              id: 'text-${ev.seq}',
              kind: 'agent_text',
              sequence: old.sequence,
              timestamp: ev.ts,
              text: text,
              streaming: false,
              turnId: old.turnId ?? turnId,
            )
              ..driftSeq = _minSeq(old.driftSeq, ev.seq)
              ..createdAtMs = old.createdAtMs
              ..answerVersions = _turnAnswerVersions.isEmpty
                  ? null
                  : List<String>.from(_turnAnswerVersions)
              ..answerAnchorSeq = _turnAnswerAnchor;
            state.entries[streamIdx] = upgraded;
            _byId.remove(streamId);
            _byId['text-${ev.seq}'] = streamIdx;
            return;
          }
          _upsert(
            id: 'text-${ev.seq}',
            kind: 'agent_text',
            timestamp: ev.ts,
            mutate: (e) {
              e.text = text;
              e.streaming = false;
              e.turnId = turnId;
              e.answerVersions = _turnAnswerVersions.isEmpty
                  ? null
                  : List<String>.from(_turnAnswerVersions);
              e.answerAnchorSeq = _turnAnswerAnchor;
            },
          );
          return;
        }
      case 'agent_thinking':
        {
          String? thinkingText;
          if (payload is Map) {
            final t = payload['thinking'];
            if (t is String && t.isNotEmpty) thinkingText = t;
            final c = payload['content'];
            if ((thinkingText == null || thinkingText.isEmpty) &&
                c is String &&
                c.isNotEmpty) {
              thinkingText = c;
            }
          }
          final tid = turnId ?? 'default';

          /* 同 agent_text: stream retire 后 drift 晚到会再建一条 → 重复 thinking.
           * 合并时只保留已有 duration, 禁止用 now-ev.ts 发明秒数
           * (那是「距今多久」, 会显示成 7m50s 这种假时长). */
          final normalized =
              (thinkingText ?? '').replaceAll(_reWhitespace, '');
          if (normalized.isNotEmpty) {
            for (final e in state.entries) {
              if (e.kind != 'agent_thinking') continue;
              if ((e.turnId ?? 'default') != tid) continue;
              final existing =
                  (e.thinking ?? e.text ?? '').replaceAll(_reWhitespace, '');
              if (existing == normalized) {
                if ((thinkingText ?? '').length > (e.thinking ?? '').length) {
                  e.thinking = thinkingText;
                }
                e.streaming = false;
                e.driftSeq = _minSeq(e.driftSeq, ev.seq);
                return;
              }
            }
          }

          final streamId = 'stream-think-$tid';
          final streamIdx = _byId[streamId];
          if (streamIdx != null) {
            final old = state.entries[streamIdx];
            final merged = thinkingText ?? old.thinking;
            /* stream 升级成空 thinking → 直接丢掉, 别留 ghost 行 */
            if ((merged ?? '').trim().isEmpty) {
              state.entries.removeAt(streamIdx);
              _byId.remove(streamId);
              for (var i = streamIdx; i < state.entries.length; i++) {
                _byId[state.entries[i].id] = i;
              }
              return;
            }
            /* 时长只认 live 段: done 已写则保留; 仍在流则用首 delta 时刻收口.
             * 绝不使用 now - ev.ts (hydrate 假时长). 保留 old.timestamp. */
            final liveDuration = old.thinkingDurationMs ??
                (old.streaming
                    ? DateTime.now().millisecondsSinceEpoch - old.timestamp
                    : null);
            final upgraded = TimelineEntry(
              id: 'think-${ev.seq}',
              kind: 'agent_thinking',
              sequence: old.sequence,
              timestamp: old.timestamp,
              thinking: merged,
              streaming: false,
              turnId: old.turnId ?? turnId,
            )
              ..thinkingDurationMs = _saneThinkingDuration(liveDuration)
              ..driftSeq = _minSeq(old.driftSeq, ev.seq)
              ..createdAtMs = old.createdAtMs
              ..answerVersions = _turnAnswerVersions.isEmpty
                  ? null
                  : List<String>.from(_turnAnswerVersions)
              ..answerAnchorSeq = _turnAnswerAnchor;
            state.entries[streamIdx] = upgraded;
            _byId.remove(streamId);
            _byId['think-${ev.seq}'] = streamIdx;
            return;
          }
          /* 空 drift thinking 不建 entry — 否则时间轴底会挂 `thinking ▸` */
          if (thinkingText == null || thinkingText.trim().isEmpty) return;
          /* hydrate / 纯 drift: 不发明秒数 — 只认落库时记下的真实用时 (手机本地会话写 duration_ms), 没有就不显示 */
          final recorded = payload is Map ? payload['duration_ms'] : null;
          _upsert(
            id: 'think-${ev.seq}',
            kind: 'agent_thinking',
            timestamp: ev.ts,
            mutate: (e) {
              e.thinking = thinkingText;
              e.streaming = false;
              e.turnId = turnId;
              if (recorded is num) e.thinkingDurationMs ??= _saneThinkingDuration(recorded.toInt());
            },
          );
          return;
        }
      case 'tool_call':
        {
          final callId = _extractToolCallId(payload);
          final name = _toolName(payload) ?? 'tool';
          final args = _extractArgs(payload);
          /* 同一步里「先说一句再调工具」: 桌面把整条 assistant 消息 (正文 + tool_calls) 当成一个 tool_call 发来,
           * 正文以前就丢了 —— Pilot 那种「我去弄, 好了告诉你」从来到不了手机 (2026-10-01)。正文另起一条 agent_text,
           * 排在工具前面; 同一轮已有同文的 (流式那段) 就不重复。 */
          final said = (payload is Map && payload['content'] is String) ? (payload['content'] as String).trim() : '';
          if (said.isNotEmpty) {
            final tid = turnId ?? 'default';
            final norm = said.replaceAll(_reWhitespace, '');
            final dup = state.entries.any((e) =>
                e.kind == 'agent_text' && (e.turnId ?? 'default') == tid && (e.text ?? '').replaceAll(_reWhitespace, '') == norm);
            if (!dup) {
              _upsert(
                id: 'text-call-${ev.seq}',
                kind: 'agent_text',
                timestamp: ev.ts,
                mutate: (e) {
                  e.text = said;
                  e.streaming = false;
                  e.turnId = turnId;
                },
              );
            }
          }
          if (callId == null) {
            _upsert(
              id: 'tool-orphan-${ev.seq}',
              kind: 'tool',
              timestamp: ev.ts,
              mutate: (e) {
                e.toolName = name;
                e.args = args;
                e.pending = true;
                e.turnId = turnId;
              },
            );
            return;
          }
          _upsert(
            id: 'tool-$callId',
            kind: 'tool',
            timestamp: ev.ts,
            mutate: (e) {
              e.toolCallId = callId;
              e.toolName ??= name;
              if (e.args == null || e.args!.isEmpty) {
                if (args != null && args.isNotEmpty) e.args = args;
              }
              /* 已完成的不改回 pending (见 _doneToolCallIds) */
              if (!_doneToolCallIds.contains(callId)) e.pending = true;
              e.turnId ??= turnId;
            },
          );
          return;
        }
      case 'tool_result':
        {
          final callId = (payload is Map)
              ? payload['tool_call_id'] as String?
              : null;
          final out = _stringFrom(payload, ev.payload);
          final ok = !_isResultError(payload, out);
          final resArgs = _extractArgs(payload);
          final name =
              (payload is Map ? payload['tool_name'] as String? : null) ??
              _toolName(payload);
          if (callId == null) {
            _upsert(
              id: 'tool-orphan-result-${ev.seq}',
              kind: 'tool',
              timestamp: ev.ts,
              mutate: (e) {
                e.toolName = name ?? e.toolName ?? 'tool';
                e.output = out;
                e.pending = false;
                e.toolSuccess = ok;
                final arts = _artifactsFrom(payload);
                if (arts != null) e.artifacts = arts;
                e.turnId ??= turnId;
              },
            );
            return;
          }
          _upsert(
            id: 'tool-$callId',
            kind: 'tool',
            timestamp: ev.ts,
            mutate: (e) {
              e.toolCallId = callId;
              e.toolName ??= name;
              e.output = out;
              e.pending = false;
              _doneToolCallIds.add(callId);
              e.toolSuccess = ok;
              if ((e.args == null || e.args!.isEmpty) &&
                  resArgs != null &&
                  resArgs.isNotEmpty) {
                e.args = resArgs;
              }
              final arts = _artifactsFrom(payload);
              if (arts != null) e.artifacts = arts;
              e.turnId ??= turnId;
            },
          );
          return;
        }
      case 'session_meta':
        return;
      case kClientErrorKind:
        {
          /* 客户端发送失败卡 — payload 里的 suggestion / model_unavailable 决定
           * 错误卡长哪几个按钮, 必须整包带到 entry.args。走 default 分支只会
           * 拿到 text, 卡片就退化成一行干瘪的错误。 */
          final map = payload is Map<String, dynamic>
              ? payload
              : (payload is Map
                  ? Map<String, dynamic>.from(payload)
                  : <String, dynamic>{});
          _upsert(
            id: '$kClientErrorKind-${ev.seq}',
            kind: kClientErrorKind,
            timestamp: ev.ts,
            mutate: (e) {
              e.text = (map['text'] as String?) ?? _stringFrom(payload, ev.payload);
              e.args = map;
              e.toolSuccess = false;
            },
          );
          return;
        }
      case 'direct_image':
        {
          final map = payload is Map<String, dynamic>
              ? payload
              : (payload is Map
                  ? Map<String, dynamic>.from(payload)
                  : <String, dynamic>{});
          final tid = (map['turn_id'] as String?) ?? 'seq-${ev.seq}';
          final status = (map['status'] as String?) ?? 'ok';
          _upsert(
            id: 'direct_image-$tid',
            kind: 'direct_image',
            timestamp: ev.ts,
            mutate: (e) {
              e.pending = status == 'pending';
              e.toolSuccess = status != 'error';
              e.text = map['prompt'] as String?;
              e.args = map;
              e.output = map['error'] as String?;
              e.turnId = tid;
            },
          );
          return;
        }
      default:
        _upsert(
          id: '${ev.kind}-${ev.seq}',
          kind: ev.kind,
          timestamp: ev.ts,
          mutate: (e) {
            e.text = _stringFrom(payload, ev.payload);
            e.turnId = turnId;
          },
        );
    }
  }

  /// composer 发消息瞬间调 — 给"我刚发出去, agent 即将开始" 的秒级反馈.
  /// agentRunning=true 触发 typing dots 占位 + 按钮切 stop 态.
  ///
  /// 同时 schedule "首事件超时" timer (10s): 如果 desktop 完全静默没推任何 event
  /// (网络断/SessionContext 异常吃掉), timer 触发自动 idle, 防 UI 永久卡 "思考中..."。
  /// 这跟"无活动 idle timer"不同: timer 在 **第一条 streaming/drift event 到达**
  /// 就被 cancel, 之后长 tool 跑期间不会被误判 — 那段已经被任何已收到的 event 解了锁。
  void markAgentStarting() {
    /* 新的一轮开始 = 上一轮那次停止已经翻篇, 解冻 (否则停止后紧接着再发一条,
     * 新回答会被丢掉不上屏)。 */
    _streamFrozen = false;
    _setRunning(true);
    _noteProjectorActivity();
    _scheduleFirstEventGuard();
    _syncTransportReattachTimer();
    _flush();
  }

  /// composer 暂停/取消时调 — 立即关 running 标志, 不等 desktop 那侧 agent_turn_done.
  /// (pause 不会发 turn_done; cancel 会, 但有 RTT 延迟.)
  void markAgentIdle() {
    _setRunning(false);
    _firstEventGuard?.cancel();
    _firstEventGuard = null;
    _transportReattachTimer?.cancel();
    _transportReattachTimer = null;
    _flush();
  }

  /// 用户点了停止 —— 在桌面确认之前, 别让在途事件把"运行中"顶回来.
  ///
  /// 用户报的"暂停要按两次": `_stop()` 会乐观 markAgentIdle(), 按钮立刻变回发送;
  /// 但 cancel 要一个 RTT 才被桌面处理, 这段时间里在途的 delta / tool_running
  /// 会命中 startKinds 把 _agentRunning 重新点亮 → 按钮又变成停止 → 用户以为没按上,
  /// 再按一次。第二次之所以"管用", 只是因为那时 cancel 恰好已经生效了。
  ///
  /// 这里加一道闩: 请求取消后忽略一切"开始"类事件, 直到真正的收口事件
  /// (agent_turn_done / session_interrupted) 到达, 或超时兜底 (桌面把 cancel 丢了
  /// 也不能永远卡在"已停止"的假象里)。
  void markCancelRequested() {
    _cancelPending = true;
    /* 两层冻结的第一层: 从这一毫秒起, 残留的正文/思考增量不再进时间线。
     * 已经显示出来的字原样保留 (不截断), 只是不再变长。 */
    _streamFrozen = true;
    _cancelLatchTimer?.cancel();
    _cancelLatchTimer = Timer(const Duration(seconds: 12), () {
      if (!mounted) return;
      _cancelPending = false;
    });
    markAgentIdle();
  }

  bool _cancelPending = false;

  /// 停止后立即冻结打字机 (chat:C9-08) —— 见 [markCancelRequested] 与
  /// `stream_freeze.dart` 的两层说明。收口 / 新一轮开始时清掉。
  bool _streamFrozen = false;

  Timer? _cancelLatchTimer;

  void _clearCancelLatch() {
    _cancelPending = false;
    _streamFrozen = false;
    _cancelLatchTimer?.cancel();
    _cancelLatchTimer = null;
  }

  bool _agentRunning = false;

  /// 置位"这轮在不在跑", 并同步到全局的 [runningSessionsProvider] —— 会话列表里那颗
  /// 呼吸点靠它 (2026-10-12 用户: 「会话等列表里, 如果运行中的话, 有个运行的动画显示
  /// 更好」)。
  ///
  /// **所有对 _agentRunning 的写都走这里** —— 否则输入框的停止键和列表里的点会各说各话。
  /// 不给列表直接 watch `timelineStateProvider(sessionId)`: 那会给每一行都实例化一个
  /// 时间线控制器 (每个都要从 drift hydrate 一遍), 25 行的列表直接废掉。
  void _setRunning(bool v) {
    if (_agentRunning == v) return;
    _agentRunning = v;
    _ref.read(runningSessionsProvider.notifier).set(_sessionId, v);
  }

  /// M2 接力 — 当前 server runState 镜像
  String _runStatus = 'idle';
  /// 收到过电脑报的运行状态 —— 之前 _runStatus 的 'idle' 只是默认值, 不能据此收口在跑的工具
  bool _runStateKnown = false;
  String? _initiatedBy;
  List<PendingToolRef> _pendingTools = const [];

  /// v1.1 — 计划卡 / 重试 pill (streaming 置位, subscribe ui_state 恢复)
  PlanCardState? _plan;
  RetryPillState? _retry;

  /// compaction 标记行的 id 计数 (同毫秒多次压缩不撞 id)
  int _compactionCounter = 0;

  /// 正在进行中的那条压缩分隔线 id — 完成事件到达时原地更新它, 不新增一条.
  String? _liveCompactionId;

  /// ExecutionState apply — 对齐桌面 `applyAuthoritativeExecutionState`.
  /// `applyRunStateChange` 为协议入口别名 (run_state_changed / subscribe 快照).
  void applyExecution(Map<String, dynamic> payload) =>
      applyRunStateChange(payload);

  /// 最后一次已应用 run_state 的 updated_at — 新者胜守卫.
  /// subscribe 生效先于快照构建, live run_state_changed 可能先于 subscribe 响应
  /// 到达: 不做单调比较时, 旧快照会把更新的 live 状态倒退回去 (busy/idle 抖动).
  int _runStateUpdatedAt = 0;

  /// session.event kind='run_state_changed' / subscribe.run_state 时调
  void applyRunStateChange(Map<String, dynamic> payload) {
    _noteProjectorActivity();
    final updatedAt = _intOf(payload['updated_at'] ?? payload['updatedAt']);
    if (updatedAt > 0) {
      if (updatedAt < _runStateUpdatedAt) return; // 旧状态, 丢弃
      _runStateUpdatedAt = updatedAt;
    }
    final status = (payload['status'] as String?) ?? 'idle';
    _runStatus = status;
    _runStateKnown = true;
    _initiatedBy = payload['initiated_by'] as String?;
    final rawList = payload['pending_tool_calls'];
    if (rawList is List) {
      _pendingTools = rawList
          .whereType<Map>()
          .map(
            (m) => PendingToolRef(
              toolCallId:
                  (m['toolCallId'] ?? m['tool_call_id'] ?? '') as String,
              toolName: (m['toolName'] ?? m['tool_name'] ?? 'tool') as String,
              args: m['args'] is Map<String, dynamic>
                  ? m['args'] as Map<String, dynamic>
                  : null,
              startedAt: m['startedAt'] is int
                  ? m['startedAt'] as int
                  : (m['started_at'] is int ? m['started_at'] as int : null),
            ),
          )
          .toList(growable: false);
    } else {
      _pendingTools = const [];
    }
    /* paused / awaiting_* 状态不算"agent 在跑", 让 typing 占位消失但按钮另显 resume.
     * idle 也关 running. running 保持 true. */
    _setRunning(status == 'running');
    _syncTransportReattachTimer();
    /* idle = 权威 Execution 收口: 收敛 pending/streaming/空 thinking,
     * 并清掉乐观发送气泡 (echo 丢失时否则 send 永灰). */
    if (status == 'idle') {
      _reconcileTurnClosed();
      _ref.read(streamBufferProvider.notifier).clearPendingUserText(_sessionId);
    }
    _flush();
  }

  /// Projector 收到任意 Entry/Execution 事件 — 重置传输静默计时.
  void _noteProjectorActivity() {
    _lastProjectorActivityMs = DateTime.now().millisecondsSinceEpoch;
    _syncTransportReattachTimer();
  }

  int _lastProjectorActivityMs = 0;
  Timer? _transportReattachTimer;
  /// Execution=running 且事件管道静默超过此时长 → transport re-attach.
  static const _transportQuietTimeout = Duration(seconds: 8);

  void _syncTransportReattachTimer() {
    _transportReattachTimer?.cancel();
    _transportReattachTimer = null;
    /* ephemeral (子 agent 悬浮窗) 不参与传输自愈 — 它没有订阅, 拉不到也不该
     * 去 re-attach 主会话通道。 */
    if (_ephemeral || !_agentRunning) return;
    /* 手机上跑的对话没有「传输」可言 —— 去 re-attach 会问电脑要这条会话的状态, 电脑不认识它,
     * 回一个 idle, 「思考中」就在第 8 秒被撤了 (2026-10-05 实测: 网关重试 30 秒, 界面 8 秒后只剩气泡)。 */
    if (_sessionId.startsWith('phone-')) return;
    _transportReattachTimer = Timer(_transportQuietTimeout, () {
      _transportReattachTimer = null;
      if (!_agentRunning || !mounted) return;
      final silentFor =
          DateTime.now().millisecondsSinceEpoch - _lastProjectorActivityMs;
      if (silentFor < _transportQuietTimeout.inMilliseconds) {
        _syncTransportReattachTimer();
        return;
      }
      if (kDebugMode) {
        debugPrint(
          '[PROJECTOR] transport quiet ${_transportQuietTimeout.inSeconds}s '
          'while running → attachOrCatchUp session=$_sessionId',
        );
      }
      unawaited(projectorAttachOrCatchUp(_sessionId));
    });
  }

  /// turn 收口 / idle 共用: 关 pending+streaming, 丢掉无正文的 thinking 残影.
  void _reconcileTurnClosed() {
    /* 这一轮真的结束了 —— 停止造成的冻结到此解除 (下一条 delta 属于新一轮)。 */
    _streamFrozen = false;
    _turnBoundarySeq = _seqCounter;
    final dropIds = <String>[];
    for (final e in state.entries) {
      /* 后台子 agent 的生命周期**跨越主 turn** —— 主 agent 派完就回一句 OK 收工,
       * 但那个 agent 还在跑几分钟。跟着主 turn 一起收口会让它秒变"已完成":
       * 痕迹的 spinner 停了、状态条消失、长按菜单也不给"停掉这个 agent"
       * (2026-07-29 真机实锤)。它只能由 subagent_done 收口。
       * 前台子 agent 不在此列: 它跟主 turn 同生共死, turn 结束它必然结束。 */
      final isBackgroundAgent =
          e.kind == 'subagent' && e.args?['is_background'] == true;
      if ((e.kind == 'tool' || e.kind == 'subagent') &&
          e.pending &&
          !isBackgroundAgent) {
        e.pending = false;
      }
      if (e.streaming) {
        e.streaming = false;
        if (e.kind == 'agent_thinking') {
          /* 仅 live 流中断收口可记时长; 过滤假时长 */
          e.thinkingDurationMs ??= _saneThinkingDuration(
            DateTime.now().millisecondsSinceEpoch - e.timestamp,
          );
        }
      }
      if (e.kind == 'agent_thinking') {
        final body = (e.thinking ?? e.text ?? '').trim();
        if (body.isEmpty) dropIds.add(e.id);
      }
    }
    if (dropIds.isEmpty) return;
    state.entries.removeWhere((e) => dropIds.contains(e.id));
    _byId.clear();
    for (var i = 0; i < state.entries.length; i++) {
      _byId[state.entries[i].id] = i;
    }
  }

  /// "首事件超时" 守护 — 见 markAgentStarting 注释.
  /// 第一条 event 到达就被 _clearFirstEventGuard cancel.
  Timer? _firstEventGuard;
  static const _firstEventTimeout = Duration(seconds: 10);

  void _scheduleFirstEventGuard() {
    _firstEventGuard?.cancel();
    /* 手机上跑的对话不要这道守护: 请求是本进程 await 着的, 成功有 turn_done, 失败由发送方
     * markAgentIdle + 错误卡收口, 不存在「请求丢了、永远转圈」。而网关在上游渠道之间换着重试
     * 常常超过 10 秒 —— 守护一到就把「思考中」撤了, 只剩发送键在转, 看着像界面卡死
     * (2026-10-05 用户: 「发送完没有任何思考标识, 感觉 UI 被卡住」)。 */
    if (_sessionId.startsWith('phone-')) return;
    _firstEventGuard = Timer(_firstEventTimeout, () {
      if (_agentRunning) {
        if (kDebugMode) {
          debugPrint('[TIMELINE_GUARD] first-event timeout, forcing idle');
        }
        _setRunning(false);
        _flush();
      }
      _firstEventGuard = null;
    });
  }

  void _clearFirstEventGuard() {
    if (_firstEventGuard == null) return;
    _firstEventGuard!.cancel();
    _firstEventGuard = null;
  }

  /// 处理 streaming 事件 (没 drift seq) — 内存里加 streaming entry / 更新 progress.
  /// 这些事件由 ws_client_provider 收到 streaming kind 时调用.
  /// 流式事件入口 —— **任何单条事件都不允许掀翻整条流**.
  ///
  /// 手机与桌面是独立发版的两端, 版本必然会错开: 桌面加了字段、改了类型、推了手机
  /// 还不认识的 kind, 都是常态。这里的 payload 解析大量用 `as String?` 这类直接
  /// 转换, 一旦桌面把 `content` 从 string 换成结构体 (或某个字段偶发为 int),
  /// 就会抛 TypeError —— 而这个方法是在 WS 消息回调里同步调用的, 抛出去会打断
  /// 订阅循环, 表现为"聊到一半整个会话不动了", 用户只能杀进程。
  ///
  /// 所以外层兜一层: 坏事件被吞掉并打日志, 已渲染的内容原样保留, 后续事件继续处理。
  /// 宁可少渲染一张卡, 不可整条流挂掉。
  void applyStreaming(String kind, Map<String, dynamic> payload) {
    try {
      _applyStreamingUnsafe(kind, payload);
    } catch (e, st) {
      debugPrint('[timeline] 丢弃畸形事件 kind=$kind: $e');
      assert(() {
        debugPrint('$st');
        return true;
      }());
    }
  }

  /// 宽松取字符串 —— 桌面偶发把数字/布尔塞进文本字段时不抛, 按字面量渲染.
  /// 只有 null 才返回 null (调用方据此判"没这个字段")。
  static String? _str(Object? v) {
    if (v == null) return null;
    if (v is String) return v;
    return '$v';
  }

  void _applyStreamingUnsafe(String kind, Map<String, dynamic> payload) {
    final turnId = _str(payload['turn_id']) ?? 'default';
    /* 已点停止: 正文/思考的残留增量不再上屏 —— 桌面 / 网关那边要一个 RTT 才真正
     * 掐断, 在此之前画面的字还在长, 正是 chat:C9-08 要消掉的现象。 */
    if (_streamFrozen && isTypewriterStreamKind(kind)) return;
    _clearFirstEventGuard();
    _noteProjectorActivity();
    /* agentRunning 状态机 (兼容层):
     *   Entry 流上的 startKinds 可暂开 running; **权威收口是 ExecutionState**
     *   (applyExecution / run_state idle). agent_turn_done 只作备份.
     *   "片段结束" (*_done / tool_done) 不动 running — desktop 在 agent_turn_done 之后
     *   还会推 agent_text_done 等, 之前误开回 true 是"思考中"永不消失的真凶。 */
    const startKinds = {
      'agent_text_delta',
      'agent_thinking_delta',
      'tool_running',
      'tool_progress',
      'plan_update',
      'subagent_started',
      'subagent_progress',
    };
    if (kind == 'agent_turn_done' || kind == 'session_interrupted') {
      _setRunning(false);
      _clearCancelLatch();
      _syncTransportReattachTimer();
    } else if (_cancelPending) {
      /* 取消已请求、桌面还没收口 —— 在途事件照常渲染 (已产出的内容不能丢),
       * 但不许把"运行中"点回来, 否则停止按钮会闪回去 (见 markCancelRequested)。
       * 正文/思考增量不在此列: 它们在方法开头就按 `_streamFrozen` 丢掉了。 */
    } else if (startKinds.contains(kind)) {
      _setRunning(true);
      _syncTransportReattachTimer();
      /* 真活动到达 = 流恢复了, 重试 pill 收掉 (stream_recovered 有时会丢) */
      if (_retry != null && kind != 'plan_update') _retry = null;
    }
    switch (kind) {
      case 'agent_text_delta':
        {
          final content = _str(payload['content']) ?? '';
          if (content.isEmpty) return;
          /* 每段正文共用 stream-text-{turn}; agent_text_done 会 retire 腾位,
           * 下一段 delta 再 _upsert 时拿新 sequence (落在 tool 之后). */
          _upsert(
            id: 'stream-text-$turnId',
            kind: 'agent_text',
            timestamp: DateTime.now().millisecondsSinceEpoch,
            mutate: (e) {
              e.text = (e.text ?? '') + content;
              e.streaming = true;
              e.turnId = turnId;
              e.answerVersions = _turnAnswerVersions.isEmpty
                  ? null
                  : List<String>.from(_turnAnswerVersions);
              e.answerAnchorSeq = _turnAnswerAnchor;
            },
          );
          _flush();
          return;
        }
      case 'agent_text_done':
        {
          /* 段收口 — 必须 retire stream key, 否则同 turn 下一段答案仍挂在
           * 工具前的那条 entry 上 (顺序 bug 真凶). */
          _retireStreamEntry(
            'stream-text-$turnId',
            contentOf: (e) => e.text ?? '',
          );
          _flush();
          return;
        }
      case 'agent_thinking_delta':
        {
          final content = _str(payload['content']) ?? '';
          if (content.isEmpty) return;
          _upsert(
            id: 'stream-think-$turnId',
            kind: 'agent_thinking',
            timestamp: DateTime.now().millisecondsSinceEpoch,
            mutate: (e) {
              e.thinking = (e.thinking ?? '') + content;
              e.streaming = true;
              e.turnId = turnId;
            },
          );
          _flush();
          return;
        }
      case 'agent_thinking_done':
        {
          final idx = _byId['stream-think-$turnId'];
          if (idx != null) {
            final e = state.entries[idx];
            /* 真实思考时长 = 首 delta → done; 过滤异常大值 */
            e.thinkingDurationMs ??= _saneThinkingDuration(
              DateTime.now().millisecondsSinceEpoch - e.timestamp,
            );
          }
          _retireStreamEntry(
            'stream-think-$turnId',
            contentOf: (e) => e.thinking ?? e.text ?? '',
          );
          _flush();
          return;
        }
      case 'tool_running':
        {
          /* 用跟 drift `tool_call` 同一套宽松提取器, 不走 `payload['tool_call_id']` 硬读。
           *   真机 (远程): 发送端字段名有变体 (`tool_id`/`toolId`/`name`,
           *   args 可能是 JSON 串 —— 见 ws_client_provider 里 shell_output_stream
           *   分支就是 `tool_call_id ?? tool_id ?? toolId`)。硬读拿不到 callId 就
           *   直接 return, 结果是**整段"正在运行"状态丢失**: 摘要行退回完成态
           *   ("运行了 N 条命令")、扫光 (`ShimmerText(active: running)`) 永不亮 ——
           *   正是"运行命令时没有命令摘要和扫光"。宽松提取两种形态都能接住。 */
          final callId = _extractToolCallId(payload) ?? '';
          if (callId.isEmpty) return;
          /* 工具一开跑, 就把本轮还挂着的流式正文/思考收口.
           *
           * 桌面并不保证在 tool_running 之前先发 agent_text_done —— 模型写完话直接
           * 调工具时, 那条 text entry 会永远停在 streaming=true。后果有两个:
           *   1) 末尾的闪烁光标 (CursorBlink) 一直闪, 但那段话其实早写完了,
           *      下面工具行都起来了 —— 真机可见 (用户报的"等待时有个文字光标")
           *   2) 更隐蔽: stream key 没 retire, 本轮**下一段**正文会 append 回这条,
           *      渲染成"答案跑到工具上面去了" —— 正是历史上修过的错序 bug
           * agent 已经可见地进入下一步了, 收口是安全且正确的。 */
          _retireStreamEntry(
            'stream-text-$turnId',
            contentOf: (e) => e.text ?? '',
          );
          _retireStreamEntry(
            'stream-think-$turnId',
            contentOf: (e) => e.thinking ?? e.text ?? '',
          );
          final name = _toolName(payload) ?? 'tool';
          final args = _extractArgs(payload) ?? <String, dynamic>{};
          _upsert(
            id: 'tool-$callId',
            kind: 'tool',
            timestamp: DateTime.now().millisecondsSinceEpoch,
            mutate: (e) {
              e.toolCallId = callId;
              e.toolName ??= name;
              if ((e.args == null || e.args!.isEmpty) && args.isNotEmpty) {
                e.args = args;
              }
              if (!e.pending && e.output == null && !_doneToolCallIds.contains(callId)) e.pending = true;
              e.turnId ??= turnId;
            },
          );
          _flushUrgent();
          return;
        }
      case 'tool_progress':
        {
          final callId = _extractToolCallId(payload) ?? '';
          final chunk = (payload['chunk'] as String?) ?? '';
          if (callId.isEmpty || chunk.isEmpty) return;
          final idx = _byId['tool-$callId'];
          if (idx == null) return;
          final entry = state.entries[idx];
          entry.liveOutput = (entry.liveOutput ?? '') + chunk;
          _flushUrgent();
          return;
        }
      case 'tool_done':
        {
          final callId = _extractToolCallId(payload) ?? '';
          if (callId.isEmpty) return;
          _doneToolCallIds.add(callId);
          final idx = _byId['tool-$callId'];
          if (idx == null) return;
          final entry = state.entries[idx];
          entry.pending = false;
          entry.toolSuccess = payload['ok'] != false;
          /* 耗时由**桌面**按 runtime 事件时间戳算好后带过来 (协议 2026-07-29 新增)。
           * 手机自己拿"收到两条事件的时刻"相减会掺进网络+转发延迟, 是假数 ——
           * 没这个字段就不显示, 不编。 */
          final dur = payload['duration_ms'];
          if (dur is num && dur > 0) {
            final args = entry.args == null
                ? <String, dynamic>{}
                : Map<String, dynamic>.from(entry.args!);
            args['duration_ms'] = dur.toInt();
            entry.args = args;
          }
          _flushUrgent();
          return;
        }
      case 'agent_turn_done':
        {
          /* 备份收口 (权威仍是 ExecutionState idle). streaming turn_done
           * 是 best-effort, 丢包时靠 subscribe/attach 的 run_state 再 reconcile. */
          _reconcileTurnClosed();
          _ref
              .read(streamBufferProvider.notifier)
              .clearPendingUserText(_sessionId);
          _retry = null;
          _flush();
          return;
        }
      case 'session_interrupted':
        {
          // 把所有 pending tool / subagent 标记 fail, 并清空 thinking ghost
          for (final entry in state.entries) {
            if ((entry.kind == 'tool' || entry.kind == 'subagent') &&
                entry.pending) {
              entry.pending = false;
              entry.toolSuccess = false;
            }
            if (entry.streaming) entry.streaming = false;
          }
          _reconcileTurnClosed();
          _ref
              .read(streamBufferProvider.notifier)
              .clearPendingUserText(_sessionId);
          /* interrupted 已把 tool 标 fail; reconcile 只关 pending 不改 success —
           * 上面 fail 标记保留. */
          _retry = null;
          _flush();
          return;
        }

      /* ── v1.1 timeline 对齐桌面 ─────────────────────────────── */
      case 'plan_update':
        {
          _plan = _parsePlanCard(payload);
          _flush();
          return;
        }
      case 'subagent_started':
        {
          final agentId = (payload['agent_id'] as String?) ?? '';
          if (agentId.isEmpty) return;
          _upsertSubagent(
            agentId: agentId,
            task: (payload['task'] as String?) ?? '',
            roleName: payload['role_name'] as String?,
            isBackground: payload['is_background'] == true,
            isAgentTool: payload['is_agent_tool'] as bool?,
            turnId: turnId,
          );
          _flushUrgent();
          return;
        }
      case 'subagent_done':
        {
          final agentId = (payload['agent_id'] as String?) ?? '';
          if (agentId.isEmpty) return;
          final idx = _byId['subagent-$agentId'];
          if (idx == null) return;
          final e = state.entries[idx];
          e.pending = false;
          e.toolSuccess = payload['success'] != false;
          final summary = (payload['summary'] as String?) ?? '';
          if (summary.isNotEmpty) e.output = summary;
          /* 清 live 工具名; 存桌面给的真实耗时 (手机自己时间戳相减是假数) */
          final args = e.args == null
              ? <String, dynamic>{}
              : Map<String, dynamic>.from(e.args!);
          args.remove('live');
          final dur = payload['duration_ms'];
          if (dur is num && dur > 0) args['duration_ms'] = dur.toInt();
          e.args = args;
          _flushUrgent();
          return;
        }
      case 'subagent_progress':
        {
          final agentId = (payload['agent_id'] as String?) ?? '';
          if (agentId.isEmpty) return;
          final idx = _byId['subagent-$agentId'];
          if (idx == null) return;
          final e = state.entries[idx];
          final toolName = (payload['tool_name'] as String?)?.trim() ?? '';
          if (toolName.isNotEmpty) {
            final prev = e.args == null
                ? <String, dynamic>{}
                : Map<String, dynamic>.from(e.args!);
            prev['live'] = toolName;
            e.args = prev;
          }
          _flushUrgent();
          return;
        }
      case 'context_compaction':
        {
          /* Mode A/B: original_tokens/final_tokens; Mode C: before_tokens/after_tokens */
          final orig = _intOf(
            payload['original_tokens'] ?? payload['before_tokens'],
          );
          final fin = _intOf(payload['final_tokens'] ?? payload['after_tokens']);
          final running = (payload['status'] as String?) == 'running';
          /* 进行中与完成是**同一条**分隔线, 原地演化 (spinner → 最终数字):
           *   点压缩 → 立刻出现"正在压缩…" → 几十秒后原地变成 "42.7k → 10.5k · 释放 32.2k"
           * 所以 running 期间复用同一个 id (每轮一个), 完成时才 retire 这个 id ——
           * 否则一次压缩会在 timeline 上留下两条线 (一条转圈一条结果)。
           * id 用独立计数器: 时间戳同毫秒会撞 id 合并成一条 (单测抓到的真 bug)。 */
          final liveId = _liveCompactionId ??
              'compaction-${++_compactionCounter}';
          _liveCompactionId = running ? liveId : null;
          _upsert(
            id: liveId,
            kind: 'compaction',
            timestamp: DateTime.now().millisecondsSinceEpoch,
            mutate: (e) {
              e.pending = running;
              /* running 阶段没有数字, 别用 0 覆盖掉已有的真实值 */
              if (!running || e.args == null) {
                e.args = {
                  'original_tokens': orig,
                  'final_tokens': fin,
                  if (running) 'message': (payload['message'] as String?) ?? '',
                };
              }
              e.turnId = turnId;
            },
          );
          _flush();
          return;
        }
      case 'checkpoint':
        {
          final cid = ((payload['checkpoint_id'] ?? payload['id']) as String?)
                  ?.trim() ??
              '';
          if (cid.isEmpty) return;
          _upsert(
            id: 'checkpoint-$cid',
            kind: 'checkpoint',
            timestamp: DateTime.now().millisecondsSinceEpoch,
            mutate: (e) {
              e.args = {'checkpoint_id': cid, 'auto': payload['auto'] == true};
              e.turnId = turnId;
            },
          );
          _flush();
          return;
        }
      case 'stream_retry':
        {
          _retry = RetryPillState(
            attempt: _intOf(payload['attempt'], fallback: 1),
            maxRetries: _intOf(payload['max_retries']),
            kindLabel: payload['is_rate_limit'] == true
                ? 'rate_limit'
                : payload['is_stream_timeout'] == true
                    ? 'timeout'
                    : payload['is_network_error'] == true
                        ? 'network'
                        : 'other',
          );
          _flush();
          return;
        }
      case 'stream_recovered':
        {
          if (_retry == null) return;
          _retry = null;
          _flush();
          return;
        }
    }
  }

  /// session.subscribe 响应的 ui_state 快照 — plan + 活跃子代理一次性恢复.
  /// streaming plan_update / subagent_started 是 best-effort, 断线重连靠这条兜底.
  void applyUiStateSnapshot(Map<String, dynamic> uiState) {
    var changed = false;
    final planRaw = uiState['plan'];
    if (planRaw is Map) {
      final parsed = _parsePlanCard(
        planRaw.map((k, v) => MapEntry('$k', v)),
      );
      if (parsed != null) {
        _plan = parsed;
        changed = true;
      }
    }
    final subagents = uiState['active_subagents'];
    if (subagents is List) {
      for (final item in subagents) {
        if (item is! Map) continue;
        final m = item.map((k, v) => MapEntry('$k', v));
        final agentId = (m['agent_id'] as String?) ?? '';
        if (agentId.isEmpty) continue;
        _upsertSubagent(
          agentId: agentId,
          task: (m['task'] as String?) ?? '',
          roleName: m['role_name'] as String?,
          isBackground: m['is_background'] == true,
          isAgentTool: m['is_agent_tool'] as bool?,
          turnId: null,
        );
        changed = true;
      }
    }
    if (changed) _flush();
  }

  /// v1.3 mid-stream attach 快照 — 本轮已流出但未落 drift 的半成品
  /// (正文/思考/在跑工具)。语义 REPLACE: 直接重置本轮 streaming buffer 内容
  /// (桌面已保证快照含全部已流出 token, 排队 delta 在快照前 flush), 之后到达的
  /// delta 继续 append。轮转正常收口后 drift agent_text 会 upgrade-in-place
  /// 接管这些 entry (与实时流同一条路径)。
  void applyStreamingSnapshot(Map<String, dynamic> snap) {
    final turnId = (snap['turn_id'] as String?) ?? '';
    if (turnId.isEmpty) return;
    var changed = false;
    final now = DateTime.now().millisecondsSinceEpoch;
    final partialThinking = (snap['partial_thinking'] as String?) ?? '';
    if (partialThinking.isNotEmpty) {
      /* 槽位在 → 正常 REPLACE 半成品; 槽位**已被 retire** (段收口后迟到的快照) 且
       * 本轮已有同文本的思考 → 那是同一段, 重建只会多一条 (见 partialText 同款注释). */
      if (_hasStreamSlot('stream-think-$turnId') ||
          !_turnHasSameText(turnId, 'agent_thinking', partialThinking)) {
        _upsert(
          id: 'stream-think-$turnId',
          kind: 'agent_thinking',
          timestamp: now,
          mutate: (e) {
            e.thinking = partialThinking; // REPLACE, 不拼接
            e.streaming = true;
            e.turnId = turnId;
          },
        );
        changed = true;
      }
    }
    final partialText = (snap['partial_text'] as String?) ?? '';
    if (partialText.isNotEmpty) {
      /* 🔥 远程/高延迟双渲染真因 (2026-09-22): 正文流完 → text_done/tool_running 把
       *   `stream-text-{turn}` retire 成 `-seg-{n}` 并**释放槽位** → 重连 attach 的
       *   流式快照这时才到, 带着**同一段文本**。槽位既已为空, 原来无条件 _upsert 就
       *   新建一条, 与冻结段并排 → 同一句话渲两条。判据与 drift agent_text (L535)
       *   同款: 同 turn 去空白后文本相同 = 同一段, 不新建。槽位尚在时才无条件 REPLACE,
       *   否则 mid-stream attach 的续写会被误挡。 */
      if (_hasStreamSlot('stream-text-$turnId') ||
          !_turnHasSameText(turnId, 'agent_text', partialText)) {
        _upsert(
          id: 'stream-text-$turnId',
          kind: 'agent_text',
          timestamp: now,
          mutate: (e) {
            e.text = partialText; // REPLACE, 不拼接
            e.streaming = true;
            e.turnId = turnId;
          },
        );
        changed = true;
      }
    }
    final tools = snap['running_tools'];
    if (tools is List) {
      for (final t in tools) {
        if (t is! Map) continue;
        final m = t.map((k, v) => MapEntry('$k', v));
        final callId = (m['tool_call_id'] as String?) ?? '';
        if (callId.isEmpty) continue;
        _upsert(
          id: 'tool-$callId',
          kind: 'tool',
          timestamp: now,
          mutate: (e) {
            e.toolCallId = callId;
            e.toolName ??= (m['tool_name'] as String?) ?? 'tool';
            final args = m['args'];
            if ((e.args == null || e.args!.isEmpty) &&
                args is Map &&
                args.isNotEmpty) {
              e.args = args.map((k, v) => MapEntry('$k', v));
            }
            if (!e.pending && e.output == null) e.pending = true;
            e.turnId ??= turnId;
          },
        );
        changed = true;
      }
    }
    if (changed) {
      _setRunning(true); // 有半成品必然在跑; 权威 run_state 快照随后仍可覆盖
      _syncTransportReattachTimer();
      _flush();
    }
  }

  /// subagent entry 复用 TimelineEntry 泛型字段:
  ///   toolName=角色名, text=任务描述, output=完成摘要, pending=在跑.
  /// [isAgentTool] — true: agentTool 派的真子 agent, agentId 就是子会话 id,
  /// 手机可以 `session.history(agentId)` 拉它的独立时间轴;
  /// false: Explore/并行探索这类纯展示 worker, 桌面从不给它建会话;
  /// null: 老桌面没带这个字段, 未知 (UI 仍允许点开, 拉不到再降级显摘要).
  void _upsertSubagent({
    required String agentId,
    required String task,
    String? roleName,
    required bool isBackground,
    bool? isAgentTool,
    String? turnId,
  }) {
    _upsert(
      id: 'subagent-$agentId',
      kind: 'subagent',
      timestamp: DateTime.now().millisecondsSinceEpoch,
      mutate: (e) {
        e.toolName = (roleName != null && roleName.isNotEmpty)
            ? roleName
            : 'agent';
        if (task.isNotEmpty) e.text = task;
        e.args = {
          'agent_id': agentId,
          'is_background': isBackground,
          if (isAgentTool != null) 'is_agent_tool': isAgentTool,
        };
        if (e.output == null) e.pending = true;
        e.turnId ??= turnId;
      },
    );
  }

  PlanCardState? _parsePlanCard(Map<String, dynamic> payload) {
    final rawSteps = payload['plan'];
    if (rawSteps is! List) return null;
    final steps = <PlanStepState>[];
    for (final s in rawSteps) {
      if (s is! Map) continue;
      final step = (s['step'] ?? s['content'] ?? '').toString().trim();
      if (step.isEmpty) continue;
      steps.add(
        PlanStepState(
          step: step,
          status: (s['status'] ?? 'pending').toString(),
        ),
      );
    }
    if (steps.isEmpty) return null;
    final explanation = (payload['explanation'] as String?)?.trim();
    return PlanCardState(
      steps: steps,
      explanation: (explanation == null || explanation.isEmpty)
          ? null
          : explanation,
      updatedAt: _intOf(
        payload['updated_at'],
        fallback: DateTime.now().millisecondsSinceEpoch,
      ),
    );
  }

  int _intOf(dynamic v, {int fallback = 0}) {
    if (v is int) return v;
    if (v is num) return v.toInt();
    if (v is String) return int.tryParse(v) ?? fallback;
    return fallback;
  }

  /// 思考时长合理性: 单段 reasoning 通常数秒到一两分钟.
  /// hydrate 误用 now-ev.ts 会得到「打开会话距思考事件多久」(常 5–15 分钟)
  /// — 超过 3 分钟视为假时长, 不显示.
  static const _kMaxThinkingDurationMs = 3 * 60 * 1000;
  static int? _saneThinkingDuration(int? ms) {
    if (ms == null || ms < 0) return null;
    if (ms > _kMaxThinkingDurationMs) return null;
    return ms;
  }

  /// 段收口: 释放 `stream-text|think-{turn}` 槽位.
  ///
  /// - 有内容 → 改成冻结 id (`{streamId}-seg-{sequence}`), 保留 sequence/位置
  /// - 空内容 → 删除 entry (避免底栏残留 `thinking ▸`)
  /// 之后同 turn 的新 delta 会新建 stream entry, sequence = ++counter (落在 tool 后).
  void _retireStreamEntry(
    String streamId, {
    required String Function(TimelineEntry) contentOf,
  }) {
    final idx = _byId[streamId];
    if (idx == null) return;
    final old = state.entries[idx];
    final content = contentOf(old);
    if (content.trim().isEmpty) {
      state.entries.removeAt(idx);
      _byId.remove(streamId);
      for (var i = idx; i < state.entries.length; i++) {
        _byId[state.entries[i].id] = i;
      }
      return;
    }
    final frozenId = '$streamId-seg-${old.sequence}';
    final frozen = TimelineEntry(
      id: frozenId,
      kind: old.kind,
      sequence: old.sequence,
      timestamp: old.timestamp,
      text: old.text,
      thinking: old.thinking,
      streaming: false,
      turnId: old.turnId,
    )
      ..thinkingDurationMs = old.thinkingDurationMs
      ..driftSeq = old.driftSeq
      ..createdAtMs = old.createdAtMs;
    state.entries[idx] = frozen;
    _byId.remove(streamId);
    _byId[frozenId] = idx;
  }

  /// 流式槽位是否还在 (未 retire) —— 在 = 本轮这一段正流着, 快照可无条件 REPLACE.
  bool _hasStreamSlot(String slotId) => _byId.containsKey(slotId);

  /// 本轮是否已有同文本的 [kind] entry (含收口后冻结的 `-seg-{n}`).
  ///
  /// 只服务于"槽位已被 retire 的迟到 attach 快照": 那种快照带的是**已收口那一段**的
  /* 归一化 / 剥标签用的正则 —— 2026-09-22 提到 static final.
   *
   * 原来它们都是写在方法体里的字面量, 而这几条路径全在**热路径**上:
   * `_applyDriftInner` 每来一条 drift 事件跑一次; `_turnHasSameText` 在迟到快照
   * 到达时对整张 entries 逐条归一化 —— 每次迭代都重新编译一遍 RegExp 是纯浪费
   * (Dart 不缓存函数体内的字面量)。`\s+` 这一条在文件里出现 6 次, 影响最大。 */
  static final _reWhitespace = RegExp(r'\s+');
  static final _reMarkdownImageTarget = RegExp(r'(!\[[^\]\n]*\])\([^)\s]*\)');

  /// 同 turn 正文去重用: 去空白, 图片只比 alt 不比地址 (见 agent_text 分支)
  static String _normalizeForDedup(String s) =>
      s.replaceAllMapped(_reMarkdownImageTarget, (m) => m[1]!).replaceAll(_reWhitespace, '');
  static final _reCurrentTimeTag = RegExp(
    r'<(current-time|reply-language)>.*?</\1>',
    dotAll: true,
  );
  static final _reSystemReminderTag = RegExp(
    r'<system-reminder>.*?</system-reminder>',
    dotAll: true,
  );

  /// 旧文本, 无条件重建就是双渲染 (远程高延迟真机现象)。判据与 drift agent_text 一脉
  /// 相承 —— 去空白后相同即同一段 (桌面偶发 token 累积版 vs text_complete 版只差空白)。
  bool _turnHasSameText(String turnId, String kind, String text) {
    final normalized = text.replaceAll(_reWhitespace, '');
    if (normalized.isEmpty) return false;
    for (final e in state.entries) {
      if (e.kind != kind) continue;
      if ((e.turnId ?? 'default') != turnId) continue;
      final existing = (e.text ?? e.thinking ?? '')
          .replaceAll(_reWhitespace, '');
      if (existing == normalized) return true;
    }
    return false;
  }

  static int? _minSeq(int? a, int? b) =>
      a == null ? b : (b == null ? a : (a < b ? a : b));

  /// 迟到的 user_message 该插在哪 (2026-09-17 真机: 「我发的消息钉在最底下, 新回复长在它上面」).
  ///
  /// 从末尾往前扫, 跳过**一定属于这条消息之后**的 entry, 停在第一个**一定在它之前**的:
  ///   · 有 driftSeq: > userSeq 在后 (跳过), < userSeq 在前 (停)。服务端一轮里 user_message
  ///     最先写, 这是唯一跨时钟可靠的先后判据 (手机/桌面时间戳不能比)。
  ///   · 没 driftSeq (实时流式, 还没落库): 本轮开始后才建的算"在后" (跳过);
  ///     上一轮收口前就有的算"在前" (停) —— 防止把新消息插到上一轮没落库的残留行上面。
  /// 返回插入下标; == length 表示追加。
  int _userMessageInsertIndex(int userSeq) {
    var at = state.entries.length;
    for (var i = state.entries.length - 1; i >= 0; i--) {
      final e = state.entries[i];
      final ds = e.driftSeq;
      final after = ds != null ? ds > userSeq : e.sequence > _turnBoundarySeq;
      if (!after) break;
      at = i;
    }
    return at;
  }

  /// 上一轮收口 (agent_turn_done / session_interrupted) 时的 _seqCounter —— 之后建的无 driftSeq entry 属于新一轮.
  int _turnBoundarySeq = 0;

  /// 正在 apply 的 drift 事件 seq (_applyDrift 期间有值) —— _upsert 据此给 entry 记 driftSeq.
  int? _applyingDriftSeq;

  /// upsert by id — 找到则原地 mutate, 没找到 push 新 entry (sequence 通过 _nextSeq()).
  ///
  /// 单调 sequence 策略 (跟 Desktop `timelineStore.tsx` line 230/243 一致):
  ///   - 新 entry: sequence = _nextSeq() (++counter). 直接 append 到列表末尾.
  ///   - 已存在 entry: 保留 sequence 不动, 只 mutate 内容字段。
  /// 这样最终列表里 sequence 严格单调递增, 顺序 == 事件到达 mobile 的顺序 ==
  /// 用户感知顺序 (agent 说话 → 调工具 → 总结)。
  /// **前提**: 每段正文/思考在 done 时 retire stream id, 下一段才能拿到新 sequence.
  void _upsert({
    required String id,
    required String kind,
    required int timestamp,
    required void Function(TimelineEntry) mutate,
  }) {
    final existIdx = _byId[id];
    if (existIdx != null) {
      final e = state.entries[existIdx];
      if (_kTimelineDebugLogs && kDebugMode) {
        debugPrint('[TIMELINE_UPSERT_EXIST] id=$id keepSeq=${e.sequence}');
      }
      mutate(e);
      e.driftSeq = _minSeq(e.driftSeq, _applyingDriftSeq);
      return;
    }
    final seq = _prepending ? ++_prependFloor : _nextSeq();
    if (_kTimelineDebugLogs && kDebugMode) {
      debugPrint('[TIMELINE_UPSERT_NEW] id=$id seq=$seq kind=$kind');
    }
    final newEntry = TimelineEntry(
      id: id,
      kind: kind,
      sequence: seq,
      timestamp: timestamp,
    )
      ..driftSeq = _applyingDriftSeq
      ..createdAtMs = DateTime.now().millisecondsSinceEpoch;
    mutate(newEntry);
    /* 迟到的 user_message 按服务端 seq 归位, 不追加到末尾 (见 _userMessageInsertIndex) */
    if (!_prepending && kind == 'user_message' && _applyingDriftSeq != null) {
      final at = _userMessageInsertIndex(_applyingDriftSeq!);
      if (at < state.entries.length) {
        state.entries.insert(at, newEntry);
        for (var i = at; i < state.entries.length; i++) {
          _byId[state.entries[i].id] = i;
        }
        return;
      }
    }
    if (_prepending) {
      /* 历史回填 — 按批内顺序插到列表前端, 全量重建索引 (翻页是低频用户动作) */
      state.entries.insert(_prependInsertPos++, newEntry);
      _byId.clear();
      for (var i = 0; i < state.entries.length; i++) {
        _byId[state.entries[i].id] = i;
      }
      return;
    }
    /* 断线补缺 —— 按 driftSeq 插回原位, 不能 append (见 _applyMiddleDriftBatch) */
    if (_insertingMiddle && _applyingDriftSeq != null) {
      final at = _insertIndexForDriftSeq(_applyingDriftSeq!);
      state.entries.insert(at, newEntry);
      _reindexFrom(at);
      return;
    }
    /* 新 entry 直接 append 末尾 — counter 单调递增, 不需要排序 */
    state.entries.add(newEntry);
    _byId[id] = state.entries.length - 1;
  }

  /// 触发 Riverpod 重建 — 给 entries list 一个新引用.
  ///
  /// 顺序保证靠: (1) streaming 到达序分配 sequence; (2) 段 done 时 retire stream id,
  /// 下一段拿新 sequence; (3) drift upgrade 只接管**当前** stream entry.
  /// 不需要任何 flush 期重排。
  ///
  /// **batching**: token delta 风暴时一秒能调 100+ 次 _flush, 每次都 List.of 复制 +
  /// Riverpod notify + UI rebuild → 低端机会卡。
  ///
  /// 两级合并 (2026-07-20 流式渲染缓冲):
  ///   1. 微任务合并 — 同一同步路径多次调用只 1 次 flush (原有).
  ///   2. 帧率节流 — 正文/思考 delta 用 32ms (~30fps), 跟上桌面 coalesce;
  ///      **工具** appear/progress/done 用 `_flushUrgent` 16ms (~60fps),
  ///      避免工具行一顿一顿冒出来。
  /// entries 本身是 mutable list, 同步代码继续读 state.entries
  /// 看到的还是 latest mutation, 不影响正确性。
  static const _kFlushMinGapMs = 32;
  static const _kFlushUrgentGapMs = 16;
  bool _flushScheduled = false;
  Timer? _flushTimer;
  int _lastFlushAtMs = 0;
  int _pendingFlushGapMs = _kFlushMinGapMs;

  void _flushUrgent() => _flush(minGapMs: _kFlushUrgentGapMs);

  void _flush({int minGapMs = _kFlushMinGapMs}) {
    final elapsed =
        DateTime.now().millisecondsSinceEpoch - _lastFlushAtMs;
    if (_flushScheduled) {
      /* 已排队的慢 flush 可被紧急 flush 提速 (工具出现别等正文节流) */
      if (minGapMs >= _pendingFlushGapMs) return;
      _pendingFlushGapMs = minGapMs;
      _flushTimer?.cancel();
      _flushTimer = null;
      if (elapsed >= minGapMs) {
        scheduleMicrotask(_doFlush);
      } else {
        _flushTimer = Timer(
          Duration(milliseconds: minGapMs - elapsed),
          _doFlush,
        );
      }
      return;
    }
    _flushScheduled = true;
    _pendingFlushGapMs = minGapMs;
    if (elapsed >= minGapMs) {
      scheduleMicrotask(_doFlush);
    } else {
      _flushTimer = Timer(
        Duration(milliseconds: minGapMs - elapsed),
        _doFlush,
      );
    }
  }

  void _doFlush() {
    _flushScheduled = false;
    _flushTimer = null;
    _pendingFlushGapMs = _kFlushMinGapMs;
    _lastFlushAtMs = DateTime.now().millisecondsSinceEpoch;
    /* 在 dispose 后微任务才执行的 race — Riverpod 不允许 disposed notifier 改 state */
    if (!mounted) return;
    /* 会话已经空闲 (不在跑、没有等审批的工具) 时, 还挂着 pending 的工具步骤只可能是结果没配上
     * (补历史时结果在另一页 / 电脑那边没落库) —— 不能一直写「正在等输出」「正在读取」, 看着像卡死
     * (2026-10-12 真机长会话)。这里按「已结束」收口; 真结果后到照样覆盖。 */
    if (_runStateKnown && !_agentRunning && _runStatus == 'idle' && _pendingTools.isEmpty && !_ephemeral) {
      for (final e in state.entries) {
        if (e.kind == 'tool' && e.pending) e.pending = false;
      }
    }
    state = TimelineSnapshot(
      List.of(state.entries),
      agentRunning: _agentRunning,
      runStatus: _runStatus,
      initiatedBy: _initiatedBy,
      pendingTools: _pendingTools,
      plan: _plan,
      retry: _retry,
      streamFrozen: _streamFrozen,
    );
    if (_kTimelineDebugLogs && kDebugMode) {
      final dump = state.entries
          .map((e) => '${e.kind}(seq=${e.sequence},id=${e.id})')
          .join(' → ');
      debugPrint('[TIMELINE_STATE] $dump');
    }
  }

  // ─── helpers ──────────────────────────────────────────────────────────

  /// 剥掉桌面注入 user message 的隐藏上下文标签 (current-time / attachments 提示等).
  /// 这些是给 LLM 的环境信息, 不是用户打的字 — 渲染和 dedup 都不该看到.
  static String _stripHiddenContextTags(String text) {
    return text
        .replaceAll(_reCurrentTimeTag, '')
        .replaceAll(_reSystemReminderTag, '')
        /* 语音回合 (桌面 VoiceMode / Pilot 通话): 剥 <voice-turn> 壳, 给模型的 <neox-directive> 整段不显示 ——
         * 跟桌面 mapTimeline 同一条规矩, 不然手机上看到的是一串标签 */
        .replaceAll(_reNeoxDirectiveTag, '')
        .replaceAll(_reVoiceTurnShell, '')
        .trim();
  }

  static final _reNeoxDirectiveTag = RegExp(r'<neox-directive>.*?</neox-directive>', dotAll: true);
  static final _reVoiceTurnShell = RegExp(r'</?voice-turn>');

  Object? _safeDecode(String s) {
    try {
      return jsonDecode(s);
    } catch (_) {
      return s;
    }
  }

  String? _turnIdOf(Object? payload) {
    if (payload is Map) {
      final t = payload['turn_id'];
      if (t is String && t.isNotEmpty) return t;
    }
    return null;
  }

  /// 从 payload 里取正文。取不到就是**空串**, 绝不退回 payload 原文.
  ///
  /// `fallback` 只服务一种情形: payload 压根不是结构化数据 (JSON 解不开, 于是
  /// 传进来的 `payload` 是 null), 那时整个原文就是正文本身。
  ///
  /// 2026-07-30 真机实锤: 以前 payload 是 Map 但没有可用文本字段时也退回原文,
  /// 于是 `{"role":"assistant","content":"","turn_id":"chat-…"}` 这种空正文的
  /// assistant 信封被整条 JSON 印在时间轴上 (sleep 90 那轮出现两次)。Map 进来
  /// 就说明数据是结构化的 —— 里面没文本就是真没文本, 编一段 JSON 出来只会更糟.
  String _stringFrom(Object? payload, String fallback) {
    if (payload is Map) {
      for (final k in const ['text', 'content', 'message']) {
        final v = payload[k];
        if (v is String && v.isNotEmpty) return v;
        if (v is List) {
          final buf = StringBuffer();
          for (final p in v) {
            if (p is Map && p['type'] == 'text' && p['text'] is String) {
              /* 用换行连接, 不是无分隔粘连 —— 内核把「[系统注入]…」/ 每张图的说明 /
               * `![](neox-image://…)` 拆成多个 text part 传下来, 粘成一行之后下游
               * (工具截图卡按行切 label) 就再也分不出哪段是哪段, 图片引用被当成说明
               * 文字的一部分印在界面上 (2026-10-12 真机实拍)。 */
              if (buf.isNotEmpty) buf.write('\n');
              buf.write(p['text']);
            }
          }
          if (buf.isNotEmpty) return buf.toString();
        }
      }
      return '';
    }
    if (payload is String && payload.isNotEmpty) return payload;
    if (payload is List) return '';
    return fallback;
  }

  String? _extractToolCallId(Object? payload) {
    if (payload is! Map) return null;
    final tc = payload['tool_calls'];
    if (tc is List && tc.isNotEmpty && tc.first is Map) {
      final id = (tc.first as Map)['id'];
      if (id is String && id.isNotEmpty) return id;
    }
    /* 发送端字段名变体 (远程 / 中转链路): tool_call_id / tool_id / toolId ——
     * 与 ws_client_provider 里 shell_output_stream 分支的兜底同一套 (那里的
     * `p['tool_call_id'] ?? p['tool_id'] ?? p['toolId']` 就是实证)。只认一种,
     * 另一种形态的事件就被静默丢弃, 表现为"运行中状态整段不见"。 */
    for (final k in const ['tool_call_id', 'tool_id', 'toolId']) {
      final v = payload[k];
      if (v is String && v.isNotEmpty) return v;
    }
    return null;
  }

  String? _toolName(Object? payload) {
    if (payload is! Map) return null;
    if (payload['tool_name'] is String) return payload['tool_name'] as String;
    if (payload['name'] is String) return payload['name'] as String;
    final tc = payload['tool_calls'];
    if (tc is List && tc.isNotEmpty && tc.first is Map) {
      final first = tc.first as Map;
      final fn = first['function'];
      if (fn is Map && fn['name'] is String) return fn['name'] as String;
      if (first['name'] is String) return first['name'] as String;
    }
    return null;
  }

  Map<String, dynamic>? _extractArgs(Object? payload) {
    if (payload is! Map) return null;
    final tc = payload['tool_calls'];
    if (tc is List && tc.isNotEmpty && tc.first is Map) {
      final fn = (tc.first as Map)['function'];
      if (fn is Map) {
        final a = fn['arguments'];
        if (a is String) {
          try {
            final parsed = jsonDecode(a);
            if (parsed is Map<String, dynamic>) return parsed;
          } catch (_) {}
        }
        if (a is Map<String, dynamic>) return a;
      }
    }
    for (final k in const ['arguments', 'args', 'input']) {
      final v = payload[k];
      if (v is Map<String, dynamic>) return v;
      if (v is String) {
        try {
          final parsed = jsonDecode(v);
          if (parsed is Map<String, dynamic>) return parsed;
        } catch (_) {}
      }
    }
    return null;
  }

  /// 从 tool_result payload 里取产物清单 (桌面 artifactRegistry 挂上来的).
  ///
  /// 没有就返回 null 而不是空列表 —— 返回空会把已有的清掉, 而重连补发的同一条
  /// tool_result 有可能不带 artifacts (登记项过了 TTL)。
  List<Map<String, dynamic>>? _artifactsFrom(Object? payload) {
    if (payload is! Map) return null;
    final raw = payload['artifacts'];
    if (raw is! List || raw.isEmpty) return null;
    final out = <Map<String, dynamic>>[];
    for (final item in raw) {
      if (item is Map) out.add(Map<String, dynamic>.from(item));
    }
    return out.isEmpty ? null : out;
  }

  bool _isResultError(Object? payload, String fallbackText) {
    if (payload is Map) {
      if (payload['ok'] == false ||
          payload['success'] == false ||
          payload['error'] != null) {
        return true;
      }
    }
    return fallbackText.startsWith('✗') || fallbackText.startsWith('❌');
  }
}

/// 每个 session 一个 TimelineStateController. family by sessionId.
final timelineStateProvider =
    StateNotifierProvider.family<
      TimelineStateController,
      TimelineSnapshot,
      String
    >((ref, sessionId) => TimelineStateController(ref, sessionId));
