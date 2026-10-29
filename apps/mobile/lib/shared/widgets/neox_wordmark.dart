/// neox_wordmark.dart — 品牌字标.
///
/// 2026-09-22 从 features/auth/auth_widgets.dart 挪出来: 应用锁屏也要用它,
/// 而锁屏不属于账号体系 —— 字标留在 auth 目录里, 锁屏就得跟着依赖登录页那一族。
library;

import 'package:flutter/material.dart';

/// Wordmark — 陶土圆环 + NEOX 艺术字, 跟官网页头同一套素材.
///
/// 2026-10-09 换掉彩色渐变圆环 (用户: 「网站都改成陶俑的 NeoX 图标了, 这个标志还没换」)。
/// 拼成两张图而不是一整张横标: 艺术字黑 / 白两版跟明暗走, 圆环明暗通用,
/// 不用为深色再出一整张。比例跟抽屉顶部一致 (圆环 : 字高 ≈ 24 : 13)。
class NeoxWordmark extends StatelessWidget {
  const NeoxWordmark({super.key, this.height = 24});

  /// 圆环的边长; 字高和间距按它等比
  final double height;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Image.asset(
          'assets/brand/mark-clay.png',
          width: height,
          height: height,
          filterQuality: FilterQuality.high,
        ),
        SizedBox(width: height * 0.5),
        Image.asset(
          isDark ? 'assets/brand/wordmark-on-dark.png' : 'assets/brand/wordmark-on-light.png',
          height: height * 0.54,
          filterQuality: FilterQuality.high,
        ),
      ],
    );
  }
}
