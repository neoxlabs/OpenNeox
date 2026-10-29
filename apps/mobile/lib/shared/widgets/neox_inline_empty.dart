/// neox_inline_empty.dart — 分区内的空状态（一行，不是整页）.
///
/// 2026-09-04 全 app 深链截图后加的。当时各页各写各的空态:
///   云端任务  → 一行裸灰字「暂无云端任务」
///   工作区    → 一行裸灰字「当前电脑没有可用工作区」
///   设备      → 借用 SettingsRow 冒充一条列表项
///   会员/账单 → SettingsEmptyBlock（只有它是像样的）
/// 同一件事四种长相, 而且前两种是**一行没有边界的灰字挂在空白里**, 看起来像
/// 页面没加载完。
///
/// **为什么不给它们配插画**: 这些是**分区内**的空 —— 上面还有一个「云端任务」
/// 之类的小标题, 下面还有别的分区。在一段里塞一张大图会把这一段变成整页的主角,
/// 而它只是"这一格暂时没东西"。整页级的空态才用插画 (首页三个模式、图片工作台)。
///
/// 形态跟 chip / 顶栏圆底同一套词汇: 坐在一块填充面上, 而不是裸字浮在页面上。
library;

import 'package:flutter/material.dart';

import '../theme/neox_tokens.dart';

class NeoxInlineEmpty extends StatelessWidget {
  const NeoxInlineEmpty({
    super.key,
    required this.icon,
    required this.title,
    this.subtitle,
    this.onTap,
    this.actionLabel,
  });

  final IconData icon;
  final String title;

  /// 补一句"怎么才会有东西"—— 空状态最该说的就是这个.
  final String? subtitle;

  /// 有出路就给出路: 点整块跳过去.
  final VoidCallback? onTap;
  final String? actionLabel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final mute = scheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        NeoxSpace.xl,
        NeoxSpace.xs,
        NeoxSpace.xl,
        NeoxSpace.md,
      ),
      child: Material(
        color: scheme.chipFill,
        borderRadius: NeoxRadius.cardR,
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(NeoxSpace.lg),
            child: Row(
              children: [
                Icon(icon, size: 20, color: mute),
                const SizedBox(width: NeoxSpace.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        title,
                        style: theme.textTheme.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      if (subtitle != null) ...[
                        const SizedBox(height: 3),
                        Text(
                          subtitle!,
                          style:
                              theme.textTheme.bodySmall?.copyWith(color: mute),
                        ),
                      ],
                    ],
                  ),
                ),
                if (onTap != null) ...[
                  const SizedBox(width: NeoxSpace.sm),
                  if (actionLabel != null)
                    Text(
                      actionLabel!,
                      style: theme.textTheme.labelMedium
                          ?.copyWith(color: scheme.onSurface),
                    )
                  else
                    Icon(Icons.chevron_right, size: 18, color: mute),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
