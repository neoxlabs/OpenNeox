/// neox_mark_loader.dart — 品牌圆环加载动画 (拉聊天记录 / 连电脑时的整屏等待态).
///
/// 2026-09-25 用户: 「加载聊天记录要有 logo 的动画」。原来只有居中一行灰字
/// 「正在同步消息…」, 看着像卡住了。
///
/// 三层叠在一起, 都只动 transform / opacity / shader, 不触发布局:
///   · 圆环本身慢转 —— 这枚 mark 就是个漩涡, 转起来像"在吸进数据", 不像菊花
///   · 一道高光从左上扫到右下 —— 跟 timeline 运行态文字 (ShimmerText) 同一套扫光
///   · 身后一圈品牌色光晕呼吸 —— 让它在深浅两种底上都有存在感
/// 下面的说明文字用 ShimmerText 扫光, 跟圆环同一节奏。
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../features/timeline/widgets/shimmer_text.dart';

class NeoxMarkLoader extends StatefulWidget {
  const NeoxMarkLoader({super.key, this.label, this.size = 44});

  /// 圆环下面的一行说明; null 只画圆环.
  final String? label;
  final double size;

  @override
  State<NeoxMarkLoader> createState() => _NeoxMarkLoaderState();
}

class _NeoxMarkLoaderState extends State<NeoxMarkLoader>
    with SingleTickerProviderStateMixin {
  /* 一个 controller 驱动三层: 周期 2.4s, 转一圈 = 扫光一次 = 呼吸一次,
   * 三件事对齐在同一拍上, 不会各跳各的显得乱。 */
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 2400),
  )..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dark = theme.brightness == Brightness.dark;
    final s = widget.size;
    final mark = Image.asset(
      'assets/brand/mark-clay.png',
      width: s,
      height: s,
      filterQuality: FilterQuality.medium,
      gaplessPlayback: true,
    );
    final ring = RepaintBoundary(
      child: AnimatedBuilder(
        animation: _c,
        child: mark,
        builder: (context, child) {
          final t = _c.value;
          /* 呼吸: 0 → 1 → 0, 用余弦让两端停得软 */
          final breath = 0.5 - 0.5 * math.cos(t * 2 * math.pi);
          return SizedBox(
            width: s * 1.9,
            height: s * 1.9,
            child: Stack(
              alignment: Alignment.center,
              children: [
                /* 光晕用径向渐变淡到 0, 不用 BoxShadow —— 透明盒子的阴影会把整个圆
                 * 填实, 截出来是一块硬边圆片 (第一版渲染台就是这样, 像个徽章底座)。 */
                Container(
                  width: s * 1.9,
                  height: s * 1.9,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: RadialGradient(
                      colors: [
                        const Color(0xFF7B5CFF).withValues(
                          alpha: (dark ? 0.26 : 0.16) + 0.14 * breath,
                        ),
                        const Color(0xFF7B5CFF).withValues(alpha: 0),
                      ],
                      stops: [0.2, 0.62 + 0.12 * breath],
                    ),
                  ),
                ),
                Transform.scale(
                  scale: 0.96 + 0.04 * breath,
                  child: Transform.rotate(
                    /* 逆时针: 这枚漩涡的旋臂是顺时针张开的, 反着转才是"往里收" */
                    angle: -t * 2 * math.pi,
                    child: ShaderMask(
                      blendMode: BlendMode.srcATop,
                      shaderCallback: (bounds) => LinearGradient(
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                        colors: [
                          Colors.white.withValues(alpha: 0),
                          Colors.white.withValues(alpha: 0.7),
                          Colors.white.withValues(alpha: 0),
                        ],
                        stops: const [0.38, 0.5, 0.62],
                        /* 扫光走屏幕坐标, 抵掉圆环自身的旋转, 否则光带跟着转就看不出"扫" */
                        transform: _CounterRotatedSweep(t),
                      ).createShader(bounds),
                      child: child,
                    ),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
    if (widget.label == null) return ring;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        ring,
        const SizedBox(height: 4),
        ShimmerText(
          widget.label!,
          active: true,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}

/// 把高光带从左上外侧推到右下外侧, 同时反向旋转抵消外层 Transform.rotate.
class _CounterRotatedSweep extends GradientTransform {
  const _CounterRotatedSweep(this.t);

  final double t;

  @override
  Matrix4 transform(Rect bounds, {TextDirection? textDirection}) {
    final c = bounds.center;
    /* 前 60% 的时间扫过去, 后 40% 留白 —— 一直有光在走会变成"一闪一闪", 不像扫光 */
    final p = (t / 0.6).clamp(0.0, 1.0);
    final d = (p * 2 - 1) * bounds.width;
    return Matrix4.identity()
      ..translate(c.dx, c.dy)
      ..rotateZ(t * 2 * math.pi)
      ..translate(-c.dx + d, -c.dy + d);
  }
}
