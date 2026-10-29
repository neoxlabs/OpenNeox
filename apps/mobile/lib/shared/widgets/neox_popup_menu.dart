/// neox_popup_menu.dart — 贴着按钮弹出的悬浮菜单 (2026-10-11 用户: 「不要用底部那种弹出菜单, 要用悬浮的弹出菜单」)。
///
/// 一行 = 陶土小图标 + 字 (+ 可选 ✓), 圆角白卡浮在按钮下面, 点外面就收。
/// 顶栏右上角的菜单、「本机 / 电脑」下拉都用它, 长得一样。
library;

import 'package:flutter/material.dart';

import '../theme/neox_tokens.dart';
import 'asset_px.dart';

class NeoxMenuItem<T> {
  const NeoxMenuItem({required this.value, required this.label, this.icon, this.checked = false});
  final T value;
  final String label;

  /// 陶土图标 / 头像; null = 不画图标列
  final Widget? icon;
  final bool checked;
}

/// 在 [anchor] (按钮的 context) 下面弹出; 返回选中的 value, 点外面 = null
Future<T?> showNeoxPopupMenu<T>(BuildContext anchor, List<NeoxMenuItem<T>> items, {bool alignRight = false}) {
  final box = anchor.findRenderObject() as RenderBox;
  final overlay = Overlay.of(anchor).context.findRenderObject() as RenderBox;
  final topLeft = box.localToGlobal(Offset(0, box.size.height + 4), ancestor: overlay);
  final bottomRight = box.localToGlobal(box.size.bottomRight(const Offset(0, 4)), ancestor: overlay);
  final scheme = Theme.of(anchor).colorScheme;
  final hasIcons = items.any((i) => i.icon != null);
  return showMenu<T>(
    context: anchor,
    position: RelativeRect.fromRect(
      Rect.fromPoints(topLeft, alignRight ? bottomRight : Offset(topLeft.dx + box.size.width, topLeft.dy)),
      Offset.zero & overlay.size,
    ),
    color: scheme.surface,
    surfaceTintColor: Colors.transparent,
    elevation: 8,
    shadowColor: const Color(0x33000000),
    constraints: const BoxConstraints(minWidth: 168, maxWidth: 260),
    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(NeoxRadius.card)),
    menuPadding: const EdgeInsets.symmetric(vertical: 6),
    items: [
      for (final it in items)
        PopupMenuItem<T>(
          value: it.value,
          height: 44,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          child: Row(children: [
            if (hasIcons) ...[SizedBox(width: 22, height: 22, child: it.icon), const SizedBox(width: 12)],
            Expanded(
              child: Text(
                it.label,
                style: TextStyle(fontSize: 15, color: scheme.onSurface, fontWeight: it.checked ? FontWeight.w600 : FontWeight.w400),
              ),
            ),
            if (it.checked) ...[const SizedBox(width: 8), const Icon(Icons.check_rounded, size: 18, color: NeoxBrand.blue)],
          ]),
        ),
    ],
  );
}

/// 陶土图标 (assets/clay) 的菜单尺寸版
Widget neoxMenuClay(String name) =>
    Image.asset(NeoxClay.of(name), width: 22, height: 22, cacheWidth: assetPx(22), filterQuality: FilterQuality.medium);
