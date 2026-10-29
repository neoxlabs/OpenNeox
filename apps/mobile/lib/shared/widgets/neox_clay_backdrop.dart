/// neox_clay_backdrop.dart — 页面顶部的陶土场景背景图 (2026-10-10).
///
/// 登录页做了整页陶土背景后用户: 「非常不错, 其他设置等地方也可以类似的」。
/// 图都按同一套陶土风出 (assets/clay/bg-*.webp): 场景在图的上部, 下部是空的暖白, 这里把下沿渐隐进页面底色,
/// 整张慢慢上下浮几个像素。
///
/// **暗色用专门出的图, 不是把浅色图压暗** (2026-10-12 用户: 「暗黑模式估计素材要适配新的」)。
/// 见 [darkVariants]。
library;

import 'package:flutter/material.dart';

import '../theme/neox_tokens.dart';
import 'asset_px.dart';

class NeoxClayBackdrop extends StatefulWidget {
  const NeoxClayBackdrop({super.key, required this.asset, this.fadeFrom = 0.55, this.fadeTo = 0.95, this.fadeTop = false});

  /// assets/clay 下的名字 (不带扩展名)
  final String asset;

  /// 从图高的哪儿开始渐隐 / 到哪儿全透明
  final double fadeFrom;
  final double fadeTo;

  /// 上沿也渐隐 —— 图不贴屏幕顶时 (从顶栏下面开始), 上沿是一条硬边
  final bool fadeTop;

  /// 深色主题的压暗矩阵 (登录页同一套)
  static const ColorFilter darkFilter = ColorFilter.matrix([
    0.32, 0, 0, 0, 6,
    0, 0.32, 0, 0, 6,
    0, 0, 0.32, 0, 8,
    0, 0, 0, 1, 0,
  ]);

  @override
  State<NeoxClayBackdrop> createState() => _NeoxClayBackdropState();
}

class _NeoxClayBackdropState extends State<NeoxClayBackdrop> with SingleTickerProviderStateMixin {
  late final AnimationController _float = AnimationController(vsync: this, duration: const Duration(seconds: 6))..repeat(reverse: true);

  @override
  void dispose() {
    _float.dispose();
    super.dispose();
  }

  /// 渐隐覆盖层 —— 用**页面底色**盖住图的上下边, 越往下越实.
  ///
  /// `fadeTop` 是"图的上沿也要渐隐": 上沿那 14% 要先被底色**盖满**再放开。
  /// 2026-10-12 用户指着顶栏下面那条横带说「明显的分割」—— 就是这里一度写反了:
  /// 换成渐变覆盖时把顶端 alpha 写成了 0 (= 图全露), 而 ShaderMask 那版顶端是
  /// **全透明地渐入**的; 暗色版图自己的顶边是一层暖褐, 比页面底色亮, 于是顶栏下面
  /// 直接显出图的上沿。判据: 没 fadeTop 时图就该从顶边开始是实的。
  Widget _fadeOverlay(Color bg) {
    final stops = <double>[
      0,
      if (widget.fadeTop) 0.14,
      widget.fadeFrom,
      widget.fadeTo,
      1,
    ];
    final alphas = <double>[
      widget.fadeTop ? 1 : 0,
      if (widget.fadeTop) 0,
      0,
      1,
      1,
    ];
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [for (final a in alphas) bg.withValues(alpha: a)],
          stops: stops,
        ),
      ),
    );
  }
  /// 有暗色版的陶土背景 (`assets/clay/<name>-dark.webp`).
  ///
  /// 原来是拿浅色图乘一个 0.32 的压暗矩阵 —— 底色是被压下去了, 但陶土物件同样被压,
  /// 整块变成一团灰泥, 图上的文字也跟着糊。现在每种背景**单独出一张暗房版**:
  /// 同一批物件、同一个取景, 只把底色和光照换掉 (图生图, 构图不变)。
  /// [darkFilter] 只留给没有暗色版的图兜底。
  static const Set<String> darkVariants = {
    'bg-chat',
    'bg-connection',
    'bg-devices',
    'bg-image',
    'bg-inbox',
    'bg-me',
    'bg-voice',
    'bg-workbench',
  };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dark = theme.brightness == Brightness.dark;
    final still = MediaQuery.disableAnimationsOf(context);
    final hasDark = dark && darkVariants.contains(widget.asset);
    /* 渐隐的落点色 —— 页面底色, 也就是图"渐隐掉"之后本该露出的那层 */
    final bg = theme.colorScheme.surfaceContainerLowest;
    return LayoutBuilder(
      builder: (context, box) {
        Widget img = Image.asset(
          NeoxClay.of(hasDark ? '${widget.asset}-dark' : widget.asset),
          fit: BoxFit.fitWidth,
          alignment: Alignment.topCenter,
          /* 按**显示宽度**解码 —— 源图 1536×1024, 一屏只用得到 ~1080 物理像素宽,
           * 按原图解等于白解一倍多的像素 (见 asset_px.dart 里同一个坑)。 */
          cacheWidth: assetPx(box.maxWidth),
          filterQuality: FilterQuality.medium,
        );
        if (dark && !hasDark) {
          img = ColorFiltered(colorFilter: NeoxClayBackdrop.darkFilter, child: img);
        }
        return IgnorePointer(
          child: AnimatedBuilder(
            animation: _float,
            builder: (context, child) => Transform.translate(
              offset: Offset(0, still ? 0 : -5 * Curves.easeInOut.transform(_float.value)),
              child: child,
            ),
            /* RepaintBoundary 必须在 Transform **里面** (2026-10-12):
             * 图和渐隐都是定死的, 包一层边界之后它被缓存成一个独立图层, 浮动只是把这个
             * 图层整体平移 —— 不需要每帧重新光栅化那张 1080×720 的图。
             * 原来边界包在 Transform 外面, 等于每帧都在边界里重画一遍 (profile 实测
             * raster p50 16.5ms / 掉帧 70%), 白花。 */
            child: RepaintBoundary(
              child: Stack(
                fit: StackFit.expand,
                children: [
                  img,
                  /* 渐隐用**盖一层页面底色**做, 不再是 ShaderMask (2026-10-12):
                   * ShaderMask 要开一块跟整张图一样大的离屏层 (saveLayer) 再混合;
                   * 换成普通渐变矩形, 底下本来就是同色的页面, 看不出区别。 */
                  _fadeOverlay(bg),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}
