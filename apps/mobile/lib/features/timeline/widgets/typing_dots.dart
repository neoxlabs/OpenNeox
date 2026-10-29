/// typing_dots.dart — 3 个 bouncing dots + "思考中" 文字.
///
/// user 发送后到 agent 第一个 token 之间的等待态显示.
/// 跟 Desktop `.atl-typing-dots` 动画对齐: 0/120/240ms stagger, 800ms repeat.
library;

import 'package:flutter/material.dart';
import 'package:neox_app/core/i18n/tr.dart';

class TypingDots extends StatefulWidget {
  /* label 可空: 默认「思考中」要走 tr() 按界面语言取, 参数默认值必须是常量 */
  const TypingDots({super.key, this.label});
  final String? label;

  @override
  State<TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<TypingDots>
    with TickerProviderStateMixin {
  late final List<AnimationController> _ctls;

  @override
  void initState() {
    super.initState();
    _ctls = List.generate(3, (i) {
      final c = AnimationController(
        vsync: this,
        duration: const Duration(milliseconds: 900),
      );
      Future.delayed(Duration(milliseconds: i * 120), () {
        if (mounted) c.repeat(reverse: true);
      });
      return c;
    });
  }

  @override
  void dispose() {
    for (final c in _ctls) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Text(
            widget.label ?? tr('思考中'),
            style: theme.textTheme.bodySmall?.copyWith(color: mute),
          ),
          const SizedBox(width: 8),
          for (int i = 0; i < 3; i++)
            FadeTransition(
              opacity: _ctls[i].drive(Tween(begin: 0.25, end: 1.0)),
              child: ScaleTransition(
                scale: _ctls[i].drive(Tween(begin: 0.7, end: 1.0)),
                child: Container(
                  width: 5,
                  height: 5,
                  margin: const EdgeInsets.symmetric(horizontal: 1.5),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.primary,
                    shape: BoxShape.circle,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
