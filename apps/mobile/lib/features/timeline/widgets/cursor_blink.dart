/// cursor_blink.dart — 流式文本末尾的闪烁光标.
///
/// 跟 Desktop `.atl-msg__cursor` 视觉对齐: 2px宽 × 14px 高 + 1s steps blink.
/// 注: 不能给 Container 用负 margin (Flutter assert), 视觉下沉用 Transform.translate.
library;

import 'package:flutter/material.dart';

class CursorBlink extends StatefulWidget {
  const CursorBlink({super.key});
  @override
  State<CursorBlink> createState() => _CursorBlinkState();
}

class _CursorBlinkState extends State<CursorBlink>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctl;

  @override
  void initState() {
    super.initState();
    _ctl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _ctl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return FadeTransition(
      opacity: _ctl,
      child: Transform.translate(
        offset: const Offset(0, 2),
        child: Container(
          width: 8,
          height: 16,
          margin: const EdgeInsets.only(left: 2),
          color: theme.colorScheme.primary,
        ),
      ),
    );
  }
}
