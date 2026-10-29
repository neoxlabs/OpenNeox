/// clay.dart — 手机端的组件库 (2026-10-14, 稿: claude.ai/artifact/41P2J8jxnJHR6LA3Fv66gV).
///
/// **控件是平的** —— 跟桌面客户端设置页同一个做法 (「设置内全面去 3D」): 没有渐变、没有投影、
/// 没有顶边高光、按下不下沉; 层次只靠底色深浅。立体陶土只留给插画 ([ClayArt])。
/// (2026-10-14 用户看了 v5 初版: 「我们客户端的设置页面…是没有这种立体感的按钮的」)
///
///   画布 canvas  浅陶底
///   面   slab    比画布亮一档的卡片面 ([ClaySlab])
///   填充 fill    比面暗一档: 图标方块 [ClayTile]、次按钮、未选中的胶囊、分段槽
///   墨   ink     主按钮 / 选中, 一屏只有一个墨色
///
/// 颜色一律从 [ClayInk] 取 (按亮度给浅陶 / 夜陶两套), 不在页面里写色值。
/// 历史名字 (slabTop/Bottom、clayTop/Bottom、primaryTop/Bottom、clayShadow) 保留, 但都已经是平的:
/// 上下两色相同、影子为空 —— 页面里旧写法不用改也是平的。
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/neox_tokens.dart';

// ════════════════════════════════════════════════════════════════
//  色
// ════════════════════════════════════════════════════════════════

/// 陶土稿的色 —— 浅陶 / 夜陶各一套.
class ClayInk {
  const ClayInk._(this.dark);

  final bool dark;

  static ClayInk of(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark ? _night : _day;

  static const _day = ClayInk._(false);
  static const _night = ClayInk._(true);

  /// 画布 (页面底)
  Color get canvas => dark ? const Color(0xFF1B1916) : const Color(0xFFF2EEE8);

  /// 泥板 (卡片面)
  Color get slab => dark ? const Color(0xFF24211D) : const Color(0xFFFBFAF7);

  /// 填充: 比面暗一档 (图标方块 / 次按钮 / 未选中胶囊)
  Color get fill => dark ? const Color(0xFF312C27) : const Color(0xFFEBE6DE);

  /// 按下时盖一层
  Color get press => dark ? const Color(0x14FFFFFF) : const Color(0x0F23211E);

  /// (平了) 原来的泥板渐变上 / 下 —— 现在都等于面色
  Color get slabTop => slab;
  Color get slabBottom => slab;

  /// (平了) 原来的顶边高光
  Color get highlight => const Color(0x00000000);

  /// (平了) 原来的暖色软影
  Color get shadowNear => const Color(0x00000000);
  Color get shadowFar => const Color(0x00000000);

  /// 墨 / 灰 / 浅灰
  Color get ink => dark ? const Color(0xFFEDE8E0) : const Color(0xFF23211E);
  Color get grey => dark ? const Color(0xFF8F887E) : const Color(0xFF8A847B);
  Color get faint => dark ? const Color(0xFF6F695F) : const Color(0xFFA39D94);

  /// 分隔线
  Color get line => dark ? const Color(0xFF35302A) : const Color(0xFFE6E0D7);
  Color get hairline => dark ? const Color(0xFF2E2A25) : const Color(0xFFEDE8E0);

  /// 暖色块 (用户消息 / 陶土浅底 / 分段槽)
  Color get tint => dark ? const Color(0xFF2C2823) : const Color(0xFFEFE9E0);

  /// 凹进去的井 (命令 / 代码 / 输入格)
  Color get well => dark ? const Color(0xFF151311) : const Color(0xFFEFEAE2);
  Color get wellEdge => dark ? const Color(0x33000000) : const Color(0x14402D19);

  /// 一颗钴蓝
  Color get cobalt => dark ? NeoxBrand.blueNight : NeoxBrand.blue;
  Color get cobaltSoft => dark ? const Color(0xFF1E2A4A) : const Color(0xFFDCE6FF);

  /// 状态色
  Color get amber => const Color(0xFFE8A23A);
  Color get amberSoft => dark ? const Color(0xFF3A2E1A) : const Color(0xFFFBEFD9);
  Color get amberInk => dark ? const Color(0xFFE8A23A) : const Color(0xFFB0700C);
  Color get green => dark ? const Color(0xFF5DBB85) : const Color(0xFF3FA36B);
  Color get greenSoft => dark ? const Color(0xFF1C3326) : const Color(0xFFE2F2E8);
  Color get greenInk => dark ? const Color(0xFF5DBB85) : const Color(0xFF2E8A55);
  Color get red => dark ? const Color(0xFFE07070) : const Color(0xFFD9534F);
  Color get redSoft => dark ? const Color(0xFF3A1F1C) : const Color(0xFFF8E3E1);
  Color get redInk => dark ? const Color(0xFFE07070) : const Color(0xFFC9423E);

  /// 主按钮 (墨) —— 夜陶反转成浅色; 实底, 上下同色
  Color get primary => dark ? const Color(0xFFEDE8E0) : const Color(0xFF23211E);
  Color get primaryTop => primary;
  Color get primaryBottom => primary;
  Color get onPrimary => dark ? const Color(0xFF23211E) : const Color(0xFFFBFAF7);

  /// (平了) 次按钮 / 方块 —— 都等于填充色
  Color get clayTop => fill;
  Color get clayBottom => fill;

  /// 弹层背后的暗幕
  Color get scrim => dark ? const Color(0x99000000) : const Color(0x66302418);
}

/// 控件不投影 (平的)。留着这个名字, 页面里的旧调用都拿到空影子。
/// 真要浮起来的只有弹层 / 浮在图片上的气泡, 用 [clayFloatShadow]。
List<BoxShadow> clayShadow(ClayInk c, {double lift = 1}) => const [];

/// 浮在别的内容上的东西 (弹层、场景上的气泡、悬浮按钮): 一道很淡的影子, 只为跟底下分开
List<BoxShadow> clayFloatShadow(ClayInk c) => [
      BoxShadow(color: c.dark ? const Color(0x66000000) : const Color(0x1A302418), blurRadius: 16, offset: const Offset(0, 4)),
    ];

// ════════════════════════════════════════════════════════════════
//  面 (卡片)
// ════════════════════════════════════════════════════════════════

/// 卡片: 比画布亮一档的平面, 不描边不投影. 可点时按下盖一层淡墨.
class ClaySlab extends StatefulWidget {
  const ClaySlab({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.radius = 16,
    this.onTap,
    this.onLongPress,
    this.lift = 1,
    this.color,
    this.clip = false,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final double radius;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;

  /// 抬起程度: 0 = 贴在画布上 (只有渐变和高光), 1 = 标准, 1.6 = 选中浮起
  final double lift;

  /// 覆盖面色 (如淡红错误底); 给了就不画渐变
  final Color? color;

  /// 裁切子内容 (缩略图贴边时)
  final bool clip;

  @override
  State<ClaySlab> createState() => _ClaySlabState();
}

class _ClaySlabState extends State<ClaySlab> {
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final r = BorderRadius.circular(widget.radius);
    final tappable = widget.onTap != null || widget.onLongPress != null;
    Widget body = Padding(padding: widget.padding, child: widget.child);
    if (widget.clip) body = ClipRRect(borderRadius: r, child: body);
    /* 平的面: 一个底色; 按下时盖一层淡墨, 不下沉 */
    final slab = AnimatedContainer(
      duration: const Duration(milliseconds: 100),
      decoration: BoxDecoration(borderRadius: r, color: widget.color ?? c.slab),
      foregroundDecoration: _down ? BoxDecoration(borderRadius: r, color: c.press) : null,
      child: body,
    );
    if (!tappable) return slab;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTapDown: (_) => setState(() => _down = true),
      onTapUp: (_) => setState(() => _down = false),
      onTapCancel: () => setState(() => _down = false),
      onTap: widget.onTap,
      onLongPress: widget.onLongPress == null
          ? null
          : () {
              HapticFeedback.selectionClick();
              widget.onLongPress!();
            },
      child: slab,
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  陶土方块 (图标底座)
// ════════════════════════════════════════════════════════════════

/// 图标坐的方块. 36 (列表行) / 28 (小) / 更大用于菜单大方块.
/// 状态只用右下角 [bead] 一颗小珠, 不给整块上色.
class ClayTile extends StatelessWidget {
  const ClayTile({
    super.key,
    this.icon,
    this.child,
    this.size = 36,
    this.bead,
    this.iconColor,
    this.raised = true,
  });

  final IconData? icon;
  final Widget? child;
  final double size;
  final Color? bead;
  final Color? iconColor;

  /// 选中 / 浮起 (侧栏当前入口)
  final bool raised;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final radius = BorderRadius.circular(size >= 34 ? 12 : 10);
    final glyph = child ??
        Icon(icon, size: size * 0.52, color: iconColor ?? c.ink, weight: 300);
    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          /* 平的方块: 填充色底 + 线条图标 */
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(borderRadius: radius, color: c.fill),
              child: Center(child: glyph),
            ),
          ),
          if (bead != null)
            Positioned(
              right: -2,
              bottom: -2,
              child: Container(
                width: size >= 34 ? 10 : 8,
                height: size >= 34 ? 10 : 8,
                decoration: BoxDecoration(
                  color: bead,
                  shape: BoxShape.circle,
                  border: Border.all(color: c.slab, width: 1.5),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  按钮
// ════════════════════════════════════════════════════════════════

enum ClayButtonKind { ink, clay, text, danger }

enum ClayButtonSize { small, regular, large }

/// 有厚度的按钮. 墨色主按钮带顶光和下方投影, 陶土次按钮; 按下沉 1px、影子收短 (120ms).
class ClayButton extends StatefulWidget {
  const ClayButton({
    super.key,
    required this.label,
    required this.onTap,
    this.kind = ClayButtonKind.clay,
    this.size = ClayButtonSize.regular,
    this.icon,
    this.expand = false,
    this.busy = false,
  });

  const ClayButton.ink({
    super.key,
    required this.label,
    required this.onTap,
    this.size = ClayButtonSize.regular,
    this.icon,
    this.expand = false,
    this.busy = false,
  }) : kind = ClayButtonKind.ink;

  final String label;
  final VoidCallback? onTap;
  final ClayButtonKind kind;
  final ClayButtonSize size;
  final IconData? icon;
  final bool expand;
  final bool busy;

  @override
  State<ClayButton> createState() => _ClayButtonState();
}

class _ClayButtonState extends State<ClayButton> {
  bool _down = false;

  double get _h => switch (widget.size) {
        ClayButtonSize.small => 32,
        ClayButtonSize.regular => 40,
        ClayButtonSize.large => 48,
      };

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final enabled = widget.onTap != null && !widget.busy;
    final isInk = widget.kind == ClayButtonKind.ink;
    final isText = widget.kind == ClayButtonKind.text;
    final fg = switch (widget.kind) {
      ClayButtonKind.ink => c.onPrimary,
      ClayButtonKind.danger => c.redInk,
      ClayButtonKind.text => c.grey,
      ClayButtonKind.clay => c.ink,
    };
    final fontSize = widget.size == ClayButtonSize.small ? 13.0 : 15.0;
    final r = BorderRadius.circular(_h / 2);
    final label = Row(
      mainAxisSize: widget.expand ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (widget.busy)
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(strokeWidth: 1.6, color: fg),
            ),
          )
        else if (widget.icon != null)
          Padding(
            padding: const EdgeInsets.only(right: 6),
            child: Icon(widget.icon, size: fontSize + 2, color: fg),
          ),
        Flexible(
          child: Text(
            widget.label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: fontSize,
              fontWeight: FontWeight.w600,
              color: fg,
              height: 1.2,
            ),
          ),
        ),
      ],
    );
    return Opacity(
      opacity: enabled ? 1 : 0.45,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: enabled ? (_) => setState(() => _down = true) : null,
        onTapUp: enabled ? (_) => setState(() => _down = false) : null,
        onTapCancel: () => setState(() => _down = false),
        onTap: enabled
            ? () {
                HapticFeedback.lightImpact();
                widget.onTap!();
              }
            : null,
        /* 平的: 墨 = 实底; 次按钮 = 填充色; 文字按钮没有底。按下盖一层淡墨 */
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 100),
          height: _h,
          padding: EdgeInsets.symmetric(horizontal: widget.size == ClayButtonSize.small ? 14 : 20),
          decoration: isText
              ? BoxDecoration(borderRadius: r, color: _down ? c.press : null)
              : BoxDecoration(borderRadius: r, color: isInk ? c.primary : (widget.kind == ClayButtonKind.danger ? c.redSoft : c.fill)),
          foregroundDecoration: _down && !isText ? BoxDecoration(borderRadius: r, color: c.press) : null,
          child: Center(widthFactor: 1, child: label),
        ),
      ),
    );
  }
}

/// 圆形按钮 (顶栏右上、语音键两侧).
class ClayRoundButton extends StatefulWidget {
  const ClayRoundButton({
    super.key,
    required this.icon,
    required this.onTap,
    this.size = 40,
    this.ink = false,
    this.tooltip,
    this.child,
    this.flat = false,
  });

  final IconData? icon;
  final Widget? child;
  final VoidCallback? onTap;
  final double size;
  final bool ink;
  final String? tooltip;

  /// 不画泥块, 只是一个裸图标 + 触控格 (顶栏 ☰ / ←)
  final bool flat;

  @override
  State<ClayRoundButton> createState() => _ClayRoundButtonState();
}

class _ClayRoundButtonState extends State<ClayRoundButton> {
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final fg = widget.ink ? c.onPrimary : c.ink;
    final glyph = widget.child ?? Icon(widget.icon, size: widget.size * 0.5, color: fg);
    Widget body;
    if (widget.flat) {
      body = AnimatedContainer(
        duration: const Duration(milliseconds: 100),
        width: widget.size,
        height: widget.size,
        decoration: BoxDecoration(shape: BoxShape.circle, color: _down ? c.press : null),
        child: Center(child: glyph),
      );
    } else {
      body = AnimatedContainer(
        duration: const Duration(milliseconds: 100),
        width: widget.size,
        height: widget.size,
        decoration: BoxDecoration(shape: BoxShape.circle, color: widget.ink ? c.primary : c.fill),
        foregroundDecoration: _down ? BoxDecoration(shape: BoxShape.circle, color: c.press) : null,
        child: Center(child: glyph),
      );
    }
    body = GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTapDown: widget.onTap == null ? null : (_) => setState(() => _down = true),
      onTapUp: (_) => setState(() => _down = false),
      onTapCancel: () => setState(() => _down = false),
      onTap: widget.onTap,
      child: Padding(padding: const EdgeInsets.all(2), child: body),
    );
    if (widget.tooltip != null) body = Tooltip(message: widget.tooltip!, child: body);
    return body;
  }
}

// ════════════════════════════════════════════════════════════════
//  分段 / 筛选
// ════════════════════════════════════════════════════════════════

/// 分段控件. 槽是陶土浅底, 选中的那段浮起成白色泥块 ([inkSelected] 时选中段是墨色).
class ClaySegmented<T> extends StatelessWidget {
  const ClaySegmented({
    super.key,
    required this.options,
    required this.value,
    required this.onChanged,
    this.inkSelected = false,
    this.height = 36,
  });

  final List<(T, String)> options;
  final T value;
  final ValueChanged<T> onChanged;
  final bool inkSelected;
  final double height;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Container(
      height: height,
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: c.fill,
        borderRadius: BorderRadius.circular(height / 2),
      ),
      child: Row(
        children: [
          for (final (v, label) in options)
            Expanded(
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () {
                  if (v == value) return;
                  HapticFeedback.selectionClick();
                  onChanged(v);
                },
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 160),
                  curve: Curves.easeOut,
                  /* 槽是填充色, 选中段是面色 (或墨) —— 平的, 不浮起 */
                  decoration: v != value
                      ? const BoxDecoration()
                      : BoxDecoration(
                          borderRadius: BorderRadius.circular(height / 2),
                          color: inkSelected ? c.primary : c.slab,
                        ),
                  alignment: Alignment.center,
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: v == value ? FontWeight.w600 : FontWeight.w500,
                      color: v == value ? (inkSelected ? c.onPrimary : c.ink) : c.grey,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// 一排筛选小胶囊 (全部 / 对话 / 工作 …), 选中墨色; 横向可滑.
class ClayFilterPills<T> extends StatelessWidget {
  const ClayFilterPills({
    super.key,
    required this.options,
    required this.value,
    required this.onChanged,
    this.padding = const EdgeInsets.symmetric(horizontal: 20),
  });

  final List<(T, String)> options;
  final T value;
  final ValueChanged<T> onChanged;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return SizedBox(
      height: 34,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: padding,
        itemCount: options.length,
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (context, i) {
          final (v, label) = options[i];
          final sel = v == value;
          return GestureDetector(
            onTap: () => onChanged(v),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 160),
              padding: const EdgeInsets.symmetric(horizontal: 14),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(17),
                color: sel ? c.primary : c.fill,
              ),
              child: Text(
                label,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                  color: sel ? c.onPrimary : c.ink,
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  列表: 分组泥板 + 行
// ════════════════════════════════════════════════════════════════

/// 灰色小节标题 (「订阅」「这台手机」「今天」).
class ClaySectionLabel extends StatelessWidget {
  const ClaySectionLabel(
    this.text, {
    super.key,
    this.padding = const EdgeInsets.fromLTRB(24, 20, 24, 8),
    this.trailing,
  });

  final String text;
  final EdgeInsetsGeometry padding;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Padding(
      padding: padding,
      child: Row(
        children: [
          Expanded(
            child: Text(
              text,
              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: c.grey, height: 1.3),
            ),
          ),
          ?trailing,
        ],
      ),
    );
  }
}

/// 一组行装进一块泥板, 行之间一道缩进的发丝线.
class ClayGroup extends StatelessWidget {
  const ClayGroup({
    super.key,
    required this.children,
    this.margin = const EdgeInsets.symmetric(horizontal: 16),
    this.dividerIndent = 64,
  });

  final List<Widget> children;
  final EdgeInsetsGeometry margin;
  final double dividerIndent;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final rows = <Widget>[];
    for (var i = 0; i < children.length; i++) {
      if (i > 0) {
        rows.add(Padding(
          padding: EdgeInsets.only(left: dividerIndent, right: 16),
          child: Container(height: 0.6, color: c.hairline),
        ));
      }
      rows.add(children[i]);
    }
    return Padding(
      padding: margin,
      child: ClaySlab(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Column(mainAxisSize: MainAxisSize.min, children: rows),
      ),
    );
  }
}

/// 行: [方块图标] 名字 / 灰字 ... 右边值 / 开关 / ›
class ClayRow extends StatelessWidget {
  const ClayRow({
    super.key,
    required this.title,
    this.subtitle,
    this.icon,
    this.leading,
    this.value,
    this.trailing,
    this.onTap,
    this.onLongPress,
    this.chevron,
    this.bead,
    this.danger = false,
    this.faded = false,
    this.selected = false,
    this.minHeight,
  });

  final String title;
  final String? subtitle;
  final IconData? icon;
  final Widget? leading;
  final String? value;
  final Widget? trailing;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;

  /// 默认: 可点且没给 trailing 时显示 ›
  final bool? chevron;
  final Color? bead;
  final bool danger;
  final bool faded;

  /// 单选列表里的当前项: 右边一个墨色细勾
  final bool selected;
  final double? minHeight;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final showChevron = chevron ?? (onTap != null && trailing == null && !selected);
    final hasSub = subtitle != null && subtitle!.isNotEmpty;
    Widget? lead = leading;
    if (lead == null && icon != null) {
      lead = ClayTile(icon: icon, size: 36, bead: bead, iconColor: danger ? c.redInk : null);
    }
    final row = ConstrainedBox(
      constraints: BoxConstraints(minHeight: minHeight ?? (hasSub ? 60 : 52)),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        child: Row(
          children: [
            if (lead != null) ...[lead, const SizedBox(width: 14)],
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w500,
                      color: danger ? c.redInk : c.ink,
                      height: 1.3,
                    ),
                  ),
                  if (hasSub)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        subtitle!,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 12.5, color: c.grey, height: 1.35),
                      ),
                    ),
                ],
              ),
            ),
            if (value != null)
              Padding(
                padding: const EdgeInsets.only(left: 8),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 150),
                  child: Text(
                    value!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 13.5, color: c.grey),
                  ),
                ),
              ),
            if (trailing != null) Padding(padding: const EdgeInsets.only(left: 8), child: trailing),
            if (selected) Padding(padding: const EdgeInsets.only(left: 8), child: ClayCheck()),
            if (showChevron)
              Padding(
                padding: const EdgeInsets.only(left: 4),
                child: Icon(Icons.chevron_right_rounded, size: 20, color: c.faint),
              ),
          ],
        ),
      ),
    );
    final body = Opacity(opacity: faded ? 0.5 : 1, child: row);
    if (onTap == null && onLongPress == null) return body;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        onLongPress: onLongPress,
        borderRadius: BorderRadius.circular(14),
        child: body,
      ),
    );
  }
}

/// 墨色细勾 —— 单选列表的当前项. 不用蓝.
class ClayCheck extends StatelessWidget {
  const ClayCheck({super.key, this.size = 20, this.filled = false});

  final double size;

  /// 实心墨圆里一个白勾 (卡片选中); 默认只是一个细勾
  final bool filled;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    if (!filled) return Icon(Icons.check_rounded, size: size, color: c.ink);
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(color: c.ink, shape: BoxShape.circle),
      child: Icon(Icons.check_rounded, size: size * 0.7, color: c.onPrimary),
    );
  }
}

/// 单选点 (墨色).
class ClayRadio extends StatelessWidget {
  const ClayRadio({super.key, required this.selected, this.size = 20});

  final bool selected;
  final double size;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: selected ? c.ink : c.faint, width: 1.5),
      ),
      alignment: Alignment.center,
      child: selected
          ? Container(
              width: size * 0.5,
              height: size * 0.5,
              decoration: BoxDecoration(color: c.ink, shape: BoxShape.circle),
            )
          : null,
    );
  }
}

/// 开关 —— 墨色轨道, 陶土旋钮. 用系统 Switch (主题里已经配成墨色).
class ClaySwitch extends StatelessWidget {
  const ClaySwitch({super.key, required this.value, required this.onChanged});

  final bool value;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    return Transform.scale(
      scale: 0.86,
      child: Switch(value: value, onChanged: onChanged),
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  状态胶囊 (岛 / 签)
// ════════════════════════════════════════════════════════════════

enum ClayTone { neutral, cobalt, amber, green, red }

/// 小签: 进行中 / 等你 / 完成 / 失败. 淡色底 + 同色字, 可带前导 (转圈 / 点 / 图标).
class ClayChip extends StatelessWidget {
  const ClayChip({
    super.key,
    required this.label,
    this.tone = ClayTone.neutral,
    this.leading,
    this.onTap,
    this.dense = false,
    this.trailing,
  });

  final String label;
  final ClayTone tone;
  final Widget? leading;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final (bg, fg) = switch (tone) {
      ClayTone.neutral => (c.tint, c.ink),
      ClayTone.cobalt => (c.cobaltSoft, c.cobalt),
      ClayTone.amber => (c.amberSoft, c.amberInk),
      ClayTone.green => (c.greenSoft, c.greenInk),
      ClayTone.red => (c.redSoft, c.redInk),
    };
    final chip = Container(
      height: dense ? 22 : 30,
      padding: EdgeInsets.symmetric(horizontal: dense ? 8 : 12),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(15)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (leading != null) ...[leading!, SizedBox(width: dense ? 4 : 6)],
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: dense ? 11.5 : 13, fontWeight: FontWeight.w500, color: fg, height: 1.2),
            ),
          ),
          if (trailing != null) ...[const SizedBox(width: 4), trailing!],
        ],
      ),
    );
    if (onTap == null) return chip;
    return GestureDetector(onTap: onTap, child: chip);
  }
}

/// 细弧转圈 —— 运行中.
class ClaySpinner extends StatelessWidget {
  const ClaySpinner({super.key, this.size = 14, this.color});

  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return SizedBox(
      width: size,
      height: size,
      child: CircularProgressIndicator(
        strokeWidth: size <= 12 ? 1.4 : 1.8,
        strokeCap: StrokeCap.round,
        color: color ?? c.cobalt,
        backgroundColor: (color ?? c.cobalt).withValues(alpha: 0.15),
      ),
    );
  }
}

/// 状态小珠.
class ClayDot extends StatelessWidget {
  const ClayDot({super.key, required this.color, this.size = 8});

  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(color: color, shape: BoxShape.circle),
      );
}

// ════════════════════════════════════════════════════════════════
//  井 (命令 / 代码 / 输入格)
// ════════════════════════════════════════════════════════════════

/// 凹进去的井 —— 命令、代码块、验证码格.
class ClayWell extends StatelessWidget {
  const ClayWell({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    this.radius = 10,
    this.color,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final double radius;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: color ?? c.well,
        borderRadius: BorderRadius.circular(radius),
        border: Border(top: BorderSide(color: c.wellEdge, width: 1)),
      ),
      child: child,
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  底部弹层
// ════════════════════════════════════════════════════════════════

/// 陶土底部弹层: 顶圆角 28, 抓手, 泥板色. [builder] 返回内容 (不用自己包 SafeArea).
Future<T?> showClaySheet<T>(
  BuildContext context, {
  required WidgetBuilder builder,
  double? maxHeightFactor = 0.9,
  bool scrollable = true,
  bool useRootNavigator = false,
}) {
  final c = ClayInk.of(context);
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useRootNavigator: useRootNavigator,
    backgroundColor: c.slab,
    barrierColor: c.scrim,
    elevation: 0,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(28))),
    clipBehavior: Clip.antiAlias,
    builder: (ctx) {
      final media = MediaQuery.of(ctx);
      final content = builder(ctx);
      return ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: maxHeightFactor == null ? double.infinity : media.size.height * maxHeightFactor,
        ),
        child: Padding(
          padding: EdgeInsets.only(bottom: media.viewInsets.bottom),
          child: SafeArea(
            top: false,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const ClaySheetGrabber(),
                Flexible(
                  child: scrollable ? SingleChildScrollView(child: content) : content,
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
}

class ClaySheetGrabber extends StatelessWidget {
  const ClaySheetGrabber({super.key});

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 10, bottom: 6),
      child: Center(
        child: Container(
          width: 36,
          height: 4,
          decoration: BoxDecoration(color: c.line, borderRadius: BorderRadius.circular(2)),
        ),
      ),
    );
  }
}

/// 弹层标题行: 粗标题 + 可选灰字 + 右边动作.
class ClaySheetHeader extends StatelessWidget {
  const ClaySheetHeader({super.key, required this.title, this.subtitle, this.trailing});

  final String title;
  final String? subtitle;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 6, 16, 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: c.ink, height: 1.3)),
                if (subtitle != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(subtitle!, style: TextStyle(fontSize: 13, color: c.grey, height: 1.4)),
                  ),
              ],
            ),
          ),
          ?trailing,
        ],
      ),
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  页面
// ════════════════════════════════════════════════════════════════

/// 顶栏: 左 (☰ / ←) · 标题 (居中或靠左, 可带灰字第二行) · 右边动作.
class ClayTopBar extends StatelessWidget {
  const ClayTopBar({
    super.key,
    this.leading,
    this.title,
    this.titleWidget,
    this.subtitle,
    this.actions = const [],
    this.center = false,
    this.onBack,
    this.showBack = true,
  });

  final Widget? leading;
  final String? title;
  final Widget? titleWidget;
  final String? subtitle;
  final List<Widget> actions;
  final bool center;
  final VoidCallback? onBack;
  final bool showBack;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final lead = leading ??
        (showBack
            ? ClayRoundButton(
                flat: true,
                size: 44,
                icon: null,
                tooltip: MaterialLocalizations.of(context).backButtonTooltip,
                onTap: onBack ?? () => Navigator.of(context).maybePop(),
                child: Icon(Icons.arrow_back_rounded, size: 24, color: c.ink),
              )
            : const SizedBox(width: 8));
    final t = titleWidget ??
        (title == null
            ? const SizedBox.shrink()
            : Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: center ? CrossAxisAlignment.center : CrossAxisAlignment.start,
                children: [
                  Text(
                    title!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: c.ink, height: 1.25),
                  ),
                  if (subtitle != null)
                    Text(
                      subtitle!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12.5, color: c.grey, height: 1.3),
                    ),
                ],
              ));
    return SizedBox(
      height: 56,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6),
        child: Row(
          children: [
            lead,
            const SizedBox(width: 4),
            Expanded(child: center ? Center(child: t) : Align(alignment: Alignment.centerLeft, child: t)),
            ...actions,
            if (center && actions.isEmpty) const SizedBox(width: 48),
            const SizedBox(width: 6),
          ],
        ),
      ),
    );
  }
}

/// 陶土页面: 暖纸画布 + 顶栏 + 内容 (可带右上插画).
class ClayPage extends StatelessWidget {
  const ClayPage({
    super.key,
    required this.body,
    this.title,
    this.subtitle,
    this.topBar,
    this.actions = const [],
    this.illustration,
    this.bottom,
    this.centerTitle = false,
    this.onBack,
  });

  final String? title;
  final String? subtitle;
  final Widget? topBar;
  final List<Widget> actions;
  final Widget body;

  /// 右上角插画 (只在落地类页面用: 首页 / 设置头 / 功能介绍页)
  final Widget? illustration;

  /// 底部固定区 (主按钮)
  final Widget? bottom;
  final bool centerTitle;
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Scaffold(
      backgroundColor: c.canvas,
      body: Stack(
        children: [
          if (illustration != null)
            Positioned(top: 0, right: 0, child: IgnorePointer(child: illustration!)),
          SafeArea(
            child: Column(
              children: [
                topBar ??
                    ClayTopBar(
                      title: title,
                      subtitle: subtitle,
                      actions: actions,
                      center: centerTitle,
                      onBack: onBack,
                    ),
                Expanded(child: body),
                if (bottom != null)
                  Padding(padding: const EdgeInsets.fromLTRB(20, 8, 20, 12), child: bottom),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// 陶土插画 (assets/clay/v5/NAME.webp, 透明底; 夜陶用 NAME-d.webp).
///
/// 浅色插画是「去掉纸色底」做出来的, 物件本身几乎和纸同色 —— 放到夜陶的深底上会整个消失,
/// 所以每张都配了夜陶版, 不能拿浅色版凑合。
class ClayArt extends StatelessWidget {
  const ClayArt(this.name, {super.key, this.width, this.height, this.fit = BoxFit.contain, this.hasDark = true});

  final String name;
  final double? width;
  final double? height;
  final BoxFit fit;

  /// 有没有夜陶版 (NAME-d.webp)
  final bool hasDark;

  static String path(String name) => 'assets/clay/v5/$name.webp';

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final file = dark && hasDark ? '$name-d' : name;
    return Image.asset(
      path(file),
      width: width,
      height: height,
      fit: fit,
      filterQuality: FilterQuality.medium,
      gaplessPlayback: true,
      errorBuilder: (_, __, ___) => SizedBox(width: width, height: height),
    );
  }
}

/// 空状态: 一个小陶土物件 + 一句粗话 + 一句灰话 + 至多一个按钮.
class ClayEmpty extends StatelessWidget {
  const ClayEmpty({
    super.key,
    required this.art,
    required this.title,
    this.message,
    this.action,
    this.secondary,
  });

  final String art;
  final String title;
  final String? message;
  final Widget? action;
  final Widget? secondary;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ClayArt(art, width: 150, height: 150),
            const SizedBox(height: 8),
            Text(title, textAlign: TextAlign.center, style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: c.ink)),
            if (message != null) ...[
              const SizedBox(height: 6),
              Text(message!, textAlign: TextAlign.center, style: TextStyle(fontSize: 13.5, color: c.grey, height: 1.5)),
            ],
            if (action != null || secondary != null) ...[
              const SizedBox(height: 18),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  ?action,
                  if (action != null && secondary != null) const SizedBox(width: 12),
                  ?secondary,
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// 输入格 (登录 / 注册 / 添加厂商): 泥板色凹槽, 不描边.
class ClayField extends StatelessWidget {
  const ClayField({
    super.key,
    this.controller,
    this.hint,
    this.label,
    this.icon,
    this.obscure = false,
    this.keyboardType,
    this.trailing,
    this.onChanged,
    this.onSubmitted,
    this.mono = false,
    this.autofocus = false,
    this.textInputAction,
    this.maxLines = 1,
    this.errorText,
    this.enabled = true,
    this.focusNode,
    this.autofillHints,
  });

  final TextEditingController? controller;
  final String? hint;
  final String? label;
  final IconData? icon;
  final bool obscure;
  final TextInputType? keyboardType;
  final Widget? trailing;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final bool mono;
  final bool autofocus;
  final TextInputAction? textInputAction;
  final int maxLines;
  final String? errorText;
  final bool enabled;
  final FocusNode? focusNode;
  final Iterable<String>? autofillHints;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final style = TextStyle(
      fontSize: 15,
      color: c.ink,
      fontFamily: mono ? NeoxMono.family : null,
      fontFamilyFallback: mono ? NeoxMono.fallback : null,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (label != null)
          Padding(
            padding: const EdgeInsets.only(left: 4, bottom: 6),
            child: Text(label!, style: TextStyle(fontSize: 13, color: c.grey, fontWeight: FontWeight.w500)),
          ),
        Container(
          constraints: const BoxConstraints(minHeight: 50),
          padding: const EdgeInsets.symmetric(horizontal: 14),
          decoration: BoxDecoration(
            color: c.dark ? c.well : const Color(0xFFFBF9F5),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: errorText != null ? c.red : c.line, width: 1),
          ),
          child: Row(
            children: [
              if (icon != null) ...[Icon(icon, size: 19, color: c.grey), const SizedBox(width: 10)],
              Expanded(
                child: TextField(
                  controller: controller,
                  focusNode: focusNode,
                  enabled: enabled,
                  obscureText: obscure,
                  keyboardType: keyboardType,
                  autofocus: autofocus,
                  textInputAction: textInputAction,
                  onChanged: onChanged,
                  onSubmitted: onSubmitted,
                  maxLines: obscure ? 1 : maxLines,
                  minLines: 1,
                  autofillHints: autofillHints,
                  style: style,
                  cursorColor: c.cobalt,
                  decoration: InputDecoration(
                    isDense: true,
                    hintText: hint,
                    hintStyle: style.copyWith(color: c.faint),
                    border: InputBorder.none,
                    enabledBorder: InputBorder.none,
                    focusedBorder: InputBorder.none,
                    disabledBorder: InputBorder.none,
                    filled: false,
                    contentPadding: const EdgeInsets.symmetric(vertical: 14),
                  ),
                ),
              ),
              ?trailing,
            ],
          ),
        ),
        if (errorText != null)
          Padding(
            padding: const EdgeInsets.only(left: 4, top: 6),
            child: Text(errorText!, style: TextStyle(fontSize: 12.5, color: c.redInk)),
          ),
      ],
    );
  }
}

/// 细进度条 (4px, 钴蓝 / 墨).
class ClayProgress extends StatelessWidget {
  const ClayProgress({super.key, required this.value, this.height = 4, this.ink = false});

  final double? value;
  final double height;
  final bool ink;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return ClipRRect(
      borderRadius: BorderRadius.circular(height),
      child: LinearProgressIndicator(
        value: value,
        minHeight: height,
        backgroundColor: c.tint,
        color: ink ? c.ink : c.cobalt,
      ),
    );
  }
}
