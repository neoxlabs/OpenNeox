/// app_theme.dart — Neox Material 3 主题, 支持两种气质 variant.
///
/// **设计气质 (Claude variant, 默认)**:
///   - 暖米白基底 (#F5F2EC) + 卡片暖白 (#FAFAF7)
///   - 主操作 = 近黑胶囊 (#14110D)
///   - 强调色 = 珊瑚 (#E07856), 仅用在 chip/链接/品牌点缀
///   - 大标题用 Noto Serif SC (中文衬线), UI 用 Inter
///
/// **Desktop variant**: 与 Neox Desktop 一致的 Indigo 风, 保留切换能力.
///
/// **设计准则**:
///   - 所有页面应从 NeoxTokens / theme.colorScheme / theme.textTheme 取值
///   - 禁止业务代码硬编码颜色/圆角/字号 (见 NeoxTokens 文档)
///   - 暗色 surface 维持暖灰 (claude) / 中性灰 (desktop, R=G=B)
library;

import 'package:flutter/material.dart';

import 'neox_tokens.dart';
import 'theme_variant_provider.dart';

/// 本地字体 family 名 — 跟 pubspec.yaml `fonts:` 段对齐.
/// NotoSerifSC: 中文衬线宋体 (Regular 400 / SemiBold 600), 用于大标题
/// NeoxRounded: Resource Han Rounded, 中英同一套 —— 跟桌面端正文完全一致, 用于 UI/正文
/// Inter: 只做兜底 (弯引号 ‘’“” 从圆体里去掉了, 落到它; 同桌面 unicode-range)
///
/// 2026-09-24 之前正文是 Inter + **NotoSerifSC 兜中文**: 英文句子里夹一个「富士山」
/// 就蹦出三个宋体字, 中文界面则整屏都是衬线 —— 跟桌面的圆体两个样子 (用户:
/// 「字体还差点意思…工具字体和 message 字体协调, 我们 pc 客户端字体也不错」)。
const String _kFontSans = 'NeoxRounded';
const String _kFontLatinFallback = 'Inter';

class AppTheme {
  AppTheme._();

  /* ThemeData 缓存 —— 2026-09-22.
   *
   * [build] 一次要跑 _buildScheme + _buildTextTheme + _composeTheme, 而 ThemeData
   * 的构造在 Flutter 里本身就不便宜; app.dart 里 light / dark **两个**都要构造,
   * 于是每次 NeoxApp 重建 (主题 / 亮度 / 字体缩放任一变化都会触发) 就是两遍完整
   * 构造。variant × brightness 的组合总共只有那么几个, 缓存住。
   *
   * 用 record 做键: Dart 的 record 按**值**相等, 正好是这里要的语义。 */
  static final Map<(ThemeVariant, Brightness), ThemeData> _cache = {};

  /// 按 variant + brightness 构建 ThemeData (带缓存).
  /// 外层 ConsumerWidget watch (themeVariantProvider, themeModeProvider) 后调用.
  static ThemeData build({
    required ThemeVariant variant,
    required Brightness brightness,
  }) {
    return _cache.putIfAbsent((variant, brightness), () {
      final scheme = _buildScheme(variant, brightness);
      final textTheme = _buildTextTheme(variant, scheme);
      return _composeTheme(
        scheme: scheme,
        textTheme: textTheme,
        variant: variant,
      );
    });
  }

  // 旧 API 兼容 (其他代码可能直接 import AppTheme.light/dark)
  static ThemeData get light =>
      build(variant: ThemeVariant.claude, brightness: Brightness.light);

  static ThemeData get dark =>
      build(variant: ThemeVariant.claude, brightness: Brightness.dark);

  // ── 旧调用兼容: 保留 seedColor 常量供仍引用的代码 ──
  static const Color seedColor = NeoxDesktopPalette.seed;
  static const Color darkSurface = NeoxClaudePalette.darkSurface;
  static const Color darkSurfaceContainer = NeoxClaudePalette.darkSurfaceElev;
  static const Color darkBackground = NeoxClaudePalette.darkBackground;
  static const Color lightSurface = NeoxClaudePalette.lightSurface;
  static const Color lightBackground = NeoxClaudePalette.lightBackground;

  // ────────────────────────────────────────────────────────
  //  ColorScheme 构建
  // ────────────────────────────────────────────────────────
  static ColorScheme _buildScheme(ThemeVariant variant, Brightness brightness) {
    switch (variant) {
      case ThemeVariant.claude:
        return _claudeScheme(brightness);
      case ThemeVariant.desktop:
        return _desktopScheme(brightness);
    }
  }

  static ColorScheme _claudeScheme(Brightness brightness) {
    final isLight = brightness == Brightness.light;
    /* 取一个简短别名给后面的颜色访问 — typedef 不能用在静态变量名空间, 直接展开 */
    const cta = NeoxClaudePalette.cta;
    const ctaDark = NeoxClaudePalette.ctaDark;
    const coral = NeoxClaudePalette.coral;
    const coralSoft = NeoxClaudePalette.coralSoft;
    const danger = NeoxClaudePalette.danger;
    const lightSurface = NeoxClaudePalette.lightSurface;
    const lightSurfaceElev = NeoxClaudePalette.lightSurfaceElev;
    const lightBackground = NeoxClaudePalette.lightBackground;
    const lightInk = NeoxClaudePalette.lightInk;
    const lightInkMute = NeoxClaudePalette.lightInkMute;
    const lightOutline = NeoxClaudePalette.lightOutline;
    const lightOutlineSoft = NeoxClaudePalette.lightOutlineSoft;
    const darkSurface = NeoxClaudePalette.darkSurface;
    const darkSurfaceElev = NeoxClaudePalette.darkSurfaceElev;
    const darkBackground = NeoxClaudePalette.darkBackground;
    const darkInk = NeoxClaudePalette.darkInk;
    const darkInkMute = NeoxClaudePalette.darkInkMute;
    const darkOutline = NeoxClaudePalette.darkOutline;
    const darkOutlineSoft = NeoxClaudePalette.darkOutlineSoft;

    if (isLight) {
      return ColorScheme(
        brightness: Brightness.light,
        // primary = 近黑 (主操作 CTA), 而非 coral — Claude 风的主按钮是黑胶囊
        primary: cta,
        onPrimary: lightSurfaceElev,
        primaryContainer: const Color(0xFFEFE9E0), // 陶土浅底
        onPrimaryContainer: lightInk,
        // secondary = 钴蓝 (强调), 用在进行中 / 命中词
        secondary: coral,
        onSecondary: Colors.white,
        secondaryContainer: coralSoft,
        onSecondaryContainer: const Color(0xFF14306E),
        // tertiary = 文字链接
        tertiary: lightInk,
        onTertiary: Colors.white,
        tertiaryContainer: const Color(0xFFEFE9E0),
        onTertiaryContainer: lightInk,
        // error
        error: danger,
        onError: Colors.white,
        errorContainer: const Color(0xFFF8E1DF),
        onErrorContainer: const Color(0xFF5A1A17),
        // surface tier
        surface: lightSurface,
        onSurface: lightInk,
        onSurfaceVariant: lightInkMute,
        surfaceContainerLowest: lightBackground,
        surfaceContainerLow: lightBackground,
        surfaceContainer: lightSurface,
        surfaceContainerHigh: lightSurfaceElev,
        surfaceContainerHighest: lightSurfaceElev,
        surfaceTint: Colors.transparent, // 关闭 M3 surface tint
        // outline
        outline: lightOutline,
        outlineVariant: lightOutlineSoft,
        // shadow / inverse
        shadow: const Color(0x14000000),
        scrim: const Color(0x99000000),
        inverseSurface: darkSurface,
        onInverseSurface: darkInk,
        inversePrimary: ctaDark,
      );
    }

    // Dark
    return ColorScheme(
      brightness: Brightness.dark,
      primary: ctaDark, // dark mode 下主操作反转为中性亮白
      onPrimary: cta,
      primaryContainer: const Color(0xFF2C2823),
      onPrimaryContainer: darkInk,
      secondary: NeoxBrand.blueNight,
      onSecondary: Colors.white,
      secondaryContainer: const Color(0xFF1E2A4A),
      onSecondaryContainer: const Color(0xFFC9D8FF),
      tertiary: darkInk,
      onTertiary: const Color(0xFF1B1916),
      tertiaryContainer: const Color(0xFF2C2823),
      onTertiaryContainer: darkInk,
      error: const Color(0xFFE07070),
      onError: const Color(0xFF2A0A08),
      errorContainer: const Color(0xFF4A1E1B),
      onErrorContainer: const Color(0xFFF8E1DF),
      surface: darkSurface,
      onSurface: darkInk,
      onSurfaceVariant: darkInkMute,
      surfaceContainerLowest: darkBackground,
      surfaceContainerLow: darkBackground,
      surfaceContainer: darkSurface,
      surfaceContainerHigh: darkSurfaceElev,
      surfaceContainerHighest: darkSurfaceElev,
      surfaceTint: Colors.transparent,
      outline: darkOutline,
      outlineVariant: darkOutlineSoft,
      shadow: const Color(0x33000000),
      scrim: const Color(0x99000000),
      inverseSurface: lightSurface,
      onInverseSurface: lightInk,
      inversePrimary: cta,
    );
  }

  static ColorScheme _desktopScheme(Brightness brightness) {
    final isLight = brightness == Brightness.light;
    final base = ColorScheme.fromSeed(
      seedColor: NeoxDesktopPalette.seed,
      brightness: brightness,
    );
    if (isLight) {
      return base.copyWith(
        surface: NeoxDesktopPalette.lightSurface,
        surfaceContainer: NeoxDesktopPalette.lightSurface,
        surfaceContainerHigh: NeoxDesktopPalette.lightSurfaceElev,
        surfaceTint: Colors.transparent,
      );
    }
    // dark — 强制中性灰 (R=G=B)
    return base.copyWith(
      surface: NeoxDesktopPalette.darkSurface,
      surfaceContainerLowest: NeoxDesktopPalette.darkBackground,
      surfaceContainerLow: NeoxDesktopPalette.darkSurface,
      surfaceContainer: NeoxDesktopPalette.darkSurface,
      surfaceContainerHigh: NeoxDesktopPalette.darkSurfaceElev,
      surfaceContainerHighest: const Color(0xFF323232),
      onSurface: const Color(0xFFE6E6E6),
      onSurfaceVariant: const Color(0xFFB8B8B8),
      outline: const Color(0xFF4A4A4A),
      outlineVariant: const Color(0xFF333333),
      surfaceTint: Colors.transparent,
    );
  }

  // ────────────────────────────────────────────────────────
  //  TextTheme — 全本地字体 (NotoSerifSC + Inter), 不走外网
  // ────────────────────────────────────────────────────────
  static TextTheme _buildTextTheme(ThemeVariant variant, ColorScheme scheme) {
    /* 陶土稿 v5 (2026-10-14): 标题全部用圆体加粗 (「下午好，lmk」「系统更新」都是无衬线粗体), 衬线退役 */
    final ink = scheme.onSurface;
    final mute = scheme.onSurfaceVariant;

    /* fontFamilyFallback 按列表顺序找能显示该 codepoint 的字体.
     * 圆体本身中英都有; 缺的只有弯引号 (刻意去掉的) → Inter。GB2312 以外的生僻字
     * 再往后落到系统无衬线 —— 不再落到宋体, 否则正文里会突然冒出一个衬线字。 */
    const sansFamily = _kFontSans;
    const sansFallback = [_kFontLatinFallback];

    /* 原「衬线标题」入口留着名字 (下面字阶表按它分档), 字体已换成圆体 */
    TextStyle serif(
      double size,
      FontWeight w,
      double h, {
      double letterSpacing = 0,
      Color? color,
    }) {
      return TextStyle(
        fontFamily: sansFamily,
        fontFamilyFallback: sansFallback,
        leadingDistribution: TextLeadingDistribution.even,
        fontSize: size,
        fontWeight: w,
        height: h,
        letterSpacing: letterSpacing,
        color: color ?? ink,
      );
    }

    TextStyle sans(
      double size,
      FontWeight w,
      double h, {
      double letterSpacing = 0,
      Color? color,
    }) {
      return TextStyle(
        fontFamily: sansFamily,
        fontFamilyFallback: sansFallback,
        fontSize: size,
        fontWeight: w,
        height: h,
        letterSpacing: letterSpacing,
        /* 圆体 ascent 偏高, 行距均分才居中 (见 markdown_view.markdownBaseStyle) */
        leadingDistribution: TextLeadingDistribution.even,
        color: color ?? ink,
      );
    }

    /* 字阶整体上调一档 (2026-09-04).
     *
     * 用户拿豆包和 Claude 手机端做参照, 判词"头小, 整个都不协调"。量下来他是对的
     * —— 换算成占屏宽的百分比 (跨设备可比):
     *
     *   正文墨迹高:  Claude 4.77%  ·  豆包 4.03%  ·  我们 3.48%
     *
     * 我们的正文 14.5pt 在 402pt 宽的屏上是最小的一档。小字铺在大片空白上, 读起来
     * 是"没做完的网页"而不是 app。这不是审美偏好, 是两家都在 4% 以上而我们不到 3.5%。
     *
     * 调法是**整条曲线一起抬**, 不是只改正文 —— 只抬正文会把标题和正文的层级压平。
     * 正文 14.5→16 (≈3.9%), 其余按同一比例走。 */
    /* 陶土稿 v5 字阶: 12 · 13 · 15 · 16 · 20 · 24 · 28 (列表行 15, 标题 16, 页标题 24, 问候 28)。
     * 正文 15.5: 稿上对话正文 15, 但 09-04 用户嫌字小 (占屏宽 3.5% < 4%), 折中半档。 */
    return TextTheme(
      // ── Display (Hero) ──
      displayLarge: serif(40, FontWeight.w700, 1.15, letterSpacing: -0.4),
      displayMedium: serif(34, FontWeight.w700, 1.2, letterSpacing: -0.3),
      displaySmall: serif(30, FontWeight.w700, 1.22),

      // ── Headline (问候 28 / 页标题 24) ──
      headlineLarge: serif(28, FontWeight.w700, 1.25, letterSpacing: -0.2),
      headlineMedium: serif(24, FontWeight.w700, 1.3),
      headlineSmall: serif(22, FontWeight.w700, 1.3),

      // ── Title ──
      titleLarge: serif(20, FontWeight.w700, 1.3),
      titleMedium: sans(16, FontWeight.w700, 1.35),
      titleSmall: sans(15, FontWeight.w600, 1.4),

      // ── Body ──
      bodyLarge: sans(16, FontWeight.w400, 1.6),
      bodyMedium: sans(15.5, FontWeight.w400, 1.6),
      bodySmall: sans(13, FontWeight.w400, 1.5, color: mute),

      // ── Label ──
      labelLarge: sans(15, FontWeight.w500, 1.2, letterSpacing: 0.1),
      labelMedium: sans(13, FontWeight.w500, 1.2, letterSpacing: 0.1),
      labelSmall: sans(
        12,
        FontWeight.w500,
        1.2,
        letterSpacing: 0.2,
        color: mute,
      ),
    );
  }

  // ────────────────────────────────────────────────────────
  //  ThemeData 组装
  // ────────────────────────────────────────────────────────
  static ThemeData _composeTheme({
    required ColorScheme scheme,
    required TextTheme textTheme,
    required ThemeVariant variant,
  }) {
    final isLight = scheme.brightness == Brightness.light;
    /* 交互控件的边界 / 占位符 —— 跟装饰性描边分开的两个 token, 理由见 neox_tokens.dart:
     * WCAG 只约束"识别控件所必需的边界"(≥3.0) 和正文(≥4.5), 卡片边和分隔线不在其内。
     * 混用一个色的后果是: 要么控件看不见 (改之前, 边框 1.26), 要么整页变重。 */
    final controlBorder = isLight
        ? NeoxClaudePalette.lightControlBorder
        : NeoxClaudePalette.darkControlBorder;
    final hintColor = isLight
        ? NeoxClaudePalette.lightHint
        : NeoxClaudePalette.darkHint;
    return ThemeData(
      useMaterial3: true,
      brightness: scheme.brightness,
      colorScheme: scheme,
      textTheme: textTheme,
      /* 换页两端都用 iOS 那套 (2026-10-11 用户: 「每一次切换都跟 iOS 一样丝滑」): 新页从右边推进来、旧页往左让一点,
       * 左边缘右滑能拖着返回。安卓默认的 Zoom 放大 + 淡入在中低端机上掉帧, 也跟手势返回对不上 */
      pageTransitionsTheme: const PageTransitionsTheme(builders: {
        TargetPlatform.android: CupertinoPageTransitionsBuilder(),
        TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
      }),
      /* 页面底 = surfaceContainerLowest (浅色 #F5F5F4 / 暗色 #0F0F0F),
       * **不是** scheme.surface。
       *
       * 2026-09-04 用户拿 Claude 的输入框做参照说"人家充满质感"。量下来差别不在
       * 描边也不在圆角, 在**分层**:
       *   Claude: 页面 #F9F9F7 微灰, 输入框纯白浮在上面, 描边几乎没有 (对比 1.05)
       *   我们:   页面 / 卡片 / 输入框 **全是纯白**, 三层对比度 1.000
       * 也就是说我们根本没有"面"的层次, 只能靠一根线撑, 那根线再淡就成了"发虚"。
       *
       * token 里 lightBackground(#F5F5F4) 本来就定义好了, 只是这一行把页面底
       * 写成了 scheme.surface (卡片色), 于是那个值从来没被用过。 */
      scaffoldBackgroundColor: scheme.surfaceContainerLowest,
      canvasColor: scheme.surface,

      // AppBar — 大标题样式由 NeoxScaffold 自己控制, 全局只给基础透明
      appBarTheme: AppBarTheme(
        backgroundColor: scheme.surface,
        foregroundColor: scheme.onSurface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: textTheme.titleLarge,
        iconTheme: IconThemeData(color: scheme.onSurface, size: 22),
      ),

      /* 返回键全 app 一个样子: 跟 NeoxScaffold 的「<」一致。
       * 走查发现 工作区/云端任务 (系统 AppBar) 是 Android 默认的「←」, 设置页是「<」,
       * 同一个 app 里两种返回键。 */
      actionIconTheme: ActionIconThemeData(
        backButtonIconBuilder: (_) =>
            const Icon(Icons.arrow_back_ios_new, size: 20),
      ),

      // Card — Claude 风大圆角 + 淡描边 + 零阴影
      cardTheme: CardThemeData(
        color: scheme.surfaceContainerHigh,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: NeoxRadius.cardR,
          side: BorderSide(
            color: scheme.outline.withValues(alpha: isLight ? 0.6 : 0.5),
            width: NeoxStroke.hair,
          ),
        ),
      ),

      // NavigationBar (底 tab)
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: scheme.surface,
        indicatorColor: scheme.primary.withValues(alpha: 0.08),
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        height: 64,
        labelTextStyle: WidgetStatePropertyAll(
          textTheme.labelSmall?.copyWith(
            fontSize: 11,
            letterSpacing: 0.2,
            color: scheme.onSurfaceVariant,
          ),
        ),
        iconTheme: WidgetStateProperty.resolveWith((states) {
          final selected = states.contains(WidgetState.selected);
          return IconThemeData(
            size: 22,
            color: selected ? scheme.onSurface : scheme.onSurfaceVariant,
          );
        }),
      ),

      // FilledButton (Primary CTA) — 黑胶囊
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: scheme.primary,
          foregroundColor: scheme.onPrimary,
          shape: const StadiumBorder(),
          textStyle: textTheme.labelLarge,
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
          minimumSize: const Size(0, 44),
        ),
      ),

      // OutlinedButton (Secondary)
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: scheme.onSurface,
          side: BorderSide(color: scheme.outline, width: NeoxStroke.thin),
          shape: const StadiumBorder(),
          textStyle: textTheme.labelLarge,
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
          minimumSize: const Size(0, 44),
        ),
      ),

      // TextButton (Ghost link)
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: scheme.tertiary,
          textStyle: textTheme.labelLarge,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        ),
      ),

      /* Input
       *
       * 2026-09-04: 边框和占位文字都从"装饰色"换成**控件专用色**。
       *   改之前: 边框 scheme.outline 对白底 1.26, 占位 onSurfaceVariant×0.7 = 2.24
       *   改之后: 边框 3.03, 占位 4.95
       * WCAG 1.4.11 对"识别控件所必需的边界"要求 ≥3.0, 正文 ≥4.5 —— 之前两条都不合格,
       * 用户实拍判词是"发虚、粗糙", 量出来确实差近三倍。
       * 卡片边 / 分隔线仍然用 scheme.outline (装饰性分界不该抢戏), 见 neox_tokens 注释。 */
      inputDecorationTheme: InputDecorationTheme(
        filled: false,
        border: OutlineInputBorder(
          borderRadius: NeoxRadius.inputR,
          borderSide: BorderSide(color: controlBorder, width: NeoxStroke.thin),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: NeoxRadius.inputR,
          borderSide: BorderSide(color: controlBorder, width: NeoxStroke.thin),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: NeoxRadius.inputR,
          borderSide: BorderSide(
            color: scheme.onSurface,
            width: NeoxStroke.medium,
          ),
        ),
        hintStyle: textTheme.bodyMedium?.copyWith(color: hintColor),
      ),

      // Switch — primary 色
      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.selected)) return scheme.onPrimary;
          return isLight ? Colors.white : scheme.onSurfaceVariant;
        }),
        /* 陶土稿: 开着 = 墨色轨道, 关着 = 陶土浅槽; 一律不用蓝 */
        trackColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.selected)) return scheme.primary;
          return isLight ? const Color(0xFFE3DDD3) : const Color(0xFF3A352F);
        }),
        trackOutlineColor: const WidgetStatePropertyAll(Colors.transparent),
      ),

      // Divider
      dividerTheme: DividerThemeData(
        color: scheme.outlineVariant,
        thickness: NeoxStroke.hair,
        space: 0,
      ),

      /* 对话框 —— 一块泥板 (陶土稿 v5): 泥板色、圆角 24、标题圆体粗 */
      dialogTheme: DialogThemeData(
        backgroundColor: scheme.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 6,
        shadowColor: const Color(0x33402D19),
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(24))),
        titleTextStyle: textTheme.titleLarge?.copyWith(fontSize: 19),
        contentTextStyle: textTheme.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
      ),

      /* 弹出菜单 / 提示 —— 泥板色 */
      popupMenuTheme: PopupMenuThemeData(
        color: scheme.surface,
        surfaceTintColor: Colors.transparent,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(16))),
      ),

      // Bottom sheet — 大圆角顶
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: scheme.surfaceContainerHigh,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: const RoundedRectangleBorder(borderRadius: NeoxRadius.sheetR),
      ),

      // Snackbar — 浮于底部, 圆角胶囊感
      snackBarTheme: SnackBarThemeData(
        backgroundColor: scheme.inverseSurface,
        contentTextStyle: textTheme.bodyMedium?.copyWith(
          color: scheme.onInverseSurface,
        ),
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(NeoxRadius.input),
        ),
      ),

      // Splash / InkWell — Claude 风用极淡的水波
      splashFactory: InkSparkle.splashFactory,
    );
  }
}
