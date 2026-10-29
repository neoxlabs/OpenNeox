/// agent_activity_rows.dart — v1.1 timeline 对齐桌面的新渲染件.
///
/// 收:
///   - PlanCard          计划卡 (pinned 在消息列表顶部, 折叠默认只显进度行)
///   - SubagentBlock     子代理行 (spinner→check, 点开显任务/摘要)
///   - CompactionDivider 上下文压缩标记 (分隔线式)
///   - CheckpointDivider checkpoint 标记
///   - RetryPill         LLM 流重试中提示 (贴输入框上方)
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/ws_client_provider.dart';
import '../../../shared/clay/clay.dart';
import '../../../shared/theme/neox_tokens.dart';
import '../state/timeline_state.dart';
import 'common.dart' show DividerLine;
import 'subagent_page.dart';
import 'shimmer_text.dart';
import 'package:neox_app/core/i18n/tr.dart';

// ────────────────────────────────────────────────────────────────
//  PlanCard — pinned 计划卡
// ────────────────────────────────────────────────────────────────
class PlanCard extends StatefulWidget {
  const PlanCard({super.key, required this.plan});
  final PlanCardState plan;

  @override
  State<PlanCard> createState() => _PlanCardState();
}

class _PlanCardState extends State<PlanCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final plan = widget.plan;
    final total = plan.steps.length;
    final done = plan.completedCount;
    final allDone = total > 0 && done == total;

    /* 当前进行中的步骤 — 折叠态显示它, 让用户不点开也知道 agent 在哪一步 */
    PlanStepState? current;
    for (final s in plan.steps) {
      if (s.status == 'in_progress') {
        current = s;
        break;
      }
    }
    current ??= plan.steps.cast<PlanStepState?>().firstWhere(
          (s) => s!.status != 'completed',
          orElse: () => null,
        );

    return Padding(
      padding: const EdgeInsets.fromLTRB(
        NeoxSpace.lg,
        NeoxSpace.sm,
        NeoxSpace.lg,
        NeoxSpace.xs,
      ),
      child: Container(
        decoration: BoxDecoration(
          color: scheme.surfaceContainerHigh.withValues(alpha: 0.7),
          borderRadius: BorderRadius.circular(NeoxRadius.input),
          border: Border.all(color: scheme.outline, width: NeoxStroke.hair),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            InkWell(
              borderRadius: BorderRadius.circular(NeoxRadius.input),
              onTap: () => setState(() => _expanded = !_expanded),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: NeoxSpace.md,
                  vertical: NeoxSpace.sm + 1,
                ),
                child: Row(
                  children: [
                    Icon(
                      allDone
                          ? Icons.check_circle_outline
                          : Icons.checklist_rounded,
                      size: 15,
                      color: allDone ? scheme.primary : scheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: NeoxSpace.sm),
                    Text(
                      tr('计划 $done/$total'),
                      style: theme.textTheme.labelMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                        color: scheme.onSurface,
                      ),
                    ),
                    const SizedBox(width: NeoxSpace.sm),
                    if (!_expanded && !allDone && current != null)
                      Expanded(
                        child: Text(
                          current.step,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.labelSmall?.copyWith(
                            color: scheme.onSurfaceVariant,
                          ),
                        ),
                      )
                    else
                      const Spacer(),
                    Icon(
                      _expanded ? Icons.expand_less : Icons.expand_more,
                      size: 16,
                      color: scheme.onSurfaceVariant,
                    ),
                  ],
                ),
              ),
            ),
            if (_expanded)
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  NeoxSpace.md,
                  0,
                  NeoxSpace.md,
                  NeoxSpace.sm + 2,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (final s in plan.steps) _PlanStepRow(step: s),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _PlanStepRow extends StatelessWidget {
  const _PlanStepRow({required this.step});
  final PlanStepState step;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final done = step.status == 'completed';
    final active = step.status == 'in_progress';

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 1.5),
            child: done
                ? Icon(Icons.check_circle, size: 14, color: scheme.primary)
                : active
                    ? SizedBox(
                        width: 14,
                        height: 14,
                        child: Padding(
                          padding: const EdgeInsets.all(1.5),
                          child: CircularProgressIndicator(
                            strokeWidth: 1.6,
                            color: scheme.primary,
                          ),
                        ),
                      )
                    : Icon(
                        Icons.circle_outlined,
                        size: 14,
                        color: scheme.hintInk,
                      ),
          ),
          const SizedBox(width: NeoxSpace.sm),
          Expanded(
            child: Text(
              step.step,
              style: theme.textTheme.bodySmall?.copyWith(
                fontSize: 14,
                height: 1.35,
                color: done
                    ? scheme.onSurfaceVariant.withValues(alpha: 0.7)
                    : scheme.onSurface,
                decoration: done ? TextDecoration.lineThrough : null,
                decorationColor: scheme.onSurfaceVariant.withValues(alpha: 0.5),
                fontWeight: active ? FontWeight.w600 : FontWeight.w400,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ────────────────────────────────────────────────────────────────
//  SubagentBlock — 子 agent 在主 timeline 上的痕迹
//
//  设计 (明康拍板 2026-07-28): 主 timeline 只留一条**无边框、缩进、与正文
//  垂直基线对齐**的痕迹 — 不再是带框方块, 不跟正文抢视觉重心。
//
//  两种 worker 的交互不同 (明康 2026-07-29 指出, 二者语义本就不一样):
//    · agentTool 派的真子 agent (is_agent_tool=true) — agentId 就是子会话 id,
//      点开悬浮窗看它的真实时间轴 (跑着的 / 跑完的都能点);
//    · Explore / 并行探索 (is_agent_tool=false) — 主 agent 的一次工具调用,
//      桌面从不给它建会话, 点开只能展开看摘要, 不给"打开会话"的假承诺。
//  老桌面不带这个字段 (null) → 按"可能有会话"处理, 拉空时悬浮窗自己降级。
// ────────────────────────────────────────────────────────────────
class SubagentBlock extends ConsumerStatefulWidget {
  const SubagentBlock({super.key, required this.entry, this.sessionId});
  final TimelineEntry entry;

  /// 父会话 id — 打开悬浮窗要用. null 时降级成不可点的静态痕迹.
  final String? sessionId;

  @override
  ConsumerState<SubagentBlock> createState() => _SubagentBlockState();
}

class _SubagentBlockState extends ConsumerState<SubagentBlock> {
  /// Explore 类痕迹的展开态 (真子 agent 走悬浮窗, 不用这个).
  bool _expanded = false;

  bool _isExploreRole(String role) {
    final r = role.toLowerCase();
    return r == 'explore' ||
        r.startsWith('explor') ||
        r.contains('explore') ||
        r == 'task' ||
        r.contains('explorer');
  }

  @override
  Widget build(BuildContext context) {
    final e = widget.entry;
    final running = e.pending;
    final failed = !running && !e.toolSuccess;
    final role = e.toolName ?? 'agent';
    final task = (e.text ?? '').trim();
    final live = (e.args?['live'] as String?)?.trim() ?? '';
    final isBackground = e.args?['is_background'] == true;
    final durationMs = e.args?['duration_ms'];
    final agentId = (e.args?['agent_id'] as String?) ?? '';
    final isExplore = _isExploreRole(role);

    /* 右侧尾注: 跑着显在跑的工具名, 跑完显桌面给的真实耗时 (没有就不显 —
     * 手机自己时间戳相减是假数, 宁可留白). */
    final String trailing = running
        ? live
        : (durationMs is int && durationMs > 0
            ? _fmtDuration(durationMs)
            : '');

    final label = task.isNotEmpty ? task : role;
    /* is_agent_tool == false 明确表示"没有子会话" → 不给可点开的箭头 */
    final hasSession = e.args?['is_agent_tool'] != false;
    final canOpen =
        widget.sessionId != null && agentId.isNotEmpty && hasSession;
    final summary = (e.output ?? '').trim();
    final canExpand = !canOpen && summary.isNotEmpty;

    /* 陶土稿 v5: 子任务 = 一块小泥板 —— 陶土方块图标 + 任务名 + 状态签 (进行中 / 用时 / 失败)。
     * 单击: 能开子会话的进子任务页, 否则展开摘要; 长按出菜单 (明康 2026-07-29 定的交互)。 */
    final c = ClayInk.of(context);
    void openMenu() => showSubagentActionMenu(
          context,
          ref,
          parentSessionId: widget.sessionId!,
          agentId: agentId,
          summary: summary,
          title: label,
          running: running,
        );
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 4, 16, 4),
      child: ClaySlab(
        radius: 14,
        padding: const EdgeInsets.fromLTRB(10, 9, 10, 9),
        onTap: canExpand ? () => setState(() => _expanded = !_expanded) : (canOpen ? openMenu : null),
        onLongPress: canOpen ? openMenu : null,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                ClayTile(
                  icon: isExplore ? Icons.travel_explore : Icons.smart_toy_outlined,
                  size: 28,
                  bead: running ? c.cobalt : (failed ? c.red : null),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    isBackground ? tr('$label · 后台') : label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500, color: c.ink),
                  ),
                ),
                const SizedBox(width: 8),
                if (running)
                  ClayChip(label: live.isEmpty ? tr('进行中') : live, tone: ClayTone.cobalt, dense: true)
                else if (failed)
                  ClayChip(label: tr('失败'), tone: ClayTone.red, dense: true)
                else if (trailing.isNotEmpty)
                  Text(trailing, style: TextStyle(fontSize: 12, color: c.grey)),
                if (canExpand || canOpen) Icon(_expanded ? Icons.expand_less_rounded : Icons.chevron_right_rounded, size: 18, color: c.faint),
              ],
            ),
            if (_expanded && summary.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(38, 8, 4, 2),
                child: Text(
                  summary,
                  maxLines: 12,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 13, height: 1.4, color: c.grey),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

String _fmtDuration(int ms) {
  final s = ms / 1000;
  if (s < 60) return '${s.toStringAsFixed(s < 10 ? 1 : 0)}s';
  final m = ms ~/ 60000;
  final rem = (ms % 60000) ~/ 1000;
  return '${m}m${rem.toString().padLeft(2, '0')}s';
}

// ────────────────────────────────────────────────────────────────
//  CompactionDivider / CheckpointDivider — 轻量标记行
// ────────────────────────────────────────────────────────────────
class CompactionDivider extends StatelessWidget {
  const CompactionDivider({super.key, required this.entry});
  final TimelineEntry entry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final orig = _asInt(entry.args?['original_tokens']);
    final fin = _asInt(entry.args?['final_tokens']);
    final saved = (orig > 0 && fin > 0 && orig > fin) ? orig - fin : 0;
    final mute = scheme.onSurfaceVariant;
    /* 进行中: 压缩是几十秒的 LLM 调用, 点完必须立刻有东西出现, 否则用户不知道
     * 发生了什么 (明康 2026-07-29)。标题走 shimmer, 数字这时还不存在, 不编。 */
    final running = entry.pending;

    /* 陶土稿 v5: 居中一句淡字「已压缩 · 7.5k → 6.6k」, 两边细线; 跑着时是转圈 +「正在压缩…」。
     * 没拿到 token 数时只留标题, 不编数字。 */
    final c = ClayInk.of(context);
    Widget rail() => Expanded(child: Container(height: 0.6, color: c.line));

    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
      child: Row(
        children: [
          rail(),
          const SizedBox(width: 10),
          if (running) ...[const ClaySpinner(size: 11), const SizedBox(width: 6)],
          Flexible(
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                ShimmerText(
                  running ? tr('正在压缩…') : tr('已压缩'),
                  active: running,
                  style: TextStyle(fontSize: 12, color: c.grey, fontWeight: FontWeight.w500),
                ),
                if (running && (entry.args?['message'] as String?)
                        ?.trim()
                        .isNotEmpty ==
                    true) ...[
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      (entry.args!['message'] as String).trim(),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: mute.withValues(alpha: 0.8),
                      ),
                    ),
                  ),
                ],
                if (!running && saved > 0)
                  Flexible(
                    child: Text(
                      ' · ${_fmtTokens(orig)} → ${_fmtTokens(fin)}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12, color: c.grey),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          rail(),
        ],
      ),
    );
  }
}

class CheckpointDivider extends ConsumerWidget {
  const CheckpointDivider({
    super.key,
    required this.entry,
    required this.sessionId,
  });
  final TimelineEntry entry;
  final String sessionId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auto = entry.args?['auto'] == true;
    final cid = (entry.args?['checkpoint_id'] as String?) ?? '';
    final label = auto ? tr('自动存档点') : tr('存档点');
    /* 自动存档点每条消息后面都有一个, 原来每个都是一整行「自动存档点 · 长按回滚」,
     * 聊三句就三道分隔线 (2026-09-30 真机截图)。现在只留右边一个淡淡的小图标, 长按照样能回滚;
     * 用户手动打的存档点是他自己要的, 仍然整行显示。 */
    if (auto) {
      if (cid.isEmpty) return const SizedBox.shrink();
      final mute = Theme.of(context).colorScheme.onSurfaceVariant.withValues(alpha: 0.45);
      return GestureDetector(
        behavior: HitTestBehavior.opaque,
        onLongPress: () => _confirmRollback(context, ref, cid),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 18, 0),
          child: Align(
            alignment: Alignment.centerRight,
            child: Tooltip(
              message: tr('$label · 长按回滚'),
              child: Icon(Icons.history, size: 13, color: mute),
            ),
          ),
        ),
      );
    }
    if (cid.isEmpty) return DividerLine(text: label);
    /* 可回滚 — 长按弹确认 (误触成本高, 不给单击) */
    return GestureDetector(
      onLongPress: () => _confirmRollback(context, ref, cid),
      child: DividerLine(text: tr('$label · 长按回滚')),
    );
  }

  Future<void> _confirmRollback(
    BuildContext context,
    WidgetRef ref,
    String checkpointId,
  ) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(tr('回滚到这个存档点?')),
        content: Text(tr('此后的对话和改动将被撤销，无法恢复。')),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(tr('取消')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(tr('回滚')),
          ),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    try {
      await ref
          .read(wsClientProvider.notifier)
          .rollbackToCheckpoint(sessionId, checkpointId);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(tr('已回滚，正在刷新会话'))),
        );
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(tr('回滚失败: $e'))),
        );
      }
    }
  }
}

int _asInt(dynamic v) {
  if (v is int) return v;
  if (v is num) return v.toInt();
  return 0;
}

String _fmtTokens(int n) {
  if (n >= 1000) {
    final k = n / 1000;
    return k >= 10 ? '${k.round()}k' : '${k.toStringAsFixed(1)}k';
  }
  return '$n';
}

// ────────────────────────────────────────────────────────────────
//  RetryPill — LLM 流重试提示 (贴输入框上方)
// ────────────────────────────────────────────────────────────────
class RetryPill extends StatelessWidget {
  const RetryPill({super.key, required this.retry});
  final RetryPillState retry;

  @override
  Widget build(BuildContext context) {
    final label = switch (retry.kindLabel) {
      'rate_limit' => tr('模型限流'),
      'timeout' => tr('响应超时'),
      'network' => tr('网络波动'),
      _ => tr('连接波动'),
    };
    final progress = retry.maxRetries > 0
        ? tr(' · 第 ${retry.attempt}/${retry.maxRetries} 次重试')
        : tr(' · 重试中');
    final c = ClayInk.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 2, 20, 4),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
            decoration: BoxDecoration(color: c.amberSoft, borderRadius: BorderRadius.circular(999)),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                ClaySpinner(size: 10, color: c.amberInk),
                const SizedBox(width: 7),
                Text('$label$progress', style: TextStyle(fontSize: 12, color: c.amberInk, fontWeight: FontWeight.w500)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
