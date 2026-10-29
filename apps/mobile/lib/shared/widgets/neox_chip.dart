/// neox_chip.dart — composer / top-strip 共享 chip.
///
/// 设计准则:
///   - 高 26 / 圆角 6 / 内边距 8×4
///   - 默认 outline 风, 选中态 fill primary 浅色
///   - icon 12, label 11.5
///   - 可选 trailing (▼ 或数字 badge)
///   - 整体 click 打开 popup / sheet
library;

import 'package:flutter/material.dart';

import '../../shared/theme/neox_tokens.dart';

class NeoxChip extends StatelessWidget {
  const NeoxChip({
    super.key,
    this.icon,
    required this.label,
    this.trailing,
    this.color,
    this.selected = false,
    this.onTap,
    this.compact = false,
    this.mono = false,
    this.ghost = false,
  });

  final IconData? icon;
  final String label;

  /// 右侧可选小元素 — 通常是箭头 / 数字 / 第二段文字
  final Widget? trailing;

  /// 显式颜色 — 不传走 onSurfaceVariant (默认中性).
  final Color? color;

  /// 选中态 — fill primary 浅色 + 边框加深
  final bool selected;

  final VoidCallback? onTap;

  /// 更紧凑模式 (用于 toolbar 区域, 高 22)
  final bool compact;

  /// 标签用等宽字体 (model id 这种)
  final bool mono;

  /// ghost 模式 — 无边框 / 无填充, 只有 icon + 文字, 用于密集工具栏内嵌
  final bool ghost;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final base = color ?? theme.colorScheme.onSurfaceVariant;
    final fg = selected ? theme.colorScheme.primary : base;
    final outline = theme.colorScheme.outlineVariant;
    final borderColor = ghost
        ? Colors.transparent
        : (selected
            ? theme.colorScheme.primary.withValues(alpha: 0.5)
            : outline.withValues(alpha: 0.7));
    final fill = ghost
        ? Colors.transparent
        : (selected
            ? theme.colorScheme.primary.withValues(alpha: 0.08)
            : Colors.transparent);

    final padH = compact ? 7.0 : 8.0;
    final padV = compact ? 3.0 : 4.0;
    final iconSize = 12.0;
    final fontSize = compact ? 11.0 : 11.5;
    final gap = 5.0;

    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: NeoxRadius.smallR,
        onTap: onTap,
        child: Container(
          padding: EdgeInsets.symmetric(horizontal: padH, vertical: padV),
          decoration: BoxDecoration(
            color: fill,
            borderRadius: NeoxRadius.smallR,
            border: Border.all(color: borderColor, width: 0.6),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon != null) ...[
                Icon(icon, size: iconSize, color: fg),
                SizedBox(width: gap),
              ],
              Flexible(
                child: Text(
                  label,
                  style: TextStyle(
                    fontSize: fontSize,
                    color: fg,
                    fontWeight: FontWeight.w500,
                    fontFamily: mono ? 'monospace' : null,
                    letterSpacing: 0.1,
                    height: 1.1,
                  ),
                  overflow: TextOverflow.ellipsis,
                  maxLines: 1,
                ),
              ),
              if (trailing != null) ...[
                const SizedBox(width: 4),
                DefaultTextStyle.merge(
                  style: TextStyle(
                    fontSize: fontSize - 0.5,
                    color: fg.withValues(alpha: 0.8),
                  ),
                  child: IconTheme.merge(
                    data: IconThemeData(size: iconSize, color: fg.withValues(alpha: 0.8)),
                    child: trailing!,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
