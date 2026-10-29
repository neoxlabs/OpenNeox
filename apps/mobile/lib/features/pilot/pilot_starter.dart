/// pilot_starter.dart — 新会话空状态的开场 (2026-10-18)。
///
/// 一句招呼 + 最常用的几件真能办成的事, 都是从 pilot_capabilities 里取的。
/// 点一句只填进输入框, 不直接发 —— 用户改一下再发, 不至于点错就发出去。
library;

import 'package:flutter/material.dart';
import 'package:neox_app/core/i18n/tr.dart';

import '../../shared/clay/clay.dart';
import 'pilot_capabilities.dart';

class PilotStarter extends StatelessWidget {
  const PilotStarter({
    super.key,
    required this.name,
    required this.onPick,
    required this.onCamera,
    this.onAll,
    this.intro,
    this.subtitle,
    this.examples,
  });

  final String name;

  /// 点了示例: 把这句话填进输入框 (上层负责预填, 不发送)
  final void Function(String text) onPick;
  final VoidCallback onCamera;

  /// 看全部能力 (带权限状态那张页); null = 不摆这个入口 (专员窗口)
  final VoidCallback? onAll;

  /// 开场第一句; null = 「我是$name。」
  final String? intro;

  /// 开场第二句; null = 主管那句通用的
  final String? subtitle;

  /// 给了就只列这几条示例 (专员窗口: 它管得着的事); 不给 = 通用能力 + 拍小票
  final List<String>? examples;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final rows = <(String, String, VoidCallback)>[
      if (examples != null)
        for (final e in examples!) ('💬', e, () => onPick(e))
      else ...[
        for (final cap in pilotStarterCapabilities()) (cap.icon, cap.example, () => onPick(cap.example)),
        ('🧾', tr('拍张小票，帮我记一笔'), onCamera),
      ],
    ];
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 28, 20, 12),
      children: [
        Text(intro ?? tr('我是$name。'), style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600, color: c.ink)),
        const SizedBox(height: 6),
        Text(
          subtitle ?? tr('帮你记事、到点提醒、记账、回消息，要动钱或要用你的名义发出去的会先问你。点一句试试，填好你改一下再发：'),
          style: TextStyle(fontSize: 14, height: 1.5, color: c.grey),
        ),
        const SizedBox(height: 18),
        for (final (icon, label, onTap) in rows)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Material(
              color: c.line.withValues(alpha: 0.45),
              borderRadius: BorderRadius.circular(12),
              child: InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: onTap,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
                  child: Row(
                    children: [
                      Text(icon, style: const TextStyle(fontSize: 17)),
                      const SizedBox(width: 12),
                      Expanded(child: Text(tr(label), style: TextStyle(fontSize: 15, color: c.ink))),
                      Icon(Icons.north_east_rounded, size: 16, color: c.faint),
                    ],
                  ),
                ),
              ),
            ),
          ),
        if (onAll != null)
          TextButton(
            onPressed: onAll,
            child: Text(tr('看全部能力 ›'), style: TextStyle(fontSize: 13, color: c.grey)),
          ),
      ],
    );
  }
}
