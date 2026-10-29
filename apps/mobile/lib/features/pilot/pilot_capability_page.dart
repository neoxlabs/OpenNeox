/// pilot_capability_page.dart — 「我能帮你做什么」 (2026-10-18)。
///
///   ←  我能帮你做什么
///   ┌ 现在就能做 ──────────────────┐
///   │ [⏰] 到点提醒你              │
///   │      写进日历、定系统闹钟…     │
///   │      「明早 8 点提醒我交房租」↗ │  ← 点了填进输入框
///   │ [💬] 回微信消息        无障碍 │
///   │ …                          │
///   └────────────────────────────┘
///
/// 平铺的陶土列表, 跟设置页 / 保活检查页同一套零件 (SettingsFrame / SettingsGroup)。
/// 权限没开就在行尾标「未开」, 点一下去保活检查页; 示例点了把这句话带回输入框, 不直接发。
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/i18n/tr.dart';
import '../../shared/clay/clay.dart';
import '../../shared/theme/neox_tokens.dart';
import '../settings/settings_ui.dart';
import 'pilot_capabilities.dart';
import 'pilot_keepalive_guide.dart';
import 'pilot_keepalive_page.dart';

const _ch = MethodChannel(kPilotKeepAliveChannel);

class PilotCapabilityPage extends StatefulWidget {
  const PilotCapabilityPage({super.key});

  @override
  State<PilotCapabilityPage> createState() => _PilotCapabilityPageState();
}

class _PilotCapabilityPageState extends State<PilotCapabilityPage> with WidgetsBindingObserver {
  PilotKeepAliveStatus? _status;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refresh();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /* 从保活检查页 / 系统设置回来, 权限状态跟着刷 */
  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) _refresh();
  }

  Future<void> _refresh() async {
    final st = await _ch.invokeMethod<Map>('status').catchError((_) => null);
    if (!mounted || st == null) return;
    setState(() => _status = PilotKeepAliveStatus.from(st));
  }

  Future<void> _permissions() async {
    if (defaultTargetPlatform != TargetPlatform.android) return;
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const PilotKeepAlivePage()));
    if (mounted) unawaited(_refresh());
  }

  /* 返回带出去的这句话: 上层拿它开一个新会话, 填进输入框 */
  void _use(PilotCapability cap) => Navigator.of(context).pop(cap.example);

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final caps = kPilotCapabilities;
    final missing = pilotCapMissingCount(caps, _status);
    return SettingsFrame(
      title: tr('我能帮你做什么'),
      subtitle: tr('点一句示例就填进输入框，你改一下再发'),
      body: ListView(
        padding: const EdgeInsets.only(top: NeoxSpace.md, bottom: 40),
        children: [
          if (missing > 0)
            Padding(
              padding: const EdgeInsets.fromLTRB(NeoxSpace.xl + 4, 0, NeoxSpace.xl + 4, NeoxSpace.sm),
              child: Text(
                tr('有 $missing 项还差权限，行尾标着「未开」，点一下去开。'),
                style: TextStyle(fontSize: 12.5, height: 1.5, color: c.grey),
              ),
            ),
          SettingsGroup(
            title: tr('现在就能做'),
            margin: const EdgeInsets.fromLTRB(NeoxSpace.xl, 0, NeoxSpace.xl, NeoxSpace.sm),
            dividerIndent: 64,
            children: [
              for (final cap in caps)
                PilotCapabilityRow(
                  cap: cap,
                  state: pilotCapState(cap, _status),
                  onExample: () => _use(cap),
                  onPermission: _permissions,
                ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: NeoxSpace.xl + 4),
            child: Text(
              tr('要花你的钱、或要用你的名义发消息时，它都会停下来先问你。'),
              style: TextStyle(fontSize: 12.5, height: 1.5, color: c.grey),
            ),
          ),
        ],
      ),
    );
  }
}

/// 一项能力: 图标 + 名字 (+ 试用标) + 一句怎么做 + 一句示例.
/// 权限只在不正常时占位: 未开 = 红色小签, 查不了 = 灰签写权限名; 都点得去保活检查页。
class PilotCapabilityRow extends StatelessWidget {
  const PilotCapabilityRow({
    super.key,
    required this.cap,
    required this.state,
    required this.onExample,
    required this.onPermission,
  });

  final PilotCapability cap;
  final PilotCapState state;
  final VoidCallback onExample;
  final VoidCallback onPermission;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final canOpenPerms = defaultTargetPlatform == TargetPlatform.android;
    final Widget perm = switch (state) {
      PilotCapState.on => Icon(Icons.check_circle, color: c.green, size: 18, semanticLabel: tr('${cap.permission}已开')),
      PilotCapState.off => SettingsTag(label: tr('未开'), color: c.redInk),
      PilotCapState.unknown => SettingsTag(label: tr(cap.permission), color: c.grey),
    };
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ClayTile(icon: _iconOf(cap), size: 36),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        tr(cap.title),
                        style: TextStyle(fontSize: 15, fontWeight: FontWeight.w500, color: c.ink, height: 1.3),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    if (cap.trial) ...[
                      const SizedBox(width: 6),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                        decoration: BoxDecoration(color: c.fill, borderRadius: BorderRadius.circular(6)),
                        child: Text(tr('试用中'), style: TextStyle(fontSize: 11, color: c.grey)),
                      ),
                    ],
                    const SizedBox(width: 8),
                    GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: state == PilotCapState.on || !canOpenPerms ? null : onPermission,
                      child: perm,
                    ),
                  ],
                ),
                const SizedBox(height: 2),
                Text(
                  tr(cap.ability),
                  style: TextStyle(fontSize: 12.5, height: 1.4, color: c.grey),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 8),
                Material(
                  color: c.line.withValues(alpha: 0.45),
                  borderRadius: BorderRadius.circular(10),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(10),
                    onTap: onExample,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                      child: Row(
                        children: [
                          Expanded(
                            child: Text(
                              '「${tr(cap.example)}」',
                              style: TextStyle(fontSize: 13.5, color: c.ink, height: 1.3),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          const SizedBox(width: 8),
                          Icon(Icons.north_east_rounded, size: 14, color: c.faint),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

IconData _iconOf(PilotCapability cap) => switch (cap.id) {
      'S05' => Icons.alarm_rounded,
      'S06' => Icons.receipt_long_outlined,
      'S03' => Icons.chat_bubble_outline_rounded,
      'S04' => Icons.sms_outlined,
      'S11' => Icons.call_outlined,
      'S14' => Icons.notifications_none_rounded,
      'S13' => Icons.location_on_outlined,
      'S12' => Icons.laptop_mac_outlined,
      _ => Icons.auto_awesome_outlined,
    };
