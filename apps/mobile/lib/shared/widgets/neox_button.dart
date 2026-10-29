/// neox_button.dart — Claude 风按钮原子.
///
/// 三种 variant:
///   - primary  : 近黑胶囊 (主 CTA, 如 "升级" "确认")
///   - secondary: outline 胶囊 (次要操作, 如 "取消" "稍后")
///   - ghost    : 纯文字 (link 类操作, 如 "查看详情")
///   - danger   : 红色填充胶囊 (危险操作, 如 "删除" "退出账号")
///
/// 都自动适配 light/dark, 都自带 loading / disabled 态.
library;

import 'package:flutter/material.dart';

import '../theme/neox_tokens.dart';

enum NeoxButtonVariant { primary, secondary, ghost, danger }

enum NeoxButtonSize {
  /// 高 36, 横向小操作
  small,

  /// 高 44, 默认
  medium,

  /// 高 52, 页面主 CTA
  large,
}

class NeoxButton extends StatelessWidget {
  const NeoxButton({
    super.key,
    required this.label,
    this.onPressed,
    this.icon,
    this.variant = NeoxButtonVariant.primary,
    this.size = NeoxButtonSize.medium,
    this.loading = false,
    this.fullWidth = false,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final NeoxButtonVariant variant;
  final NeoxButtonSize size;
  final bool loading;
  final bool fullWidth;

  bool get _enabled => onPressed != null && !loading;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final (height, hPad, fontSize, iconSize) = switch (size) {
      NeoxButtonSize.small => (36.0, 14.0, 13.0, 16.0),
      NeoxButtonSize.medium => (44.0, 18.0, 14.0, 18.0),
      NeoxButtonSize.large => (52.0, 22.0, 15.0, 20.0),
    };

    final (bg, fg, border) = _resolveColors(scheme);

    final child = Row(
      mainAxisSize: fullWidth ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (loading) ...[
          SizedBox(
            width: iconSize,
            height: iconSize,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              valueColor: AlwaysStoppedAnimation(fg),
            ),
          ),
          SizedBox(width: NeoxSpace.sm),
        ] else if (icon != null) ...[
          Icon(icon, size: iconSize, color: fg),
          SizedBox(width: NeoxSpace.sm),
        ],
        Flexible(
          child: Text(
            label,
            style: theme.textTheme.labelLarge?.copyWith(
              fontSize: fontSize,
              color: fg,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.1,
            ),
            overflow: TextOverflow.ellipsis,
            maxLines: 1,
          ),
        ),
      ],
    );

    final padded = SizedBox(
      height: height,
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: hPad),
        child: Center(child: child),
      ),
    );

    return Opacity(
      opacity: _enabled ? 1 : 0.45,
      child: Material(
        color: bg,
        borderRadius: NeoxRadius.pillR,
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: _enabled ? onPressed : null,
          child: Ink(
            decoration: BoxDecoration(
              borderRadius: NeoxRadius.pillR,
              border: border,
            ),
            child: fullWidth
                ? SizedBox(width: double.infinity, child: padded)
                : padded,
          ),
        ),
      ),
    );
  }

  (Color bg, Color fg, BoxBorder? border) _resolveColors(ColorScheme scheme) {
    switch (variant) {
      case NeoxButtonVariant.primary:
        return (scheme.primary, scheme.onPrimary, null);
      case NeoxButtonVariant.secondary:
        return (
          Colors.transparent,
          scheme.onSurface,
          Border.all(color: scheme.outline, width: NeoxStroke.thin),
        );
      case NeoxButtonVariant.ghost:
        return (Colors.transparent, scheme.tertiary, null);
      case NeoxButtonVariant.danger:
        return (scheme.error, scheme.onError, null);
    }
  }
}
