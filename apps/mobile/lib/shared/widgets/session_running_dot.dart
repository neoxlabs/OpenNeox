/// session_running_dot.dart — 会话列表里那颗"在跑"的呼吸点 (2026-10-12).
///
/// 用户原话: 「会话等列表里, 如果运行中的话, 有个运行的动画显示更好」。
///
/// 注意别拿 [NeoxStatusDot] 的 `pulse` 顶替 —— 那个只是给圆点加了一圈**静态**光晕,
/// 不动。这里是真的在呼吸 (1.1 秒一个来回), 扫一眼就知道这条会话还在干活。
library;

import 'package:flutter/material.dart';

import '../theme/neox_tokens.dart';

class SessionRunningDot extends StatefulWidget {
  const SessionRunningDot({super.key, this.size = 9, this.color});

  final double size;

  /// 默认品牌蓝 —— 跟「语音对话」那颗按钮同一个色, 表示"正在活动".
  final Color? color;

  @override
  State<SessionRunningDot> createState() => _SessionRunningDotState();
}

class _SessionRunningDotState extends State<SessionRunningDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    /* 系统开了"减弱动态效果"就不呼吸, 只留一颗实心点 —— 信息还在, 不晃 */
    final still = MediaQuery.disableAnimationsOf(context);
    final dot = Container(
      width: widget.size,
      height: widget.size,
      decoration: BoxDecoration(
        color: widget.color ?? NeoxBrand.blue,
        shape: BoxShape.circle,
      ),
    );
    if (still) return dot;
    return FadeTransition(
      opacity: Tween<double>(begin: 0.3, end: 1).animate(
        CurvedAnimation(parent: _c, curve: Curves.easeInOut),
      ),
      child: dot,
    );
  }
}
