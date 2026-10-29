/// neox_section.dart — 全 app 一致的小写 section header.
/// "RECENT" / "DESKTOPS" / "ABOUT" 等 group label 统一这一种.
library;

import 'package:flutter/material.dart';

class NeoxSectionLabel extends StatelessWidget {
  const NeoxSectionLabel({
    super.key,
    required this.text,
    this.padding = const EdgeInsets.fromLTRB(20, 16, 20, 8),
    this.trailing,
  });

  final String text;
  final EdgeInsetsGeometry padding;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: padding,
      child: Row(
        children: [
          Text(
            text,
            style: theme.textTheme.labelSmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
              letterSpacing: 1.4,
              fontSize: 12,
              fontWeight: FontWeight.w700,
            ),
          ),
          if (trailing != null) ...[
            const Spacer(),
            trailing!,
          ],
        ],
      ),
    );
  }
}

/// 设置页 / 通用 row — leading icon + title + subtitle + trailing.
/// 跟 ListTile 类似但更紧凑 + 跟 Neox 风格一致.
class NeoxListRow extends StatelessWidget {
  const NeoxListRow({
    super.key,
    required this.title,
    this.subtitle,
    this.leading,
    this.trailing,
    this.onTap,
    this.onLongPress,
    this.danger = false,
  });

  final String title;
  final String? subtitle;
  final Widget? leading;
  final Widget? trailing;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    final fg = danger ? theme.colorScheme.error : theme.colorScheme.onSurface;
    return InkWell(
      onTap: onTap,
      onLongPress: onLongPress,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
        child: Row(
          children: [
            if (leading != null) ...[
              SizedBox(
                width: 20,
                child: IconTheme(
                  data: IconThemeData(size: 18, color: fg),
                  child: leading!,
                ),
              ),
              const SizedBox(width: 14),
            ],
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: theme.textTheme.bodyMedium?.copyWith(color: fg),
                  ),
                  if (subtitle != null && subtitle!.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      subtitle!,
                      style: theme.textTheme.bodySmall?.copyWith(color: mute),
                    ),
                  ],
                ],
              ),
            ),
            if (trailing != null) ...[
              const SizedBox(width: 12),
              trailing!,
            ],
          ],
        ),
      ),
    );
  }
}
