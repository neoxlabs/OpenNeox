/// onboarding_stage.dart — 引导页的分层陶土舞台.
///
/// 2026-10-09 用户看了整张插画浮动后: 「能动起来吗? 现在都是整体动, 里面的每个组件可以有
/// 动画演示一样的吗?」—— 于是每张场景拆成单件 (assets/clay/p-*.webp, 同一机位单独出图),
/// 在这里按时序拼回去: 底座先到, 主体落下, 小件滑入, 然后各件错开相位轻轻浮动。
///
/// 坐标全部是"舞台宽度的比例" (left / top / width), 舞台高 = 宽 × [_StageSpec.aspect]。
/// 这些数字是对着原整张图一件件拼出来的 —— 改素材后要重新对。
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../shared/theme/neox_tokens.dart';

enum OnboardingStageKind { deliver, voice, relay }

/// 一件素材怎么进场
enum _Enter {
  /// 原地淡入并从略低处抬起 (底座)
  rise,

  /// 从上方落下, 落地轻弹
  drop,

  /// 从左侧滑入
  slideLeft,

  /// 从右侧滑入
  slideRight,

  /// 由小到大弹出
  pop,
}

class _Layer {
  const _Layer(
    this.asset,
    this.left,
    this.top,
    this.width, {
    required this.enter,
    required this.at,
    this.bob = 0,
    this.phase = 0,
  });

  final String asset;
  final double left;
  final double top;
  final double width;
  final _Enter enter;

  /// 入场起点 (0..1, 占整段入场时长的比例)
  final double at;

  /// 常驻浮动幅度 (舞台宽的比例); 0 = 不动 (底座)
  final double bob;

  /// 浮动相位 (0..1) —— 各件错开, 不会整齐划一地一起上下
  final double phase;
}

class _StageSpec {
  const _StageSpec(this.aspect, this.layers);
  final double aspect;
  final List<_Layer> layers;
}

const _specs = <OnboardingStageKind, _StageSpec>{
  OnboardingStageKind.deliver: _StageSpec(0.96, [
    _Layer('p-deliver-base', 0.03, 0.40, 0.94, enter: _Enter.rise, at: 0),
    _Layer('p-deliver-board', 0.42, 0.03, 0.40,
        enter: _Enter.drop, at: 0.18, bob: 0.008, phase: 0),
    _Layer('p-deliver-tablet', 0.11, 0.33, 0.37,
        enter: _Enter.slideLeft, at: 0.34, bob: 0.010, phase: 0.33),
    _Layer('p-deliver-doc', 0.37, 0.53, 0.44,
        enter: _Enter.drop, at: 0.50, bob: 0.012, phase: 0.66),
  ]),
  /* 1.36: 麦克风那张是 369×720, 放 0.66 宽就有 1.29 高, 加上 0.06 顶边 —— 少一点底座就被裁 */
  OnboardingStageKind.voice: _StageSpec(1.36, [
    _Layer('p-voice-mic', 0.17, 0.06, 0.66,
        enter: _Enter.pop, at: 0, bob: 0.010, phase: 0),
    /* 声波不浮动, 由 [_waves] 单独驱动一张一弛 */
    _Layer('p-voice-waves-l', 0.0, 0.04, 0.21, enter: _Enter.slideLeft, at: 0.30),
    _Layer('p-voice-waves-r', 0.79, 0.10, 0.21, enter: _Enter.slideRight, at: 0.36),
  ]),
  OnboardingStageKind.relay: _StageSpec(0.80, [
    _Layer('p-relay-base', 0.04, 0.38, 0.92, enter: _Enter.rise, at: 0),
    _Layer('p-relay-phone', 0.12, 0.04, 0.19,
        enter: _Enter.drop, at: 0.16, bob: 0.010, phase: 0),
    _Layer('p-relay-laptop', 0.41, 0.11, 0.53,
        enter: _Enter.drop, at: 0.30, bob: 0.006, phase: 0.5),
  ]),
};

/// relay 那条蓝线: 手机屏幕中心 → 电脑屏幕中心 (舞台比例), 中间往上拱
/* 对着分帧截图量的: 手机屏面中心 / 电脑屏面中心 */
const _relayFrom = Offset(0.22, 0.17);
const _relayTo = Offset(0.75, 0.21);
const _relayCtrl = Offset(0.49, -0.06);

class OnboardingStage extends StatefulWidget {
  const OnboardingStage({super.key, required this.kind, required this.active});

  final OnboardingStageKind kind;

  /// 这一页是否在屏幕中间 —— false→true 时重放入场
  final bool active;

  @override
  State<OnboardingStage> createState() => _OnboardingStageState();
}

class _OnboardingStageState extends State<OnboardingStage>
    with TickerProviderStateMixin {
  late final AnimationController _enter = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1700),
  );

  /// 常驻循环: 浮动 / 声波 / 蓝线上的亮点
  late final AnimationController _loop = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 4),
  );

  @override
  void initState() {
    super.initState();
    if (widget.active) _play();
  }

  @override
  void didUpdateWidget(covariant OnboardingStage old) {
    super.didUpdateWidget(old);
    if (widget.active && !old.active) _play();
  }

  void _play() {
    _enter
      ..reset()
      ..forward();
    if (!_loop.isAnimating) _loop.repeat();
  }

  @override
  void dispose() {
    _enter.dispose();
    _loop.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final spec = _specs[widget.kind]!;
    /* 减弱动画: 直接给终态, 不跑循环 */
    final still = MediaQuery.disableAnimationsOf(context);
    if (still) {
      _enter.value = 1;
      _loop.stop();
    }
    return AspectRatio(
      aspectRatio: 1 / spec.aspect,
      child: LayoutBuilder(
        builder: (context, box) {
          final w = box.maxWidth;
          return AnimatedBuilder(
            animation: Listenable.merge([_enter, _loop]),
            builder: (context, _) {
              final children = <Widget>[];
              for (var i = 0; i < spec.layers.length; i++) {
                final l = spec.layers[i];
                children.add(_layer(l, w));
                /* 蓝线画在电脑之下、手机之上会被电脑屏幕挡住一截 —— 放在最后一层之后 */
              }
              if (widget.kind == OnboardingStageKind.relay) {
                children.add(Positioned.fill(
                  child: CustomPaint(
                    painter: _RelayLinePainter(
                      /* 电脑落地之后才开始画线 */
                      draw: _interval(_enter.value, 0.62, 0.95, Curves.easeInOutCubic),
                      pulse: _loop.value,
                      w: w,
                    ),
                  ),
                ));
              }
              return Stack(clipBehavior: Clip.none, children: children);
            },
          );
        },
      ),
    );
  }

  static double _interval(double t, double a, double b, Curve c) =>
      c.transform(((t - a) / (b - a)).clamp(0.0, 1.0));

  Widget _layer(_Layer l, double w) {
    /* 每件的入场占整段的 40%, 从 l.at 起 */
    final p = _interval(_enter.value, l.at, l.at + 0.4, Curves.linear);
    double dx = 0, dy = 0, scale = 1, opacity = 1;
    switch (l.enter) {
      case _Enter.rise:
        final e = Curves.easeOutCubic.transform(p);
        dy = (1 - e) * w * 0.06;
        opacity = e;
      case _Enter.drop:
        /* easeOutBack 落地会稍微压过头再回弹, 像真的"放"在台子上 */
        final e = Curves.easeOutBack.transform(p);
        dy = -(1 - e) * w * 0.22;
        opacity = Curves.easeOut.transform((p * 2.5).clamp(0.0, 1.0));
      case _Enter.slideLeft:
        final e = Curves.easeOutCubic.transform(p);
        dx = -(1 - e) * w * 0.18;
        opacity = e;
      case _Enter.slideRight:
        final e = Curves.easeOutCubic.transform(p);
        dx = (1 - e) * w * 0.18;
        opacity = e;
      case _Enter.pop:
        final e = Curves.easeOutBack.transform(p);
        scale = 0.6 + 0.4 * e;
        opacity = Curves.easeOut.transform((p * 2).clamp(0.0, 1.0));
    }

    /* 入场结束后的常驻动作 */
    final settled = _interval(_enter.value, l.at + 0.4, l.at + 0.55, Curves.easeOut);
    if (l.bob > 0) {
      dy += math.sin((_loop.value + l.phase) * 2 * math.pi) * w * l.bob * settled;
    }
    if (l.asset.startsWith('p-voice-waves')) {
      /* 声波: 左右交替一张一弛, 像在往外传声 */
      final off = l.asset.endsWith('-r') ? 0.5 : 0.0;
      final s = (math.sin((_loop.value * 2 + off) * 2 * math.pi) + 1) / 2; // 0..1
      scale *= 1 + 0.08 * s * settled;
      opacity *= 1 - 0.45 * (1 - s) * settled;
      dx += (l.asset.endsWith('-r') ? 1 : -1) * w * 0.02 * s * settled;
    }

    return Positioned(
      left: l.left * w + dx,
      top: l.top * w + dy,
      width: l.width * w,
      child: Opacity(
        opacity: opacity.clamp(0.0, 1.0),
        child: Transform.scale(
          scale: scale,
          alignment: Alignment.bottomCenter,
          child: Image.asset(
            NeoxClay.of(l.asset),
            fit: BoxFit.contain,
            filterQuality: FilterQuality.medium,
          ),
        ),
      ),
    );
  }
}

/// 手机到电脑那条蓝线: 先一笔画出来, 两端落点, 然后一颗亮点沿线来回流动。
class _RelayLinePainter extends CustomPainter {
  _RelayLinePainter({required this.draw, required this.pulse, required this.w});

  /// 画到哪儿了 (0..1)
  final double draw;

  /// 循环进度, 驱动亮点
  final double pulse;
  final double w;

  Offset _at(double t) {
    final a = _relayFrom * w, b = _relayTo * w, c = _relayCtrl * w;
    final u = 1 - t;
    return a * (u * u) + c * (2 * u * t) + b * (t * t);
  }

  @override
  void paint(Canvas canvas, Size size) {
    if (draw <= 0) return;
    final path = Path()..moveTo(_at(0).dx, _at(0).dy);
    const steps = 48;
    for (var i = 1; i <= (steps * draw).ceil(); i++) {
      final p = _at(math.min(i / steps, draw));
      path.lineTo(p.dx, p.dy);
    }
    final stroke = w * 0.016;
    /* 陶土感: 底下一道深一点的"厚度", 上面一道主色, 像一根圆管 */
    canvas.drawPath(
      path.shift(Offset(0, stroke * 0.35)),
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = stroke
        ..strokeCap = StrokeCap.round
        ..color = const Color(0xFF2152CC),
    );
    canvas.drawPath(
      path,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = stroke
        ..strokeCap = StrokeCap.round
        ..color = NeoxBrand.blue,
    );
    /* 起点圆头 */
    final dotR = stroke * 1.25;
    canvas.drawCircle(_at(0) + Offset(0, stroke * 0.3), dotR, Paint()..color = const Color(0xFF2152CC));
    canvas.drawCircle(_at(0), dotR, Paint()..color = NeoxBrand.blue);
    /* 终点圆头: 画到头才出现 */
    if (draw >= 1) {
      canvas.drawCircle(_at(1) + Offset(0, stroke * 0.3), dotR, Paint()..color = const Color(0xFF2152CC));
      canvas.drawCircle(_at(1), dotR, Paint()..color = NeoxBrand.blue);
      /* 流动的亮点: 手机 → 电脑, 2 秒一趟 */
      final t = (pulse * 2) % 1;
      final glow = math.sin(t * math.pi); // 两端淡, 中间亮
      canvas.drawCircle(
        _at(t),
        stroke * 0.45,
        Paint()..color = Colors.white.withValues(alpha: 0.85 * glow),
      );
    }
  }

  @override
  bool shouldRepaint(_RelayLinePainter old) =>
      old.draw != draw || old.pulse != pulse || old.w != w;
}
