/// subagent_registry.dart — 主会话里"当前有哪些子 agent"的只读投影.
///
/// 真相源仍是 [timelineStateProvider] 里 kind=='subagent' 的 entry
/// (subagent_started/progress/done 三个事件维护, 断线重连由 session.subscribe 的
/// ui_state.active_subagents 兜底)。这里只做一层结构化视图, 给:
///   - 输入框上方的「N 个 agent 运行中」状态条
///   - 状态条点开的 agent 菜单
///   - 主 timeline 上那条痕迹 (SubagentBlock) 打开悬浮窗时取元信息
///
/// **关键事实**: `agentId` 就是桌面那边子会话的 sessionId —— 桌面 sub-agent
/// 生命周期 started 时会 `createSession({ sessionId: agentId, parentSessionId: 父 })`,
/// 所以拿它直接 `session.history` 就能读到子 agent 的真实 timeline, 不需要新协议。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'timeline_state.dart';

/// 一个子 agent 的当前状态快照.
class SubagentRef {
  const SubagentRef({
    required this.agentId,
    required this.role,
    required this.task,
    required this.running,
    required this.success,
    required this.isBackground,
    required this.startedAt,
    this.isAgentTool,
    this.live,
    this.durationMs,
    this.summary,
  });

  /// 子会话 id (== 桌面 agentId).
  final String agentId;

  /// 角色名, 如 Explore / claude / general-purpose.
  final String role;

  /// 任务描述 — 菜单里的主标题.
  final String task;

  final bool running;
  final bool success;
  final bool isBackground;

  /// 桌面 `subagent_started.is_agent_tool` 透传, **决定这条能不能点开悬浮窗**:
  ///   true  — agentTool (Agent/Task 工具) 派的真子 agent, agentId 就是子会话 id;
  ///   false — Explore/并行探索这类展示 worker (agentId 是 `Explorer-3` 之类的
  ///           假 id), 桌面从不给它建会话, 查不到任何时间轴;
  ///   null  — 老桌面没带这个字段, 未知 → 仍允许点开, 拉空再降级显摘要。
  final bool? isAgentTool;

  /// 有没有独立子会话可看. 老桌面 (null) 按"可能有"处理, 保住兼容。
  bool get hasSession => isAgentTool != false;

  /// 真·子 agent (Explore 不算) — 状态条 / agent 菜单只统计这一类。
  bool get isRealSubagent => isAgentTool == true;

  /// 首次出现的时间戳 (ms) — 运行中的耗时按它算.
  final int startedAt;

  /// 运行中正在跑的工具名 (subagent_progress).
  final String? live;

  /// 桌面 subagent_done 带的真实耗时; 跑完才有.
  final int? durationMs;

  /// 完成摘要.
  final String? summary;

  /// 已跑时长 — 跑完用桌面给的真值, 在跑用本地时钟估.
  /// 注: 运行中是估算 (手机时钟 - 首次事件到达时刻), 桌面那侧的真实起点更早;
  /// 跑完后一律以 [durationMs] 为准, 不显示估算值。
  Duration elapsed(int nowMs) => Duration(
        milliseconds: durationMs ?? (nowMs - startedAt).clamp(0, 1 << 31),
      );

  String get displayName => task.trim().isNotEmpty ? task.trim() : role;
}

/// 单条 session 的子 agent 列表 (含已完成的, 按出现顺序).
final subagentsProvider = Provider.family<List<SubagentRef>, String>((
  ref,
  sessionId,
) {
  final entries = ref.watch(
    timelineStateProvider(sessionId).select((s) => s.entries),
  );
  final out = <SubagentRef>[];
  for (final e in entries) {
    if (e.kind != 'subagent') continue;
    final args = e.args ?? const <String, dynamic>{};
    final agentId = (args['agent_id'] as String?) ?? '';
    if (agentId.isEmpty) continue;
    final live = (args['live'] as String?)?.trim();
    final dur = args['duration_ms'];
    out.add(
      SubagentRef(
        agentId: agentId,
        role: e.toolName ?? 'agent',
        task: e.text ?? '',
        running: e.pending,
        success: e.toolSuccess,
        isBackground: args['is_background'] == true,
        isAgentTool: args['is_agent_tool'] as bool?,
        startedAt: e.timestamp,
        live: (live == null || live.isEmpty) ? null : live,
        durationMs: dur is int ? dur : null,
        summary: e.output,
      ),
    );
  }
  return out;
});

/// agent 菜单用 — **只含真子 agent**, Explore/并行探索不算.
///
/// 明康 2026-07-29 指出的语义: Explore 是主 agent 的一次工具调用 (已经在 timeline
/// 的工具组里显示了 "探索 ×2 · 35s"), 不是一个独立在跑的 agent; 把它算进
/// "N 个 agent 运行中" 是把两种东西混为一谈, 点开还没有时间轴可看。
final realSubagentsProvider = Provider.family<List<SubagentRef>, String>((
  ref,
  sessionId,
) {
  final all = ref.watch(subagentsProvider(sessionId));
  return all.where((s) => s.isRealSubagent).toList(growable: false);
});

/// 只有在跑的真子 agent — 状态条用. 空列表 = 状态条完全不占位 (跑完即消失).
final runningSubagentsProvider = Provider.family<List<SubagentRef>, String>((
  ref,
  sessionId,
) {
  final all = ref.watch(realSubagentsProvider(sessionId));
  return all.where((s) => s.running).toList(growable: false);
});
