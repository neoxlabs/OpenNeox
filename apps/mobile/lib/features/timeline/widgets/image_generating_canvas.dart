/// image_generating_canvas.dart — 出图等待中的骨架: 流动光斑 + 毛玻璃 + 斜向流光.
///
/// 2026-10-06 用户: 「图片正在生成, 主要能做一个骨架的遮罩, 或者有动画的效果, 非常高级, 有透明质感」。
/// 原来是 220 高的灰块 + 一行「正在生成…」: 跟成品的 1:1 方图尺寸不一样, 出图那一下整块跳;
/// 一张图要等 20~60 秒, 一块不动的灰色看着像卡死了。
///
/// 三层:
///   ① 底: 三团品牌色径向光斑沿各自的李萨如轨迹慢慢漂 (周期 9s, 互相错相位), 像颜料在纸上洇开
///   ② 中: 毛玻璃 —— 模糊 + 半透明白 (深色是半透明黑), 光斑被磨成柔和的色雾, 这就是"透明质感"
///   ③ 上: 一道斜向高光每 2.4s 扫过一次, 告诉人"在动, 没死"
/// 中间一行字 + 已用秒数。系统开了「减少动画」就全部静止。
library;

import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../../../shared/theme/neox_tokens.dart';
import '../../../core/image/image_request_control.dart';
import 'package:neox_app/core/i18n/tr.dart';

class ImageGeneratingCanvas extends StatefulWidget {
  const ImageGeneratingCanvas({
    super.key,
    this.startedAtMs,
    this.label,
    this.aspectRatio = 1,
    this.onCancel,
  });

  /// 这一张从什么时候开始等 (毫秒时间戳); 给了才显示已用秒数
  final int? startedAtMs;
  final String? label;

  /// 占位比例 = 成品比例 (方/横/竖) —— 出图那一下不跳版 (chat:C4-07)
  final double aspectRatio;

  /// 给了就画一颗「取消」—— 弱网下用户不用干看着 (chat:C4-05)
  final VoidCallback? onCancel;

  @override
  State<ImageGeneratingCanvas> createState() => _ImageGeneratingCanvasState();
}

class _ImageGeneratingCanvasState extends State<ImageGeneratingCanvas> with TickerProviderStateMixin {
  late final AnimationController _drift = AnimationController(vsync: this, duration: const Duration(seconds: 9));
  late final AnimationController _sweep = AnimationController(vsync: this, duration: const Duration(milliseconds: 2400));
  Timer? _tick;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final still = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    if (still) {
      _drift.stop();
      _sweep.stop();
    } else {
      if (!_drift.isAnimating) _drift.repeat();
      if (!_sweep.isAnimating) _sweep.repeat();
    }
    _tick ??= widget.startedAtMs == null
        ? null
        : Timer.periodic(const Duration(seconds: 1), (_) { if (mounted) setState(() {}); });
  }

  @override
  void dispose() {
    _tick?.cancel();
    _drift.dispose();
    _sweep.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final dark = Theme.of(context).brightness == Brightness.dark;
    final started = widget.startedAtMs;
    final secs = started == null ? null : ((DateTime.now().millisecondsSinceEpoch - started) / 1000).floor().clamp(0, 9999);
    /* 过了 30 秒就明说慢 —— 以前只有一串秒数往上跳, 用户分不清是慢还是死了 */
    final slow = started != null &&
        DateTime.now().millisecondsSinceEpoch - started > imageSlowThreshold.inMilliseconds;
    return ClipRRect(
      borderRadius: NeoxRadius.cardR,
      child: AspectRatio(
        aspectRatio: widget.aspectRatio,
        child: Stack(fit: StackFit.expand, children: [
          /* ① 流动光斑 */
          RepaintBoundary(
            child: AnimatedBuilder(
              animation: _drift,
              builder: (_, __) => CustomPaint(
                painter: _BlobPainter(
                  t: _drift.value,
                  base: dark ? scheme.surfaceContainerHigh : scheme.surfaceContainerLow,
                  colors: [scheme.primary, scheme.tertiary, scheme.secondary],
                  dark: dark,
                ),
              ),
            ),
          ),
          /* ② 毛玻璃 */
          BackdropFilter(
            filter: ui.ImageFilter.blur(sigmaX: 28, sigmaY: 28),
            child: Container(
              decoration: BoxDecoration(
                color: (dark ? Colors.black : Colors.white).withValues(alpha: dark ? 0.22 : 0.30),
                border: Border.all(color: (dark ? Colors.white : Colors.black).withValues(alpha: 0.06)),
                borderRadius: NeoxRadius.cardR,
              ),
            ),
          ),
          /* ③ 斜向流光 */
          RepaintBoundary(
            child: AnimatedBuilder(
              animation: _sweep,
              builder: (_, __) {
                final x = -1.6 + _sweep.value * 3.2;
                return DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment(x - 0.6, -1),
                      end: Alignment(x + 0.6, 1),
                      colors: [
                        Colors.white.withValues(alpha: 0),
                        Colors.white.withValues(alpha: dark ? 0.07 : 0.28),
                        Colors.white.withValues(alpha: 0),
                      ],
                      stops: const [0.35, 0.5, 0.65],
                    ),
                  ),
                );
              },
            ),
          ),
          Center(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Icon(Icons.auto_awesome_rounded, size: 22, color: scheme.onSurface.withValues(alpha: 0.55)),
              const SizedBox(height: 8),
              Text(widget.label ?? tr('正在生成'),
                  style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500, letterSpacing: 0.5, color: scheme.onSurface.withValues(alpha: 0.72))),
              if (secs != null) ...[
                const SizedBox(height: 2),
                Text(tr('已用 $secs 秒'),
                    style: TextStyle(fontSize: 12, fontFeatures: const [FontFeature.tabularFigures()], color: scheme.onSurface.withValues(alpha: 0.5))),
              ],
              if (slow) ...[
                const SizedBox(height: 6),
                Text(tr('网络有点慢，可以再等等或取消'),
                    style: TextStyle(fontSize: 12, color: scheme.onSurface.withValues(alpha: 0.6))),
              ],
              if (widget.onCancel != null) ...[
                const SizedBox(height: 10),
                TextButton(
                  onPressed: widget.onCancel,
                  child: Text(tr('取消')),
                ),
              ],
            ]),
          ),
        ]),
      ),
    );
  }
}

class _BlobPainter extends CustomPainter {
  _BlobPainter({required this.t, required this.base, required this.colors, required this.dark});
  final double t;
  final Color base;
  final List<Color> colors;
  final bool dark;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = base);
    final w = size.width, h = size.height;
    final a = t * 2 * math.pi;
    /* 三条李萨如轨迹, 频率 1:2 / 2:1 / 1:1 + 不同相位 —— 三团光不会同步, 也不会撞在一起停住 */
    final centers = [
      Offset(w * (0.5 + 0.30 * math.sin(a)), h * (0.5 + 0.28 * math.sin(2 * a + 0.6))),
      Offset(w * (0.5 + 0.32 * math.sin(2 * a + 2.1)), h * (0.5 + 0.30 * math.cos(a + 1.3))),
      Offset(w * (0.5 + 0.26 * math.cos(a + 4.0)), h * (0.5 + 0.26 * math.sin(a + 3.2))),
    ];
    final r = math.max(w, h) * 0.55;
    for (var i = 0; i < centers.length; i++) {
      /* 浅色 0.58: 0.42 时被白色毛玻璃磨成一片灰米色, 看不出是彩色在流 */
      final c = colors[i % colors.length].withValues(alpha: dark ? 0.55 : 0.58);
      canvas.drawCircle(
        centers[i],
        r,
        Paint()
          ..shader = RadialGradient(colors: [c, c.withValues(alpha: 0)]).createShader(Rect.fromCircle(center: centers[i], radius: r)),
      );
    }
  }

  @override
  bool shouldRepaint(_BlobPainter old) => old.t != t || old.base != base || old.dark != dark;
}
