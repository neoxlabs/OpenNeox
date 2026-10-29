/// neox_page_hero.dart — 二级页的陶土页头 (2026-10-10).
///
/// 「我」页做成整张陶土背景 + 左下账户后用户: 「继续吧, 你来搞」—— 消息 / 语音 / 设备 / 连接同一套:
/// 背景图从屏幕最顶铺下来 (顶栏透明压在图上), 物件在右半边, 左下是大标题 + 一行说明。
/// 用法: 页面的 Scaffold 设 extendBodyBehindAppBar + 透明顶栏 (见 [NeoxHeroAppBar]), 第一块放它。
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/neox_tokens.dart';
import 'asset_px.dart';
import 'neox_clay_backdrop.dart';

class NeoxPageHero extends StatelessWidget {
  const NeoxPageHero({super.key, required this.asset, required this.title, this.subtitle});

  /// 页头标题的字号 —— **长了降一档**.
  ///
  /// 2026-10-12 用户: 「优化文字 感觉放不下…还有超长的时候处理办法」——
  /// 页头标题装的是设备名 / 模式名这种用户自己起的东西, 长度不可控:
  /// 「Kimberly MacBook Air (809)」在 26 号字下要三行, 把页头撑高一截、副标题也被挤下去。
  /// 两件事一起做: 长过 16 字降一档字号, 而且**最多两行 + 超出省略** (省略号是写着的兜底,
  /// 字号只负责让它尽量别走到那一步)。
  /// 判据用**字数**而不是量出来的宽度: 量宽度要等布局跑完, 第一帧会闪一下字号跳变。
  static double titleSize(String title) => title.length > 12 ? 20 : 26;

  /// 长标题时给右边多让一点地方 —— 陶土物件就压在条幅的右侧 ~40% 上.
  ///
  /// 短标题 (所有设置页) 维持 0.42 不动, 因为副标题要靠这块宽度;
  /// 只有长名字 (设备名这种用户起的东西) 才收到 0.58, 宁可两行也不要仲到物件头上 ——
  /// 2026-10-12 实拍: `JDMCVMPHIYKSSVX` 收到 0.56 时, 第一行最后一个字母正好压在
  /// 陶土平板的左缘上, 白字对浅色物件读不清; 再让 2% 就干净了。
  static double titleRightInset(String title) => title.length > 12 ? 0.58 : 0.42;

  /// 最多几行. 长名字给三行 —— 「Kimberly MacBook Air (809)」两行时会把
  /// 结尾那个编号切成省略号, 而**那个号正是同型号多台电脑之间唯一的区分**。
  /// 页头高度是按整张图给的, 三行放得下 (文字块锚在底部, 往上长)。
  static int titleMaxLines(String title) => title.length > 12 ? 3 : 2;

  /// assets/clay 下的背景图名 (1536×1024, 物件在右 60%)
  final String asset;
  final String title;
  final String? subtitle;

  static const double _aspect = 1024 / 1536;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return LayoutBuilder(
      builder: (context, box) {
        final h = (box.maxWidth * _aspect * 0.86).clamp(210.0, 300.0);
        return SizedBox(
          height: h,
          child: ClipRect(
            child: Stack(
              children: [
                Positioned(
                  left: 0,
                  right: 0,
                  top: 0,
                  height: box.maxWidth * _aspect,
                  child: NeoxClayBackdrop(asset: asset, fadeFrom: 0.62, fadeTo: 0.86),
                ),
                _ClayTextScrim(),
                Positioned(
                  left: NeoxSpace.xl + 4,
                  right: box.maxWidth * NeoxPageHero.titleRightInset(title),
                  bottom: h * 0.12,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        title,
                        /* 超长时的兜底: 行数按长度给, 再多就省略 (见 titleMaxLines) */
                        maxLines: NeoxPageHero.titleMaxLines(title),
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: NeoxPageHero.titleSize(title), fontWeight: FontWeight.w700, letterSpacing: -0.4, color: theme.colorScheme.onSurface, height: 1.15),
                      ),
                      if (subtitle != null) ...[
                        const SizedBox(height: 6),
                        Text(subtitle!,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant, fontSize: 13, height: 1.4)),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  文字那侧的渐隐
// ════════════════════════════════════════════════════════════════
/// 页头图上给文字让出来的一条渐隐 (跟页面同色, 从左向右淡出).
///
/// 页头图的物件偶尔会伸到文字底下 —— 暗色版 bg-workbench 那台笔记本的底盘就直接
/// 压在副标题上, 暗房里白底物件 + 浅灰字, 两边都看得见、两边都读不清。底色本来就是
/// 暖白 / 暗灰, 这层在没物件的地方完全看不见, 压到物件上时把字托起来。
class _ClayTextScrim extends StatelessWidget {
  const _ClayTextScrim();

  @override
  Widget build(BuildContext context) {
    final bg = Theme.of(context).colorScheme.surfaceContainerLowest;
    return Positioned.fill(
      child: IgnorePointer(
        child: DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.centerLeft,
              end: Alignment.centerRight,
              colors: [bg, bg.withValues(alpha: 0.88), bg.withValues(alpha: 0)],
              stops: const [0, 0.30, 0.58],
            ),
          ),
        ),
      ),
    );
  }
}

/// 启动后空闲时把首页那两张陶土横幅先解好.
///
/// 用户 2026-10-12: 「有时候 UI 会卡一下, 尤其是刚打开的时候」。横幅是首页第一屏
/// 最大的位图, 第一次画它要在 UI/raster 线程上现场解码 + 上传 GPU —— 放在启动后
/// 的空闲里做掉, 第一帧就直接命中缓存。
/// 尺寸必须跟 [NeoxClayBackdrop] 的 `cacheWidth: assetPx(width)` 同一个缓存键,
/// 所以这里用 [assetAtWidth] 而不是随手写个数字 (不一致 = 白解一遍)。
Future<void> precacheClayBanners(BuildContext context) async {
  final dark = Theme.of(context).brightness == Brightness.dark;
  final w = MediaQuery.sizeOf(context).width;
  for (final name in const ['bg-chat', 'bg-workbench']) {
    if (!context.mounted) return;
    await precacheImage(
      assetAtWidth(NeoxClay.of(dark ? '$name-dark' : name), w),
      context,
    );
  }
}

/// 压在页头图上的透明顶栏: 返回键 + 右侧按钮, 不写标题 (标题在图上)
class NeoxHeroAppBar extends StatelessWidget implements PreferredSizeWidget {
  const NeoxHeroAppBar({super.key, this.actions});

  final List<Widget>? actions;

  @override
  Size get preferredSize => const Size.fromHeight(kToolbarHeight);

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final canPop = ModalRoute.of(context)?.canPop ?? false;
    return AppBar(
      backgroundColor: Colors.transparent,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      systemOverlayStyle: (dark ? SystemUiOverlayStyle.light : SystemUiOverlayStyle.dark).copyWith(statusBarColor: Colors.transparent),
      leading: canPop ? IconButton(icon: const Icon(Icons.arrow_back_ios_new, size: 20), onPressed: () => Navigator.maybePop(context)) : null,
      actions: actions == null ? null : [...actions!, const SizedBox(width: NeoxSpace.sm)],
    );
  }
}

/// 首页顶部的那条陶土横幅 —— 页头图 + 左下角的标题和一句说明.
///
/// 跟 [NeoxPageHero] 的区别: 那个是**二级页**的"图铺到屏幕最顶, 顶栏透明压上去";
/// 这个是摆在**首页顶栏下面**的一条横幅 (首页有自己的顶栏和底部输入框),
/// 所以图的上沿也要渐隐 ([NeoxClayBackdrop] 的 fadeTop), 否则会留一条硬边。
class NeoxClayBanner extends StatelessWidget {
  const NeoxClayBanner({
    super.key,
    required this.asset,
    required this.title,
    this.subtitle,
    this.titleStyle,
    this.minHeight = 190,
    this.maxHeight = 300,
  });

  /// assets/clay 下的名字 (不带扩展名; 1536×1024, 物件在右 60%)
  final String asset;
  final String title;
  final String? subtitle;

  /// 标题样式 —— 默认跟 [NeoxPageHero] 同一个口径 (26 / w700)。
  /// 对话首页传主题的大衷线: 那屏的主语是"你", 那句问候本来就是衷线。
  final TextStyle? titleStyle;

  final double minHeight;
  final double maxHeight;

  static const double _aspect = 1024 / 1536;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return LayoutBuilder(
      builder: (context, box) {
        final w = box.maxWidth;
        /* 高度按**整张图**给 (0.98), 不是裁掉一截的 0.86 —— 图的渐隐在 0.86 倍图高处
         * 就结束了, 横幅跟图一样高时, 锚在底部 12% 的标题才落在**完全渐隐**的那条带子上。
         * 给矮了的话文字正好压在陶土物件上: 暗色版的 bg-workbench 那台笔记本的底盘
         * 直接盖住副标题, 浅灰字压白底盘, 两边都读不清 (2026-10-12 暗色走查实拍)。 */
        final h = (w * _aspect * 0.98).clamp(minHeight, maxHeight);
        return SizedBox(
          height: h,
          child: ClipRect(
            child: Stack(
              children: [
                Positioned(
                  left: 0,
                  right: 0,
                  top: 0,
                  height: w * _aspect,
                  child: NeoxClayBackdrop(
                    asset: asset,
                    fadeFrom: 0.62,
                    fadeTo: 0.86,
                    fadeTop: true,
                  ),
                ),
                _ClayTextScrim(),
                Positioned(
                  left: NeoxSpace.xl + 4,
                  right: w * NeoxPageHero.titleRightInset(title),
                  bottom: h * 0.12,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        title,
                        maxLines: NeoxPageHero.titleMaxLines(title),
                        overflow: TextOverflow.ellipsis,
                        style:
                            titleStyle ??
                            TextStyle(
                              fontSize: NeoxPageHero.titleSize(title),
                              fontWeight: FontWeight.w700,
                              letterSpacing: -0.4,
                              color: theme.colorScheme.onSurface,
                              height: 1.15,
                            ),
                      ),
                      if (subtitle != null) ...[
                        const SizedBox(height: 6),
                        Text(
                          subtitle!,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                            fontSize: 13,
                            height: 1.4,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}
