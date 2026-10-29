/// neox_brand_pill.dart — 陶土蓝小胶囊 (卡片里的主动作, 比如「升级」).
///
/// 尺寸刻意小: 它是卡片里的一个入口, 不是页面主按钮 (2026-10-09 用户: 设置页
/// 「升级」按钮「这么大, 你觉得合适吗」)。材质见 [NeoxBrand.clayBlue]。
library;

import 'package:flutter/material.dart';

import '../theme/neox_tokens.dart';

class NeoxBrandPill extends StatefulWidget {
  const NeoxBrandPill({
    super.key,
    required this.label,
    required this.onTap,
    this.height = 30,
  });

  final String label;
  final VoidCallback onTap;
  final double height;

  @override
  State<NeoxBrandPill> createState() => _NeoxBrandPillState();
}

class _NeoxBrandPillState extends State<NeoxBrandPill> {
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final h = widget.height;
    return GestureDetector(
      onTapDown: (_) => setState(() => _down = true),
      onTapCancel: () => setState(() => _down = false),
      onTapUp: (_) => setState(() => _down = false),
      onTap: widget.onTap,
      child: AnimatedScale(
        duration: const Duration(milliseconds: 140),
        scale: _down ? 0.95 : 1,
        child: Container(
          height: h,
          padding: EdgeInsets.symmetric(horizontal: h * 0.55),
          decoration: NeoxBrand.clayBlue(BorderRadius.circular(h / 2)),
          /* 不给 Container 设 alignment —— 设了它会撑满父级宽度, 胶囊变整条 */
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                widget.label,
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 0.2,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
