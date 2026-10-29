/// neox_primary_button.dart — 通栏平底大按钮 (主按钮 + 底下那条可点的平条).
///
/// 原来住在 features/auth/auth_widgets.dart, 但起步引导、本机 Linux 页这些两个发行版都有的
/// 页面也在用 —— 而 features/auth 是商业目录, 开源树里不存在。挪到 shared, 登录页照旧从这里拿。
library;

import 'package:flutter/material.dart';

import '../clay/clay.dart';

/// 主按钮 —— 通栏墨色实底, 52 高 (平的, 跟设置页的主按钮同一种).
class NeoxPrimaryButton extends StatelessWidget {
  const NeoxPrimaryButton({super.key, required this.label, this.onPressed, this.busy = false});
  final String label;
  final VoidCallback? onPressed;
  final bool busy;

  @override
  Widget build(BuildContext context) => SizedBox(
        height: 52,
        child: NeoxFlatBar(
          ink: true,
          onTap: onPressed,
          busy: busy,
          child: Text(label),
        ),
      );
}

/// 通栏平底一条: [ink] = 墨色实底 (主按钮), 否则浅底 (第三方登录那种)。
class NeoxFlatBar extends StatefulWidget {
  const NeoxFlatBar({super.key, required this.child, required this.onTap, this.ink = false, this.busy = false});
  final Widget child;
  final VoidCallback? onTap;
  final bool ink;
  final bool busy;

  @override
  State<NeoxFlatBar> createState() => _NeoxFlatBarState();
}

class _NeoxFlatBarState extends State<NeoxFlatBar> {
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final enabled = widget.onTap != null && !widget.busy;
    final fg = widget.ink ? c.onPrimary : c.ink;
    final r = BorderRadius.circular(26);
    return Opacity(
      opacity: enabled || widget.busy ? 1 : 0.45,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: enabled ? (_) => setState(() => _down = true) : null,
        onTapUp: enabled ? (_) => setState(() => _down = false) : null,
        onTapCancel: () => setState(() => _down = false),
        onTap: enabled ? widget.onTap : null,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 100),
          decoration: BoxDecoration(borderRadius: r, color: widget.ink ? c.primary : c.fill),
          foregroundDecoration: _down ? BoxDecoration(borderRadius: r, color: c.press) : null,
          alignment: Alignment.center,
          child: widget.busy
              ? SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 1.8, color: fg))
              : DefaultTextStyle.merge(
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: fg),
                  child: IconTheme.merge(data: IconThemeData(color: fg), child: widget.child),
                ),
        ),
      ),
    );
  }
}
