/// home_greeting.dart — 首页空态顶上的时段问候 (原 Life dashboard 里的 LifeGreeting,
/// 2026-09-23 Life 删掉后搬到这里, 工作 / 编码首页继续用).
library;

import 'package:flutter/material.dart';

import '../../../shared/theme/neox_tokens.dart';
import 'package:neox_app/core/i18n/tr.dart';

class HomeGreeting extends StatelessWidget {
  const HomeGreeting({super.key, required this.subtitle});

  /// 两个模式共用这个问候块, 副标题各自说一句 —— 模式名已经不在顶栏和输入框上了,
  /// 空态首屏是用户判断"我现在在哪个模式"的地方。
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final greeting = homeGreetingText();
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        NeoxSpace.xl,
        NeoxSpace.lg,
        NeoxSpace.xl,
        NeoxSpace.xs,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            greeting,
            style: theme.textTheme.headlineMedium?.copyWith(
              height: 1.2,
              letterSpacing: -0.3,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            subtitle,
            style: theme.textTheme.bodyLarge?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}

/// 时段问候 —— 首页陶土横幅上也用它当标题, 所以提出来公开.
String homeGreetingText([DateTime? now]) {
  final hour = (now ?? DateTime.now()).hour;
  if (hour < 6) return tr('还没睡吗');
  if (hour < 12) return tr('早上好');
  if (hour < 14) return tr('中午好');
  if (hour < 18) return tr('下午好');
  if (hour < 22) return tr('晚上好');
  return tr('晚安');
}
