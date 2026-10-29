/// neox_badge.dart — 小型标签 / 状态点.
///
/// NeoxBadge: 胶囊形小标签, 用于 "Free" "Pro" "新" "已连接" 等.
/// NeoxStatusDot: 小圆点, 用于在线/离线/忙碌 等状态指示.
library;

import 'package:flutter/material.dart';

import '../theme/neox_tokens.dart';

enum NeoxBadgeStyle {
  /// 实色填充 (如黑底白字 Free 标签)
  solid,

  /// 软填充 (浅底色字, 如 chip 类标签)
  soft,

  /// 轮廓 (透明底带边框)
  outline,
}

class NeoxBadge extends StatelessWidget {
  const NeoxBadge({
    super.key,
    required this.label,
    this.color,
    this.style = NeoxBadgeStyle.solid,
    this.icon,
    this.compact = false,
  });

  final String label;
  final Color? color;
  final NeoxBadgeStyle style;
  final IconData? icon;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final accent = color ?? scheme.onSurface;

    final (bg, fg, border) = switch (style) {
      NeoxBadgeStyle.solid => (accent, _onColor(accent), null),
      NeoxBadgeStyle.soft => (
        accent.withValues(alpha: 0.12),
        accent,
        null,
      ),
      NeoxBadgeStyle.outline => (
        Colors.transparent,
        accent,
        Border.all(color: accent.withValues(alpha: 0.4), width: NeoxStroke.hair),
      ),
    };

    final hPad = compact ? NeoxSpace.sm : NeoxSpace.md;
    final vPad = compact ? 2.0 : 4.0;
    final fontSize = compact ? 10.5 : 11.5;

    return Container(
      padding: EdgeInsets.symmetric(horizontal: hPad, vertical: vPad),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: NeoxRadius.pillR,
        border: border,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 11, color: fg),
            const SizedBox(width: 4),
          ],
          Text(
            label,
            style: theme.textTheme.labelSmall?.copyWith(
              fontSize: fontSize,
              color: fg,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.2,
              height: 1.1,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }

  /// 给定背景色, 估算合适的前景文字色 (luminance 简化判断)
  Color _onColor(Color bg) =>
      bg.computeLuminance() > 0.5 ? const Color(0xFF1A1814) : Colors.white;
}

class NeoxStatusDot extends StatelessWidget {
  const NeoxStatusDot({
    super.key,
    required this.color,
    this.size = 8,
    this.pulse = false,
  });

  final Color color;
  final double size;
  final bool pulse;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: color,
        shape: BoxShape.circle,
        boxShadow: pulse
            ? [
                BoxShadow(
                  color: color.withValues(alpha: 0.4),
                  blurRadius: 6,
                  spreadRadius: 1,
                ),
              ]
            : null,
      ),
    );
  }
}
