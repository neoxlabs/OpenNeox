/// subagent_page.dart — 子 agent 会话页: 整页展示子 agent 的真实 timeline.
///
/// 交互 (明康 2026-07-29 定): 点主 timeline 的子 agent 痕迹 → **整页切过去**,
/// 顶部返回箭头退回父会话。之前做成半屏 bottom sheet, 内容被截、要滚要放大,
/// "都没什么可看的" —— 子会话的输出往往是长报告, 天生就该整页读。
///
/// 数据来源不是新协议, 而是桌面既有的子会话: sub-agent 启动时桌面会
/// `createSession({ sessionId: agentId, parentSessionId: 父 })`, 所以
/// `session.history(agentId)` 拉回来的就是这个子 agent 的完整时间轴, 用主会话
/// 同一套渲染管线 (groupToolEntries + MessageRow/ToolGroupRow) 画出来。
///
/// 性能红线 (明康点名):
///   - 按需拉取: 只有进页才请求, 不预取、不常驻订阅;
///   - 子会话事件**不进主会话 drift 表** — 走 ephemeral 内存投影;
///   - 退出即释放: controller 是 autoDispose family, 轮询计时器在 dispose 里取消。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/ws_client_provider.dart';
import '../../../core/session_routing/session_router.dart';
import '../../../core/storage/database.dart';
import '../../../shared/clay/clay.dart';
import '../../../shared/theme/neox_tokens.dart';
import '../state/subagent_registry.dart';
import '../state/timeline_state.dart';
import 'message_row.dart';
import 'tool_group_row.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 子 agent 会话的内存态 timeline — 关窗即销毁 (autoDispose), 不落 drift.
final subagentTimelineProvider = StateNotifierProvider.autoDispose
    .family<TimelineStateController, TimelineSnapshot, String>(
  (ref, childSessionId) =>
      TimelineStateController.ephemeral(ref, childSessionId),
);

/// 进子 agent 会话页. [parentSessionId] 用来跟踪该 agent 是否还在跑.
/// [reportOnly] = 只看最终报告 (跳过工具行/思考, 直接给子 agent 的正文产出)。
Future<void> openSubagentSession(
  BuildContext context, {
  required String parentSessionId,
  required String agentId,
  bool reportOnly = false,
  String? fallbackTitle,
}) {
  return Navigator.of(context).push<void>(
    MaterialPageRoute(
      builder: (_) => SubagentSessionPage(
        parentSessionId: parentSessionId,
        agentId: agentId,
        reportOnly: reportOnly,
        fallbackTitle: fallbackTitle,
      ),
    ),
  );
}

/// 长按子 agent 痕迹 / 完成卡弹出的动作菜单 (明康 2026-07-29 定).
///
/// 单击是"展开看摘要"这种轻动作, 重动作全收进长按菜单 —— 免得一行上挂三四个
/// 小图标, 手机上既点不准也看着乱。
Future<void> showSubagentActionMenu(
  BuildContext context,
  WidgetRef ref, {
  required String parentSessionId,
  required String agentId,
  String? title,
  String? summary,
  bool running = false,
}) async {
  final action = await showModalBottomSheet<String>(
    context: context,
    backgroundColor: Colors.transparent,
    builder: (ctx) {
      final theme = Theme.of(ctx);
      final scheme = theme.colorScheme;
      return SafeArea(
        top: false,
        child: Container(
          decoration: BoxDecoration(
            color: scheme.surface,
            borderRadius: const BorderRadius.vertical(
              top: Radius.circular(NeoxRadius.card),
            ),
          ),
          padding: const EdgeInsets.only(bottom: NeoxSpace.sm),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (title != null && title.trim().isNotEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    NeoxSpace.lg,
                    NeoxSpace.md,
                    NeoxSpace.lg,
                    NeoxSpace.xs,
                  ),
                  child: Row(
                    children: [
                      Icon(
                        Icons.smart_toy_outlined,
                        size: 15,
                        color: scheme.onSurfaceVariant,
                      ),
                      const SizedBox(width: NeoxSpace.sm),
                      Expanded(
                        child: Text(
                          title.trim(),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.labelMedium?.copyWith(
                            color: scheme.onSurfaceVariant,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ListTile(
                dense: true,
                leading: const Icon(Icons.forum_outlined, size: 20),
                title: Text(tr('进子任务页')),
                subtitle: Text(tr('整页看它自己的完整时间轴')),
                onTap: () => Navigator.of(ctx).pop('session'),
              ),
              ListTile(
                dense: true,
                leading: const Icon(Icons.article_outlined, size: 20),
                title: Text(tr('看完整报告')),
                subtitle: Text(tr('只看它最后交出来的正文产出')),
                onTap: () => Navigator.of(ctx).pop('report'),
              ),
              if (running)
                ListTile(
                  dense: true,
                  leading: Icon(
                    Icons.stop_circle_outlined,
                    size: 20,
                    color: scheme.error,
                  ),
                  title: Text(
                    tr('停掉这个子任务'),
                    style: TextStyle(color: scheme.error),
                  ),
                  subtitle: Text(tr('只停它, 主任务和其它子任务照常跑')),
                  onTap: () => Navigator.of(ctx).pop('stop'),
                ),
            ],
          ),
        ),
      );
    },
  );
  if (action == null || !context.mounted) return;
  if (action == 'stop') {
    await _stopSubagent(context, ref, parentSessionId, agentId);
    return;
  }
  await openSubagentSession(
    context,
    parentSessionId: parentSessionId,
    agentId: agentId,
    reportOnly: action == 'report',
    fallbackTitle: title,
  );
}

/// 只停这一个子 agent — 走 `control:stop_agent`, 落到桌面
/// `client.abortSubAgent` → `BackgroundAgentManager.abort(agentId)`,
/// 跟桌面 SubAgentsBar 的停止按钮同一条通路。
///
/// **不是** `control:cancel`: 那个是整会话级中断, 会把主 agent 和其它子 agent
/// 一起打断。子 agent 停掉后桌面照常发 subagent_done(success=false),
/// 手机那条痕迹自然收口, 这里不做乐观置位。
Future<void> _stopSubagent(
  BuildContext context,
  WidgetRef ref,
  String parentSessionId,
  String agentId,
) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  try {
    await ref.read(sessionRouterProvider).sendControl(
          sessionId: parentSessionId,
          kind: 'control:stop_agent',
          payload: {'agent_id': agentId},
        );
    messenger?.showSnackBar(
      SnackBar(content: Text(tr('已请求停掉这个子任务'))),
    );
  } catch (e) {
    messenger?.showSnackBar(
      SnackBar(content: Text(tr('停不掉: $e'))),
    );
  }
}

class SubagentSessionPage extends ConsumerStatefulWidget {
  const SubagentSessionPage({
    super.key,
    required this.parentSessionId,
    required this.agentId,
    this.reportOnly = false,
    this.fallbackTitle,
  });

  final String parentSessionId;
  final String agentId;

  /// 只渲染最终报告 (最后一段 agent 正文), 不铺工具行/思考.
  final bool reportOnly;

  /// meta 缺失时的标题兜底 —— `subagent_started` 是 streaming 事件不落 drift,
  /// app 重启后父会话就没这条 meta 了, 从完成卡进来只能显示"子 agent"。
  final String? fallbackTitle;

  @override
  ConsumerState<SubagentSessionPage> createState() =>
      _SubagentSessionPageState();
}

class _SubagentSessionPageState extends ConsumerState<SubagentSessionPage> {
  bool _loading = true;
  bool _emptyRemote = false;
  String? _error;
  Timer? _poll;

  /// 在跑的子 agent 每 3s 增量重拉一次 — 只在窗口开着的时候。
  static const _pollInterval = Duration(seconds: 3);

  @override
  void initState() {
    super.initState();
    unawaited(_load(initial: true));
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  SubagentRef? get _meta {
    final list = ref.read(subagentsProvider(widget.parentSessionId));
    for (final s in list) {
      if (s.agentId == widget.agentId) return s;
    }
    return null;
  }

  Future<void> _load({bool initial = false}) async {
    if (!mounted) return;
    try {
      final events = await ref
          .read(wsClientProvider.notifier)
          .fetchSubagentHistory(widget.agentId);
      if (!mounted) return;
      final scoped = currentDispatchOnly(events);
      if (scoped.isNotEmpty) {
        ref
            .read(subagentTimelineProvider(widget.agentId).notifier)
            .applyRemoteEvents(scoped);
      }
      setState(() {
        _loading = false;
        _error = null;
        _emptyRemote = events.isEmpty &&
            ref.read(subagentTimelineProvider(widget.agentId)).entries.isEmpty;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        if (initial) _error = '$e';
      });
    }
    _syncPolling();
  }

  void _syncPolling() {
    final running = _meta?.running ?? false;
    ref
        .read(subagentTimelineProvider(widget.agentId).notifier)
        .setEphemeralRunning(running);
    if (!running) {
      _poll?.cancel();
      _poll = null;
      return;
    }
    _poll ??= Timer.periodic(_pollInterval, (_) {
      if (!mounted) return;
      unawaited(_load());
    });
  }

  /// 底部按钮: 整页报告 ⇄ 完整过程 (替换本页, 返回键仍回父会话)
  void _switchView() {
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(
        builder: (_) => SubagentSessionPage(
          parentSessionId: widget.parentSessionId,
          agentId: widget.agentId,
          reportOnly: !widget.reportOnly,
          fallbackTitle: widget.fallbackTitle,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final meta = ref.watch(subagentsProvider(widget.parentSessionId)).where(
          (s) => s.agentId == widget.agentId,
        );
    final m = meta.isEmpty ? null : meta.first;
    /* 必须无条件 watch: subagentTimelineProvider 是 autoDispose, 只在 _body 里
     * 按条件 watch 的话, 加载期间没人订阅 → 控制器被回收, _load 灌进去的事件
     * 全丢, 窗口永远空白 (测试实锤)。这里订阅一次锁住整个窗口生命周期。 */
    final childSnap = ref.watch(subagentTimelineProvider(widget.agentId));
    /* 跑完了就停轮询 (build 里同步, 不用额外 listener) */
    if (m != null && !m.running && _poll != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _syncPolling();
      });
    }
    final running = m?.running ?? false;
    final fallback = widget.fallbackTitle?.trim() ?? '';
    final ready = !_loading && _error == null;
    return ClayPage(
      title: m?.displayName ?? (fallback.isNotEmpty ? fallback : tr('子任务')),
      onBack: () => Navigator.of(context).maybePop(),
      actions: [
        if (running)
          ClayButton(
            label: tr('停掉它'),
            size: ClayButtonSize.small,
            onTap: () => unawaited(
              _stopSubagent(context, ref, widget.parentSessionId, widget.agentId),
            ),
          ),
      ],
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (m != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 4, 24, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  ClayChip(
                    label: subagentStatusLine(m),
                    tone: running
                        ? ClayTone.cobalt
                        : (m.success ? ClayTone.green : ClayTone.red),
                    leading: running ? const ClaySpinner(size: 12) : null,
                  ),
                  if (m.task.trim().isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Text(
                      '${tr('它的任务：')}${m.task.trim()}',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 13, color: c.grey, height: 1.5),
                    ),
                  ],
                ],
              ),
            ),
          Expanded(child: _body(m, childSnap)),
        ],
      ),
      bottom: !ready
          ? null
          : Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                ClayButton(
                  label: widget.reportOnly ? tr('看完整过程') : tr('看完整报告'),
                  expand: true,
                  size: ClayButtonSize.large,
                  onTap: _switchView,
                ),
                if (running)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                      tr('只停它，主任务照常跑'),
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 12, color: c.grey),
                    ),
                  ),
              ],
            ),
    );
  }

  Widget _body(SubagentRef? m, TimelineSnapshot snap) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    if (_loading) {
      return const Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    if (_error != null) {
      return _Hint(
        icon: Icons.cloud_off_rounded,
        title: tr('拉不到这个子任务的时间轴'),
        detail: _error,
        action: TextButton(
          onPressed: () {
            setState(() {
              _loading = true;
              _error = null;
            });
            unawaited(_load(initial: true));
          },
          child: Text(tr('重试')),
        ),
      );
    }
    final entries = snap.entries
        .where((e) => e.kind != 'session_meta')
        .where((e) => !widget.reportOnly || e.kind == 'agent_text')
        .toList(growable: false);
    if (entries.isEmpty) {
      /* 手机本机 (agentsdk) 跑的子 agent 没有桌面子会话可查 —— 退回摘要视图,
       * 别给一个空白窗让人以为坏了。 */
      return _Hint(
        icon: _emptyRemote ? Icons.smart_toy_outlined : Icons.hourglass_empty,
        title: _emptyRemote ? tr('这个子任务没有独立时间轴') : tr('子任务还没产出内容'),
        detail: m?.summary?.trim().isNotEmpty == true
            ? m!.summary
            : (m?.task.trim().isNotEmpty == true ? m!.task : null),
      );
    }
    final items = groupToolEntries(entries);
    final showTyping = snap.agentRunning;
    final itemCount = items.length + (showTyping ? 1 : 0);
    return ListView.builder(
      reverse: true,
      padding: const EdgeInsets.symmetric(vertical: NeoxSpace.sm),
      itemCount: itemCount,
      itemBuilder: (context, i) {
        final idx = itemCount - 1 - i;
        if (idx >= items.length) {
          return Padding(
            padding: const EdgeInsets.fromLTRB(NeoxSpace.lg, 6, NeoxSpace.lg, 6),
            child: Text(
              tr('运行中…'),
              style: theme.textTheme.bodySmall?.copyWith(
                color: scheme.onSurfaceVariant,
                fontStyle: FontStyle.italic,
              ),
            ),
          );
        }
        final item = items[idx];
        return switch (item) {
          SingleRenderItem(:final entry) => MessageRow.fromEntry(
              entry,
              sessionId: widget.agentId,
            ),
          ToolGroupRenderItem() => ToolGroupRow(
              group: item,
              sessionId: widget.agentId,
            ),
          /* 子任务页走旧的连续工具成组, 不会产出这两种 */
          ProcessRenderItem() || FilesFooterRenderItem() => const SizedBox.shrink(),
        };
      },
    );
  }
}

/// "Explore · 运行中 12s · grep" / "claude · 完成 27.2s" 这样的一行状态.
String subagentStatusLine(SubagentRef? m) {
  if (m == null) return '';
  final now = DateTime.now().millisecondsSinceEpoch;
  final parts = <String>[m.role];
  if (m.running) {
    parts.add(tr('运行中 ${formatElapsed(m.elapsed(now))}'));
    if (m.live != null) parts.add(m.live!);
  } else {
    /* 耗时只在桌面给了真值时显示 — 手机自己时间戳相减是假数, 宁可不显示 */
    parts.add(
      m.durationMs != null
          ? '${m.success ? '完成' : '失败'} ${formatElapsed(m.elapsed(now))}'
          : (m.success ? tr('完成') : tr('失败')),
    );
  }
  if (m.isBackground) parts.add(tr('后台'));
  return parts.join(' · ');
}

String formatElapsed(Duration d) {
  final s = d.inMilliseconds / 1000;
  if (s < 60) return '${s.toStringAsFixed(s < 10 ? 1 : 0)}s';
  final m = d.inMinutes;
  final rem = d.inSeconds % 60;
  return '${m}m${rem.toString().padLeft(2, '0')}s';
}

class _Hint extends StatelessWidget {
  const _Hint({
    required this.icon,
    required this.title,
    this.detail,
    this.action,
  });

  final IconData icon;
  final String title;
  final String? detail;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(NeoxSpace.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 26, color: scheme.onSurfaceVariant),
            const SizedBox(height: NeoxSpace.md),
            Text(
              title,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            ),
            if (detail != null && detail!.trim().isNotEmpty) ...[
              const SizedBox(height: NeoxSpace.sm),
              Text(
                detail!.trim(),
                textAlign: TextAlign.center,
                maxLines: 8,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: scheme.hintInk,
                ),
              ),
            ],
            if (action != null) ...[
              const SizedBox(height: NeoxSpace.sm),
              action!,
            ],
          ],
        ),
      ),
    );
  }
}

/// 只保留**本次派活**的那一段子会话历史.
///
/// 桌面的 agentId 是父会话内的 `Agent-N` 计数器, 跨轮次会被**复用**:
/// 第二次 dispatch 拿到同一个 `Agent-2`, `createSession({sessionId: agentId})`
/// 命中已存在的子会话, 于是新一轮的消息**追加**在上一轮后面。整段渲染出来就是
/// 用户点开 "audit backend" 却先看到上一次 "scan docs" 的输出 (2026-07-29 真机实锤)。
///
/// 子会话每次派活都会 seed 一条 user message = 本次 prompt, 所以从**最后一条
/// user_message** 起算就是本次任务的完整片段 —— 不依赖两端时钟一致。
/// 这是展示层的止损; 根治要桌面给每次 dispatch 分配唯一 agentId。
List<SessionEvent> currentDispatchOnly(List<SessionEvent> events) {
  var start = -1;
  for (var i = events.length - 1; i >= 0; i--) {
    if (events[i].kind == 'user_message') {
      start = i;
      break;
    }
  }
  return start <= 0 ? events : events.sublist(start);
}
