/// status_badge.dart — 工具运行 / 完成 / 失败 / 等待 的统一状态 pill.
///
/// 跟 Desktop `.atl-tool.is-{running,done,failed,awaiting,pending}` 视觉对齐.
/// 在 ToolBlock 和 StreamingToolPill 两处复用, 保证视觉一致.
library;

import 'package:flutter/material.dart';

import '../../../shared/theme/neox_tokens.dart';

enum StepStatus { running, done, failed, awaiting, pending }

extension StepStatusUI on StepStatus {
  Color color(BuildContext ctx) {
    final theme = Theme.of(ctx);
    switch (this) {
      /* 语义色走主题 (2026-09-18): Material 的 shadeN 深浅主题同一个值 ——
       * #F57C00 / #388E3C 在近黑底上对比只有 3.x, 而这两个颜色正是"跑着 / 成了"
       * 的唯一区分。见 NeoxControlColors 的语义色那一段。 */
      case StepStatus.running:
        return theme.colorScheme.warnInk;
      case StepStatus.done:
        return theme.colorScheme.okInk;
      case StepStatus.failed:
        return theme.colorScheme.error;
      case StepStatus.awaiting:
        return theme.colorScheme.primary;
      case StepStatus.pending:
        return theme.colorScheme.onSurfaceVariant;
    }
  }

  String get label {
    switch (this) {
      case StepStatus.running:
        return 'running';
      case StepStatus.done:
        return 'done';
      case StepStatus.failed:
        return 'error';
      case StepStatus.awaiting:
        return 'awaiting';
      case StepStatus.pending:
        return 'pending';
    }
  }

  bool get isAnimated =>
      this == StepStatus.running || this == StepStatus.awaiting;
}

class StatusBadge extends StatelessWidget {
  const StatusBadge({super.key, required this.status, this.compact = false});
  final StepStatus status;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final color = status.color(context);
    return Container(
      padding: EdgeInsets.symmetric(
        horizontal: compact ? 5 : 6,
        vertical: compact ? 1 : 2,
      ),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: NeoxRadius.barR,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (status.isAnimated) ...[
            SizedBox(
              width: 8,
              height: 8,
              child: CircularProgressIndicator(strokeWidth: 1.2, color: color),
            ),
            const SizedBox(width: 4),
          ],
          Text(
            status.label,
            style: TextStyle(
              color: color,
              fontSize: compact ? 9.5 : 10,
              fontWeight: FontWeight.w700,
              fontFamily: NeoxMono.family,
              fontFamilyFallback: NeoxMono.fallback,
              letterSpacing: 0.4,
            ),
          ),
        ],
      ),
    );
  }
}
