/// neox_card.dart — 全 app 统一的卡片表面.
///
/// Claude 风:
///   - 20px 大圆角
///   - 0.5px 淡描边, 不投阴影
///   - 默认 padding 16, 可调
///   - 可选 onTap → 整卡可点击 (Material InkWell 涟漪)
///
/// 用法:
///   NeoxCard(child: ...)           // 普通信息卡
///   NeoxCard(onTap: ..., child: ...) // 可点击卡 (账户卡/设备卡)
///   NeoxCard.hero(child: ...)      // 升级/介绍 Hero 卡 (更大 padding)
library;

import 'package:flutter/material.dart';

import '../theme/neox_tokens.dart';

class NeoxCard extends StatelessWidget {
  const NeoxCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(NeoxSpace.lg),
    this.color,
    this.borderColor,
    this.onTap,
    this.borderRadius = NeoxRadius.cardR,
    this.outlined = true,
  });

  /// Hero 卡 — 用于 upgrade / onboarding 等突出卡片, 更大 padding + 取消描边
  const NeoxCard.hero({
    super.key,
    required this.child,
    this.color,
    this.onTap,
  })  : padding = const EdgeInsets.all(NeoxSpace.xxl),
        borderColor = null,
        borderRadius = NeoxRadius.cardR,
        outlined = false;

  /// Flat — 仅作分组容器, 无描边无填色 (透明).
  const NeoxCard.flat({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(NeoxSpace.lg),
  })  : color = Colors.transparent,
        borderColor = null,
        onTap = null,
        borderRadius = NeoxRadius.cardR,
        outlined = false;

  final Widget child;
  final EdgeInsetsGeometry padding;
  final Color? color;
  final Color? borderColor;
  final VoidCallback? onTap;
  final BorderRadius borderRadius;
  final bool outlined;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final fill = color ?? scheme.surfaceContainerHigh;
    final border = outlined
        ? Border.all(
            color: borderColor ?? scheme.outline,
            width: NeoxStroke.hair,
          )
        : null;

    final content = Container(
      decoration: BoxDecoration(
        color: fill,
        borderRadius: borderRadius,
        border: border,
      ),
      padding: padding,
      child: child,
    );

    if (onTap == null) return content;

    return Material(
      color: Colors.transparent,
      borderRadius: borderRadius,
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: content,
      ),
    );
  }
}
