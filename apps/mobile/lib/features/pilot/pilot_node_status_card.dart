/// pilot_node_status_card.dart — 连接页顶部「这台手机」: 跟它的连接 + 最近替它办的事 (pilot:D-18)。
///
/// 心跳 / 动作状态由云端连接写进 pilotNodeStatusProvider (core/pilot/pilot_node_status.dart),
/// 这里只负责画。每 10s 重画一次, 让「12 秒前 / 2 分钟前」跟着时间走。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:neox_app/core/i18n/tr.dart';
import 'package:neox_app/core/pilot/pilot_node_status.dart';

import '../../shared/clay/clay.dart';

class PilotNodeStatusCard extends ConsumerStatefulWidget {
  const PilotNodeStatusCard({super.key});

  @override
  ConsumerState<PilotNodeStatusCard> createState() => _PilotNodeStatusCardState();
}

class _PilotNodeStatusCardState extends ConsumerState<PilotNodeStatusCard> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 10), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(pilotNodeStatusProvider);
    final now = DateTime.now();
    final link = pilotNodeLink(s, now);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ClaySectionLabel(tr('这台手机')),
        ClayGroup(children: [
          ClayRow(
            icon: link == PilotNodeLink.offline ? Icons.cloud_off_outlined : Icons.cloud_done_outlined,
            title: tr('跟它的连接'),
            subtitle: pilotNodeBeatLabel(s, now, t: tr),
            value: pilotNodeLinkLabel(s, now, t: tr),
            chevron: false,
            danger: link == PilotNodeLink.stale,
          ),
          ClayRow(
            icon: Icons.history_rounded,
            title: tr('最近替它办的事'),
            subtitle: pilotNodeActionLabel(s, now, t: tr),
            chevron: false,
          ),
        ]),
      ],
    );
  }
}
