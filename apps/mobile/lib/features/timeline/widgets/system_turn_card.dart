/// system_turn_card.dart — 系统注入 turn 的折叠卡.
///
/// 取代"把 `<agent-completion>` 整段 XML 当 user 气泡铺开"的旧行为 (真机上会露出
/// `</summary></agent-completion>` 这种内部标签, 且把子 agent 的完整报告灌进主
/// timeline —— 桌面同一会话没有这一段)。
///
/// 视觉上刻意做轻: 这不是用户说的话, 也不是 agent 的正文, 只是"某个后台任务回来了"
/// 的一条系统事件。默认折叠, 点开才看摘要。
///
/// 子 agent 完成卡还是**回看子会话的持久入口**: `subagent_started` 是 streaming
/// 事件不落 drift, app 重启后主 timeline 上那条痕迹就没了; 而这张卡是 user turn
/// 落过库的, 且 `<agent-id>` 就是子会话 id —— 右侧给一个"进子会话"按钮,
/// 隔天回来照样点得进去 (2026-07-29)。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/theme/neox_tokens.dart';
import '../models/system_injected_turn.dart';
import 'markdown_view.dart';
import 'subagent_page.dart';
import 'timeline_row.dart';
import 'package:neox_app/core/i18n/tr.dart';

class SystemTurnCard extends ConsumerStatefulWidget {
  const SystemTurnCard({super.key, required this.turn, this.sessionId});

  final SystemInjectedTurn turn;

  /// 父会话 id — 有它 + agent-id 才能进子会话页.
  final String? sessionId;

  @override
  ConsumerState<SystemTurnCard> createState() => _SystemTurnCardState();
}

class _SystemTurnCardState extends ConsumerState<SystemTurnCard> {
  bool _open = false;

  (IconData, String) _head() {
    final t = widget.turn;
    switch (t.kind) {
      case SystemTurnKind.agentCompletion:
        final name = t.name ?? t.agentId ?? tr('子 Agent');
        final bits = <String>[
          if (t.elapsedSeconds != null) '${t.elapsedSeconds}s',
          if (t.toolUseCount != null && t.toolUseCount! > 0)
            tr('${t.toolUseCount} 次工具'),
        ];
        final tail = bits.isEmpty ? '' : ' · ${bits.join(' · ')}';
        return (
          t.isFailed ? Icons.error_outline : Icons.smart_toy_outlined,
          '$name ${t.isFailed ? '失败' : '完成'}$tail',
        );
      case SystemTurnKind.backgroundTask:
        final taskName = t.name ?? tr('后台任务');
        return (Icons.task_alt_outlined, tr('$taskName 完成'));
      case SystemTurnKind.scheduledWakeup:
        return (Icons.schedule_outlined, t.name ?? tr('定时唤醒'));
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    final (icon, title) = _head();
    final summary = widget.turn.summary?.trim() ?? '';
    final residual = widget.turn.residual.trim();
    final expandable = summary.isNotEmpty;
    final preview = reportPreview(summary);
    final childId = widget.turn.agentId?.trim() ?? '';
    final canOpenSession =
        widget.turn.kind == SystemTurnKind.agentCompletion &&
            childId.isNotEmpty &&
            widget.sessionId != null;

    return Padding(
      padding: const EdgeInsets.fromLTRB(NeoxIndent.gutter, 2, 6, 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          /* 单击展开摘要, 长按出菜单 (进子会话 / 看完整报告) —— 跟主 timeline 上的
           * 子 agent 痕迹同一套交互, 免得同一件事两种点法。 */
          TimelineRow(
            verticalPadding: 6,
            onTap: expandable ? () => setState(() => _open = !_open) : null,
            onLongPress: canOpenSession
                ? () => showSubagentActionMenu(
                      context,
                      ref,
                      parentSessionId: widget.sessionId!,
                      agentId: childId,
                      title: widget.turn.name ?? childId,
                      summary: summary,
                      /* 完成卡本身就代表"已结束", 不给停止项 */
                      running: false,
                    )
                : null,
            icon: Icon(
              icon,
              size: 15,
              color: widget.turn.isFailed ? NeoxClaudePalette.danger : mute,
            ),
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (canOpenSession)
                  Icon(
                    Icons.more_horiz_rounded,
                    size: 15,
                    color: mute.withValues(alpha: 0.55),
                  ),
                if (expandable)
                  Icon(
                    _open ? Icons.expand_less : Icons.expand_more,
                    size: 16,
                    color: mute,
                  ),
              ],
            ),
            child: Text(
              title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(color: mute),
            ),
          ),
          if (_open && summary.isNotEmpty)
            TimelineRowBody(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  MarkdownView(data: preview.text, muted: true),
                  if (preview.truncated)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Row(
                        children: [
                          Text(
                            tr('报告较长, 已截断'),
                            style: theme.textTheme.labelSmall?.copyWith(
                              color: mute.withValues(alpha: 0.7),
                            ),
                          ),
                          if (canOpenSession) ...[
                            const SizedBox(width: NeoxSpace.sm),
                            InkWell(
                              onTap: () => openSubagentSession(
                                context,
                                parentSessionId: widget.sessionId!,
                                agentId: childId,
                                reportOnly: true,
                                fallbackTitle: widget.turn.name ?? childId,
                              ),
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 4,
                                  vertical: 2,
                                ),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Text(
                                      tr('看完整报告'),
                                      style: theme.textTheme.labelSmall
                                          ?.copyWith(
                                        color: theme.colorScheme.primary,
                                        fontWeight: FontWeight.w600,
                                      ),
                                    ),
                                    Icon(
                                      Icons.chevron_right_rounded,
                                      size: 14,
                                      color: theme.colorScheme.primary,
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                ],
              ),
            ),
          /* XML 之外用户真写的内容 (罕见) 照常显示, 不能吞 */
          if (residual.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: MarkdownView(data: residual),
            ),
        ],
      ),
    );
  }
}

/// 完成卡展开时给的**预览**, 不是全文.
///
/// 子 agent 的 `<summary>` 常是"过程叙述 + 结构化报告"拼在一起:
///   「331 个 SQL 文件, 量很大。我先梳理目录结构, 再分批读取…」(碎碎念)
///   「# SQL 文件审计报告 …」+ 一堆表格 (真正的产出)
/// 整段铺进主 timeline 又长又混 (2026-07-29 明康: "完成后的内部显示需要优化")。
///
/// 两步处理:
///   1. 有 markdown 标题就从**第一个标题**起 —— 标题前那段基本都是过程铺垫;
///   2. 再按行截到 [maxChars], 且**不在表格中间断开** (半截表格渲染出来更难看)。
({String text, bool truncated}) reportPreview(
  String summary, {
  int maxChars = 600,
}) {
  var src = summary.trim();
  if (src.isEmpty) return (text: '', truncated: false);

  final lines = src.split('\n');
  final headingIdx = lines.indexWhere(
    (l) => RegExp(r'^\s{0,3}#{1,6}\s+\S').hasMatch(l),
  );
  /* 标题之前有实质内容才认为是"过程铺垫"; 标题就在开头则原样 */
  if (headingIdx > 0) {
    final lead = lines.take(headingIdx).join('\n').trim();
    if (lead.length > 60) src = lines.skip(headingIdx).join('\n').trim();
  }

  if (src.length <= maxChars) return (text: src, truncated: false);

  final out = <String>[];
  var used = 0;
  var truncated = false;
  for (final line in src.split('\n')) {
    if (used + line.length > maxChars) {
      truncated = true;
      break;
    }
    out.add(line);
    used += line.length + 1;
  }
  /* 收尾落在表格里 → 回退到表格开始前, 不留半截表 */
  while (out.isNotEmpty && out.last.trimLeft().startsWith('|')) {
    out.removeLast();
    truncated = true;
  }
  if (out.isEmpty) {
    return (text: src.substring(0, maxChars), truncated: true);
  }
  return (text: out.join('\n').trimRight(), truncated: truncated);
}
