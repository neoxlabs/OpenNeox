/// context_gauge.dart — 上下文占用的圆环 + 文案, 一处定义两处用.
///
/// 手机屏窄, 上下文这件事不值得占一整行常驻: 平时只在 [+] 按钮外圈画一圈细环
/// (不占额外宽度), 详情和"压缩"动作收进 [+] 菜单 —— 跟桌面 composer 那个
/// `⟳ 2%` 是同一个意思。
///
/// 阈值配色的依据是"还能不能安心继续说话":
///   · < 60%  安静 (灰), 不打扰
///   · 60-80% 提醒 (warning 黄), 可以开始考虑压缩
///   · > 80%  警示 (红), 再不压缩就要触发自动压缩/截断了
library;

import 'package:flutter/material.dart';

import '../../../core/network/session_context_provider.dart';
import '../../../shared/theme/neox_tokens.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 上下文占用的一次快照 — 从 [SessionContextInfo] 归一化出来给 UI 用.
class ContextUsage {
  const ContextUsage({
    required this.used,
    required this.total,
    required this.ratio,
  });

  final int used;
  final int total;

  /// 0..1, total 未知时为 0
  final double ratio;

  int get percent => (ratio * 100).round();

  /// 窗口大小是否已知 — 未知时只能显示"已用 N", 画不出环也算不出百分比.
  bool get totalKnown => total > 0;

  /// 还没跑过 turn (used=0) → null, 整块不渲染。
  /// 窗口未知但已用已知 → 仍返回实例: 已用量是桌面推来的真实数据, 不该因为
  /// 模型元数据没拿到就整个藏起来 (2026-07-29 真机: 桌面 used=22808 手机全空)。
  static ContextUsage? from(SessionContextInfo? info) {
    if (info == null) return null;
    final total = info.contextWindow ?? 0;
    final used = info.contextTokens;
    if (used <= 0) return null;
    return ContextUsage(
      used: used,
      total: total,
      ratio: total > 0 ? (used / total).clamp(0.0, 1.0) : 0,
    );
  }

  Color color(ColorScheme scheme) {
    if (!totalKnown) return scheme.onSurfaceVariant;
    if (ratio >= 0.8) return scheme.error;
    if (ratio >= 0.6) return NeoxClaudePalette.warning;
    return scheme.onSurfaceVariant;
  }

  /// 窗口已知: "45.2k / 200k · 23%"; 未知: "已用 45.2k"
  String get label => totalKnown
      ? '${_fmt(used)} / ${_fmt(total)} · $percent%'
      : tr('已用 ${_fmt(used)}');

  static String _fmt(int n) {
    if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M';
    if (n >= 1000) {
      final k = n / 1000;
      return '${k >= 100 ? k.toStringAsFixed(0) : k.toStringAsFixed(1)}k';
    }
    return '$n';
  }
}

/// [+] 按钮外圈那道环 — 只在有数据时画, 无数据时完全不渲染 (不留空位).
class ContextRing extends StatelessWidget {
  const ContextRing({super.key, required this.usage, this.size = 30});

  final ContextUsage? usage;
  final double size;

  @override
  Widget build(BuildContext context) {
    final u = usage;
    /* 窗口未知时画不出比例 —— 不画环 (画个满圈或空圈都是撒谎), 数字留给菜单 */
    if (u == null || !u.totalKnown) return const SizedBox.shrink();
    final scheme = Theme.of(context).colorScheme;
    return IgnorePointer(
      /* 环只是背景装饰, 点击照常穿到底下的 [+] 按钮上 */
      child: SizedBox(
        width: size,
        height: size,
        child: CircularProgressIndicator(
          value: u.ratio,
          strokeWidth: 1.6,
          backgroundColor: scheme.outline.withValues(alpha: 0.35),
          valueColor: AlwaysStoppedAnimation(u.color(scheme)),
        ),
      ),
    );
  }
}
