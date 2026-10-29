/// timeline_row.dart — 时间轴所有"活动行"的统一骨架.
///
/// 直接照搬桌面 `agent-timeline.css` 的行结构, 不再各写各的:
///   `.atl-activity__head { display:flex; gap:8px; padding:5px 10px }`
///   `.atl-activity__icon { width:18px; justify-content:center; flex-shrink:0 }`
///   `.atl-group      { padding-left:10px; border-left:1.5px solid }`
///
/// 关键是那个**固定 18px 图标列**: 桌面每行都有它, 所以不管图标是 14 还是 16,
/// 文字永远从同一条竖线开始。手机端之前每个 widget 自己写 Icon(size: 13/14/15/16)
/// + SizedBox(width: 5/6/8), thinking 行干脆没图标 —— 一屏里四五条不同起点,
/// 就是明康说的"垂直不对齐" (2026-07-29)。
///
/// 层级也照桌面: **不靠深缩进**, 靠左侧一条竖轨 + 10px —— 深缩进会让嵌套两层后
/// 正文被挤到屏幕中间。
library;

import 'package:flutter/material.dart';

import '../../../shared/theme/neox_tokens.dart';

/// 一条活动行: [图标列 18][间距 8][内容 …][尾注].
///
/// [icon] 传 null 也照样占那 18px —— thinking 这类没图标的行才不会比别人靠左。
class TimelineRow extends StatelessWidget {
  const TimelineRow({
    super.key,
    this.icon,
    required this.child,
    this.trailing,
    this.onTap,
    this.onLongPress,
    this.verticalPadding = 3,
  });

  final Widget? icon;
  final Widget child;
  final Widget? trailing;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final double verticalPadding;

  @override
  Widget build(BuildContext context) {
    final row = Padding(
      padding: EdgeInsets.symmetric(vertical: verticalPadding),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          SizedBox(
            width: NeoxIndent.icon,
            height: NeoxIndent.icon,
            child: icon == null ? null : Center(child: icon),
          ),
          const SizedBox(width: NeoxIndent.gap),
          Expanded(child: child),
          if (trailing != null) trailing!,
        ],
      ),
    );
    if (onTap == null && onLongPress == null) return row;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        onLongPress: onLongPress,
        borderRadius: NeoxRadius.smallR,
        child: row,
      ),
    );
  }
}

/// 行的展开区 — 左边缘对齐到行内**文字**起点 (图标列 + 间距), 不是对齐到图标.
class TimelineRowBody extends StatelessWidget {
  const TimelineRowBody({super.key, required this.child, this.bottom = 6});

  final Widget child;
  final double bottom;

  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.only(
          left: NeoxIndent.icon + NeoxIndent.gap,
          bottom: bottom,
        ),
        child: child,
      );
}

/// 分组容器 — 只做 10px 缩进表达层级.
///
/// 桌面 `.atl-group` 还带一条左竖轨, 但手机屏窄、行也短, 那条线只是多一道视觉噪音
/// (明康 2026-07-29: "这里不需要这道竖直的线")。缩进本身已经说明从属关系。
class TimelineGroupRail extends StatelessWidget {
  const TimelineGroupRail({
    super.key,
    required this.child,
    this.active = false,
  });

  final Widget child;
  final bool active;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(left: NeoxIndent.rail),
        child: child,
      );
}
