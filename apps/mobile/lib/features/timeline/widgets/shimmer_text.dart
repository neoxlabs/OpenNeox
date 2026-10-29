/// shimmer_text.dart — 运行态文字扫光效果 (对齐桌面 timeline 的 shimmer).
///
/// 性能约束:
///   - 只在 active=true 时跑 AnimationController; 静态时零动画开销
///   - ShaderMask 只包文字本身, RepaintBoundary 隔离, 不波及列表
library;

import 'package:flutter/material.dart';

class ShimmerText extends StatefulWidget {
  const ShimmerText(
    this.text, {
    super.key,
    required this.active,
    this.style,
    this.maxLines = 1,
  });

  final String text;

  /// true = 扫光动画 (工具在跑); false = 普通静态文字.
  final bool active;
  final TextStyle? style;
  final int maxLines;

  @override
  State<ShimmerText> createState() => _ShimmerTextState();
}

class _ShimmerTextState extends State<ShimmerText>
    with SingleTickerProviderStateMixin {
  AnimationController? _ctrl;

  @override
  void initState() {
    super.initState();
    _syncController();
  }

  @override
  void didUpdateWidget(ShimmerText old) {
    super.didUpdateWidget(old);
    if (old.active != widget.active) _syncController();
  }

  void _syncController() {
    if (widget.active) {
      _ctrl ??= AnimationController(
        vsync: this,
        /* 1100ms (原 1400): 亮带收窄之后同样速度显得慢, 一道光扫过一行标题
         * 的时间要跟"它正在干活"这件事的节奏对上 */
        duration: const Duration(milliseconds: 1100),
      );
      _ctrl!.repeat();
    } else {
      _ctrl?.stop();
    }
  }

  @override
  void dispose() {
    _ctrl?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final base = widget.style ?? DefaultTextStyle.of(context).style;
    final child = Text(
      widget.text,
      style: base,
      maxLines: widget.maxLines,
      overflow: TextOverflow.ellipsis,
    );
    if (!widget.active || _ctrl == null) return child;

    final onSurface = Theme.of(context).colorScheme.onSurface;
    /* 2026-09-18 用户: 「扫光动画不明显」。真因是**stops 被 clamp**:
     *
     *   center 从 -0.4 走到 1.4, 三个 stop 都 clamp(0,1) —— center < 0.35 或
     *   > 0.65 的时候三个 stop 有两个压在同一个边界值上, 渐变**塌成平色**。
     *   一个周期里约四成时间画面上什么都不动, 剩下的时间里亮带还很宽 (0.35),
     *   于是看起来只是"整行忽明忽暗", 不像有一道光扫过去。
     *
     * 改成整条渐变**平移**: stops 固定在 [0, .5, 1], 用 GradientTransform 把
     * 整个 shader 从左边外面推到右边外面。任何时刻渐变都是完整的三段, 不会塌。
     *
     * 2026-09-22 用户仍然说「扫光动画并不明显」—— 结构对了, 但**对比不够**:
     *   底色 0.55 → 亮带 1.0 只差 0.45 个 alpha, 在本来就浅的 onSurfaceVariant
     *   系文字上几乎读不出差别 (thinking 行用的正是 mute 色)。把底色压到 0.3:
     *   暗的那截仍读得清, 而亮带与它的差拉到 0.7 —— 一道光扫过去才是看得见的。
     *   亮带宽度 (stops 0.35→0.65) 保持不变: 加宽会让它退回"整行忽明忽暗"。 */
    return RepaintBoundary(
      child: AnimatedBuilder(
        animation: _ctrl!,
        builder: (context, _) {
          return ShaderMask(
            shaderCallback: (bounds) => LinearGradient(
              colors: [
                onSurface.withValues(alpha: 0.3),
                onSurface,
                onSurface.withValues(alpha: 0.3),
              ],
              stops: const [0.35, 0.5, 0.65],
              transform: _SweepTranslate(_ctrl!.value),
            ).createShader(bounds),
            blendMode: BlendMode.srcIn,
            child: child,
          );
        },
      ),
    );
  }
}


/// 把整条渐变从左外侧推到右外侧 —— 扫光的"动"全靠它.
///
/// 用 transform 而不是挪 stops: 挪 stops 就必须 clamp 到 [0,1], 而 clamp 会在
/// 两端把多个 stop 压成同一个值, 渐变塌成平色 (那正是"扫光不明显"的真因)。
class _SweepTranslate extends GradientTransform {
  const _SweepTranslate(this.t);

  /// 0 → 1 的进度.
  final double t;

  @override
  Matrix4 transform(Rect bounds, {TextDirection? textDirection}) {
    /* -1 → +1 个自身宽度: 起止都在可视区之外, 所以看不到"光突然出现/消失" */
    return Matrix4.translationValues(bounds.width * (t * 2 - 1), 0, 0);
  }
}
