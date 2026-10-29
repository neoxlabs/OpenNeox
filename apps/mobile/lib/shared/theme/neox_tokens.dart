/// neox_tokens.dart — Neox 移动端设计系统 token 中心.
///
/// 所有页面/组件应该从这里取值，**禁止**在业务代码里硬编码:
///   - Color(0xFF...)       → 用 NeoxClaudePalette / NeoxDesktopPalette
///   - BorderRadius.circular(N) → 用 NeoxRadius
///   - EdgeInsets.all(N)        → 用 NeoxSpace
///   - TextStyle(...)           → 用 ThemeData.textTheme
///
/// 设计气质 (Claude variant, 默认):
///   - 暖米白基底 (#F5F2EC) + 高阶卡片暖白 (#FAFAF7)
///   - 主操作 = 纯黑近黑胶囊 (#14110D)
///   - 强调色 = 珊瑚 (#E07856), 仅用在 chip/链接/品牌点缀
///   - 衬线宋体 (Noto Serif SC) 用于大标题, Inter 用于正文/UI
library;

import 'package:flutter/material.dart';

// ════════════════════════════════════════════════════════════════
//  Spacing (4-grid)
// ════════════════════════════════════════════════════════════════
class NeoxSpace {
  NeoxSpace._();

  static const double xxs = 2;
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 20; // 页面水平内边距
  static const double xxl = 24;
  static const double xxxl = 32;
  static const double huge = 40;

  /// 页面统一水平内边距 (20)
  static const EdgeInsets pageH = EdgeInsets.symmetric(horizontal: xl);

  /// 列表/卡片群组之间的间距
  static const EdgeInsets sectionGap = EdgeInsets.fromLTRB(xl, xl, xl, sm);
}

// ════════════════════════════════════════════════════════════════
//  Timeline 缩进标尺 — 时间轴上所有行只允许用这两级
// ════════════════════════════════════════════════════════════════
///
/// 之前每个 widget 各写各的魔数 (16 / 22 / 24 / 12 / 28), 同一屏里正文、工具组、
/// 子 agent 痕迹、系统卡的左边缘全对不齐, 看起来像随手拼的 (2026-07-29 明康指出)。
///
/// 直接对齐桌面 `agent-timeline.css`:
///   `.atl-activity__icon { width: 18px }`  → [icon] 固定图标列
///   `.atl-activity__head { gap: 8px }`     → [gap]
///   `.atl-group { padding-left: 10px; border-left: 1.5px }` → [rail] 竖轨表达层级
///
/// **层级不靠深缩进**: 桌面组内只右移 10px + 一条竖轨。手机端之前用 22/24/28 的
/// 深缩进, 嵌两层正文就被挤到屏幕中间。
class NeoxIndent {
  NeoxIndent._();

  /// 一级行左边距 (= 正文左边距, 时间轴的基准竖线)
  static const double gutter = NeoxSpace.lg;

  /// 固定图标列宽 — 没有图标的行也要占, 否则文字起点不齐
  static const double icon = 18;

  /// 图标列与文字之间
  static const double gap = 8;

  /// 组内相对缩进 (配左侧竖轨一起用)
  static const double rail = 10;

  /// 行内文字的绝对起点 — 展开区/续行都对齐到它
  static const double text = gutter + icon + gap;
}

// ════════════════════════════════════════════════════════════════
//  Radius
// ════════════════════════════════════════════════════════════════
/// 圆角词表 —— **只允许这七个值**.
///
/// 2026-09-04 扫出来 64 处硬编码 `BorderRadius.circular(N)`, 用到 2/3/4/5/6/7/
/// 8/9/10/12/14/16/20/28 十几种。十几种等于没有词表: 同一屏上两个同类的东西
/// 圆角差 2px, 说不出为什么, 看着就是"随手写的"。桌面端和官网也是同病
/// (各自八种以上), 这张表是三端要共用的那一张。
///
/// 每个值有职责, 不是等差数列:
///   bar 2   细条 —— 进度条 / 用量条, 它本来就只有 4px 高, 再大就成胶囊了
///   small 6 小件 —— 徽章、缩略图、代码块
///   chip 10 药丸 —— composer chip、标签、图标钮的方底
///   input 14 输入 —— 输入框、主按钮
///   card 20 卡片 —— 内容卡、空态块
///   sheet 28 弹层 —— 底部 sheet 的上圆角
///   pill 999 胶囊 —— 完全圆的两端
class NeoxRadius {
  NeoxRadius._();

  /// 细条 (进度条 / 用量条) — 只有几 px 高的东西
  static const double bar = 2;

  /// 小件 (徽章 / 缩略图 / 代码块)
  static const double small = 6;

  /// chip / tag / 小标签
  static const double chip = 10;

  /// input / field 边框
  static const double input = 14;

  /// 标准卡片 (陶土稿 v5: 泥板 16)
  static const double card = 16;

  /// 弹层底 sheet
  static const double sheet = 28;

  /// 胶囊按钮 (主 CTA)
  static const double pill = 999;

  static const BorderRadius barR = BorderRadius.all(Radius.circular(bar));
  static const BorderRadius smallR = BorderRadius.all(Radius.circular(small));
  static const BorderRadius chipR = BorderRadius.all(Radius.circular(chip));
  static const BorderRadius inputR = BorderRadius.all(Radius.circular(input));
  static const BorderRadius cardR = BorderRadius.all(Radius.circular(card));
  static const BorderRadius sheetR = BorderRadius.vertical(
    top: Radius.circular(sheet),
  );
  static const BorderRadius pillR = BorderRadius.all(Radius.circular(pill));
}

// ════════════════════════════════════════════════════════════════
//  Border / Stroke width
// ════════════════════════════════════════════════════════════════
class NeoxStroke {
  NeoxStroke._();
  static const double hair = 0.5;
  static const double thin = 1;
  static const double medium = 1.5;
  static const double thick = 2;
}

// ════════════════════════════════════════════════════════════════
//  Claude 优雅风 palette (默认 variant)
// ════════════════════════════════════════════════════════════════
class NeoxClaudePalette {
  NeoxClaudePalette._();

  /* 2026-10-14 陶土稿 v5 (artifact 41P2J8jx): 浅陶 = 暖纸画布 #F2EEE8 + 釉面泥板 #FBFAF7 + 墨 #23211E +
   * 灰 #8A847B, 一颗钴蓝。夜陶见下面 dark 段, 不出现纯黑。名字沿用 (全仓几百处在用), 值换成陶土。 */
  // ── Light (浅陶) ──────────────
  /// 全局底色 — 暖纸画布
  static const Color lightBackground = Color(0xFFF2EEE8);

  /// 卡片表面 — 釉面泥板
  static const Color lightSurface = Color(0xFFFBFAF7);

  /// 高阶层 (弹层/sheet)
  static const Color lightSurfaceElev = Color(0xFFFBFAF7);

  /// 主要文字 (墨)
  static const Color lightInk = Color(0xFF23211E);

  /// 次级文字 (陶灰)
  static const Color lightInkMute = Color(0xFF8A847B);

  /// 三级文字 / hint
  static const Color lightInkSubtle = Color(0xFFA39D94);

  /// 卡片描边 (淡, 仅作分界)
  ///
  /// 对白底只有 1.26 —— 这是**故意**的, 它是装饰性分界, WCAG 不管。
  /// ⚠️ 但**交互控件的边界不能用它**, 见 [lightControlBorder]。
  static const Color lightOutline = Color(0xFFE6E0D7);

  /// 更柔和的描边 (分隔线)
  static const Color lightOutlineSoft = Color(0xFFEDE8E0);

  /// 交互控件的边界 (输入框 / 按钮 / 可点的框) — 对白底 3.03.
  ///
  /// 2026-09-04 用户实拍"发虚、粗糙", 量出来底部输入框边框是 lightOutline,
  /// 对白底**只有 1.26**。WCAG 2.1 (1.4.11 Non-text Contrast) 对"识别控件所必需的
  /// 边界"要求 ≥ 3.0 —— 差了近三倍, 这不是审美问题是可判定缺陷。
  ///
  /// 为什么单开一个 token 而不是把 lightOutline 调深: 那条被卡片边、分隔线、
  /// 头像框到处在用, 一起调深会让整页变得又重又脏 —— 装饰性分界本来就不该抢戏。
  /// 分成两个才是"形状跟着形态走": 能点的要看得见边, 只作分界的不必。
  static const Color lightControlBorder = Color(0xFFB9B1A5);

  /// 三级文字 / 占位符的**可读**下限 — 对白底 4.95 (WCAG 正文要求 4.5).
  ///
  /// 原来输入框占位文字实测 #AEADAC = 2.24, 只有要求的一半。
  static const Color lightHint = Color(0xFF8A847B);

  /// chip / 图标钮的填充底 —— 坐在**白面**上 (输入框内、卡片内).
  ///
  /// 2026-09-04: 用户拿豆包和 Claude 做参照, 判词"每一个组件都不协调"。真因是
  /// **我们整屏几乎没有"面", 只有线和字** —— 人家那两张里每个能点的东西都坐在一个
  /// 填充形状上 (药丸 / 圆 / 卡片), 眼睛才能把它们归成一个家族; 我们整屏唯一的填充
  /// 形状是输入框, 其余全是裸图标和裸文字浮在页面上, 彼此之间压根没进同一套词汇。
  static const Color lightChipFill = Color(0xFFEFE9E0);

  /// chip 坐在**页面底**上 (顶栏图标钮) —— 比 lightChipFill 再深一点点才分得开.
  static const Color lightChipOnPage = Color(0xFFE9E3D9);

  static const Color darkChipFill = Color(0xFF2C2823);

  /// 行内代码 / 链接的墨色 (2026-09-17, 对标 Claude 手机端)。
  /// 原来行内代码和正文同色、只靠等宽字体区分, 标识符在段落里认不出来;
  /// 链接取 primary —— 而 primary 在单色主题里就是近黑, 跟正文只差一道下划线。
  /// 蓝灰墨对白底 6.4 / 对 chipFill 5.8, 暗色对 #2A2A2A 7.1, 均过 WCAG 4.5。
  static const Color lightCodeInk = Color(0xFF3B5B8C);
  static const Color darkCodeInk = Color(0xFF9DBAE6);
  static const Color lightLinkInk = Color(0xFF2F63B8);
  static const Color darkLinkInk = Color(0xFF8FB3F0);
  static const Color darkChipOnPage = Color(0xFF2A2622);

  // ── Dark (夜陶: 暖深褐, 不出现纯黑) ─────────────────
  /// 全局底色
  static const Color darkBackground = Color(0xFF1B1916);

  /// 卡片表面 (泥板)
  static const Color darkSurface = Color(0xFF24211D);

  /// 高阶层
  static const Color darkSurfaceElev = Color(0xFF2C2823);

  /// 主要文字
  static const Color darkInk = Color(0xFFEDE8E0);

  /// 次级文字
  static const Color darkInkMute = Color(0xFF8F887E);

  /// 三级文字
  static const Color darkInkSubtle = Color(0xFF6F695F);

  /// 描边 (装饰性分界, 同 lightOutline 的定位)
  static const Color darkOutline = Color(0xFF35302A);
  static const Color darkOutlineSoft = Color(0xFF2C2823);

  /// 交互控件的边界
  static const Color darkControlBorder = Color(0xFF5A5349);

  /// 占位符
  static const Color darkHint = Color(0xFF8F887E);

  // ── Brand / Accent ─────────────────────────────────────
  /// 强调色 —— 陶土稿只有一颗钴蓝 (原珊瑚退役, 名字留着免得几十处调用点一起改)
  static const Color coral = Color(0xFF2F6BFF);

  /// 强调色浅版 — 选中态 / 命中词底色
  static const Color coralSoft = Color(0xFFDCE6FF);

  /// 主 CTA 胶囊 (墨)
  static const Color cta = Color(0xFF23211E);

  /// CTA pressed
  static const Color ctaSoft = Color(0xFF3A3733);

  /// 夜陶下 CTA 反转为浅陶色泥块
  static const Color ctaDark = Color(0xFFEDE8E0);

  // ── Semantic ───────────────────────
  static const Color success = Color(0xFF3FA36B);
  static const Color warning = Color(0xFFE8A23A);
  static const Color danger = Color(0xFFD9534F);
  static const Color info = Color(0xFF2F6BFF);

  // ── Status dot (online / offline 等小圆点) ───────────────
  static const Color online = Color(0xFF3FA36B);
  static const Color busy = Color(0xFFE8A23A);
  static const Color offline = Color(0xFFA39D94);
}

// ════════════════════════════════════════════════════════════════
//  Desktop Indigo palette (后续切换桌面端同款时使用)
// ════════════════════════════════════════════════════════════════
class NeoxDesktopPalette {
  NeoxDesktopPalette._();

  /// 桌面端品牌色 — Indigo 500
  static const Color seed = Color(0xFF6366F1);

  static const Color lightBackground = Color(0xFFFFFFFF);
  static const Color lightSurface = Color(0xFFFAFAFA);
  static const Color lightSurfaceElev = Color(0xFFFFFFFF);

  static const Color darkBackground = Color(0xFF0E0E0E);
  static const Color darkSurface = Color(0xFF1A1A1A);
  static const Color darkSurfaceElev = Color(0xFF222222);
}

/// Neox 自己的品牌色 —— 跟官网、桌面端、陶土插画同一个钴蓝。
///
/// 2026-10-09 用户: 「以前我们都抄别人, 现在想用自己的风格」。陶土插画里每张只有一处蓝
/// (#2F6BFF), 官网主按钮也是它; 引导页和设置页先换过来, 其它页面再逐步跟上。
class NeoxBrand {
  NeoxBrand._();

  static const Color blue = Color(0xFF2F6BFF);

  /// 夜陶下提亮一档的钴蓝
  static const Color blueNight = Color(0xFF5B8CFF);

  /// 钴蓝的面 —— 平的实底 (2026-10-14: 控件不做立体, 跟桌面客户端一样; 之前是渐变 + 投影)
  static BoxDecoration clayBlue(BorderRadius radius) => BoxDecoration(borderRadius: radius, color: blue);
}

/// 陶土插画资源路径。
class NeoxClay {
  NeoxClay._();

  static String of(String name) => 'assets/clay/$name.webp';
}

// ════════════════════════════════════════════════════════════════
//  Animation
// ════════════════════════════════════════════════════════════════
class NeoxMotion {
  NeoxMotion._();

  static const Duration fast = Duration(milliseconds: 120);
  static const Duration normal = Duration(milliseconds: 220);
  static const Duration slow = Duration(milliseconds: 360);

  static const Curve standard = Curves.easeOutCubic;
  static const Curve emphasize = Curves.easeOutBack;
}

/// 控件专用颜色 —— 跟装饰性描边分开取, 免得调用点随手写 `scheme.outline`.
///
/// 2026-09-04: 底部输入条的边框就是这么写坏的 —— `scheme.outline` 对白底 1.26,
/// 用户实拍判词"发虚、粗糙"。WCAG 1.4.11 对"识别控件所必需的边界"要求 ≥3.0。
/// 装饰性分界 (卡片边 / 分隔线) 仍然用 scheme.outline, 那是对的, 它不该抢戏。
extension NeoxControlColors on ColorScheme {
  /// 能点的东西的边 (输入框 / 按钮 / 可点的框) — 对各自底色 ≥3.0.
  Color get controlBorder => brightness == Brightness.light
      ? NeoxClaudePalette.lightControlBorder
      : NeoxClaudePalette.darkControlBorder;

  /// 占位符 / 三级文字的可读下限 — ≥4.5.
  Color get hintInk => brightness == Brightness.light
      ? NeoxClaudePalette.lightHint
      : NeoxClaudePalette.darkHint;

  /// chip / 图标钮坐在**白面**上时的填充底 (输入框内、卡片内).
  Color get chipFill => brightness == Brightness.light
      ? NeoxClaudePalette.lightChipFill
      : NeoxClaudePalette.darkChipFill;

  /// 行内代码文字色 (底用 chipFill).
  Color get codeInk => brightness == Brightness.light
      ? NeoxClaudePalette.lightCodeInk
      : NeoxClaudePalette.darkCodeInk;

  /// 正文里的链接色.
  Color get linkInk => brightness == Brightness.light
      ? NeoxClaudePalette.lightLinkInk
      : NeoxClaudePalette.darkLinkInk;

  /// chip / 图标钮坐在**页面底**上时的填充底 (顶栏).
  Color get chipOnPage => brightness == Brightness.light
      ? NeoxClaudePalette.lightChipOnPage
      : NeoxClaudePalette.darkChipOnPage;

  /* ── 语义色 (2026-09-18) ──────────────────────────────────────────
   *
   * 为什么不能继续用 Colors.green.shade700 那一套: Material 的 shadeN **深浅主题下是
   * 同一个值**。#388E3C 在浅底 (#F5F5F4) 上对比 4.3 勉强够, 放到近黑底 (#0F0F0F) 上
   * 只有 3.0 —— 而工具卡里的 ✓/✗、diff 的 +/− 全靠这个颜色区分成败, 深色下就变成
   * "看得见但读不准"。仓里有 20 多处这么写。
   *
   * 这几个 getter 按 brightness 给两套值: 浅色用深一档保证对比, 深色用亮一档。 */

  /// 成功 / diff 新增
  Color get okInk => brightness == Brightness.light
      ? const Color(0xFF2E8A55)
      : const Color(0xFF5DBB85);

  /// 失败 / diff 删除
  Color get errInk => brightness == Brightness.light
      ? const Color(0xFFC9423E)
      : const Color(0xFFE07070);

  /// 等你 / 需注意 —— 琥珀
  Color get warnInk => brightness == Brightness.light
      ? const Color(0xFFC07F12)
      : const Color(0xFFE8A23A);
}

/// 等宽字体 —— 全 app 唯一真相源.
///
/// 【为什么不能只写 'monospace'】
/// 2026-09-18: 仓里 37 处各自写死 Android 的通用族名 'monospace'。那个名字
/// Flutter 在 iOS 上解析不了它 —— 行内代码、工具参数、配对码这些地方在 iOS 上会静默
/// 退回系统默认字体, 等宽外观全丢 (代码和路径挤在一起读不齐)。
/// 而它不会报错, 只是长得不对, 所以没人发现。
///
/// 做法: 主字体给 Android 的 'monospace', fallback 列表里放各平台真实存在的等宽字体。
/// Flutter 会按顺序找第一个能渲出该字形的。
class NeoxMono {
  NeoxMono._();

  /// 主族名 (Android 认这个)
  static const String family = 'monospace';

  /// 回退链 —— iOS/macOS 的 Menlo、其它平台常见的等宽族
  static const List<String> fallback = <String>[
    'Menlo',            // iOS / macOS 自带
    'SF Mono',          // 较新的 Apple 平台
    'Roboto Mono',      // Android
    'DejaVu Sans Mono', // Linux
    'Courier New',      // 最后兜底, 基本处处都有
  ];
}
