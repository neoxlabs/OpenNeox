/// pilot_setup_page.dart — 第一次进 Pilot: 「我是小航。先帮你盯什么？」(陶土稿 v5).
///
///   顶     ☰ · 名字 ▾
///   插画   猫站在泥台上招手
///   六块   钱 / 身体 / 出行 / 关系 / 日程 / 习惯 —— 点选 (墨色描边 + 实心勾), 默认选两块
///   可以随时改 · 允许读短信 (自动记账) 开关
///   好了
///
/// 选的块写进档案 `team.<专员> = on/off` (跟「它在盯的」同一套开关); 只出现一次 (本机记住)。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:neox_app/core/i18n/tr.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/pilot/pilot_cloud.dart';
import '../../shared/clay/clay.dart';
import '../../shared/widgets/neox_drawer.dart';
import 'auto_ledger.dart';

const kPilotSetupDonePref = 'pilot_setup_done_v1';

/// 这台手机上还没走过「先帮你盯什么」
Future<bool> pilotNeedsSetup() async {
  try {
    return (await SharedPreferences.getInstance()).getBool(kPilotSetupDonePref) != true;
  } catch (_) {
    return false;
  }
}

/// 一块 → 管它的专员 (服务端 team.ts 的 id)
const _areas = <(String, IconData, List<String>)>[
  ('钱', Icons.savings_outlined, ['finance', 'home']),
  ('身体', Icons.favorite_border_rounded, ['health']),
  ('出行', Icons.directions_car_outlined, ['travel']),
  ('关系', Icons.people_outline_rounded, ['social']),
  ('日程', Icons.calendar_month_outlined, ['work']),
  ('习惯', Icons.eco_outlined, ['health']),
];

class PilotSetupPage extends ConsumerStatefulWidget {
  const PilotSetupPage({super.key, required this.name, required this.onDone});

  final String name;
  final VoidCallback onDone;

  @override
  ConsumerState<PilotSetupPage> createState() => _PilotSetupPageState();
}

class _PilotSetupPageState extends ConsumerState<PilotSetupPage> {
  final Set<String> _picked = {'钱', '身体'};
  bool _sms = false;
  bool _busy = false;

  Future<void> _done() async {
    if (_busy) return;
    setState(() => _busy = true);
    final on = {for (final (name, _, ids) in _areas) if (_picked.contains(name)) ...ids};
    final all = {for (final (_, _, ids) in _areas) ...ids};
    try {
      await ref.read(pilotCloudProvider)?.records.log([
        for (final id in all) {'type': 'fact.assert', 'data': {'key': 'team.$id', 'value': on.contains(id) ? 'on' : 'off'}},
      ]);
    } catch (_) {/* 没写上也先进去, 「它在盯的」里还能改 */}
    if (_sms) unawaited(ref.read(autoLedgerProvider.notifier).enable(notif: false, sms: true));
    try {
      await (await SharedPreferences.getInstance()).setBool(kPilotSetupDonePref, true);
    } catch (_) {}
    HapticFeedback.mediumImpact();
    widget.onDone();
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Scaffold(
      drawer: const NeoxDrawer(here: 'pilot'),
      backgroundColor: c.canvas,
      body: SafeArea(
        child: Column(
          children: [
            SizedBox(
              height: 56,
              child: Row(children: [
                const SizedBox(width: 8),
                Builder(
                  builder: (ctx) => ClayRoundButton(icon: Icons.menu_rounded, flat: true, size: 44, onTap: () => Scaffold.of(ctx).openDrawer()),
                ),
                Expanded(
                  child: Center(
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      Text(widget.name, style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: c.ink)),
                      Icon(Icons.arrow_drop_down_rounded, size: 22, color: c.ink),
                    ]),
                  ),
                ),
                const SizedBox(width: 52),
              ]),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
                children: [
                  const SizedBox(height: 210, child: ClayArt('pilot-wave', fit: BoxFit.contain)),
                  const SizedBox(height: 14),
                  Text(tr('我是${widget.name}。先帮你盯什么？'), style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: c.ink, height: 1.3)),
                  const SizedBox(height: 18),
                  GridView.count(
                    crossAxisCount: 2,
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    mainAxisSpacing: 12,
                    crossAxisSpacing: 12,
                    childAspectRatio: 2.5,
                    children: [
                      for (final (name, icon, _) in _areas)
                        _AreaTile(
                          name: tr(name),
                          icon: icon,
                          selected: _picked.contains(name),
                          onTap: () {
                            HapticFeedback.selectionClick();
                            setState(() => _picked.contains(name) ? _picked.remove(name) : _picked.add(name));
                          },
                        ),
                    ],
                  ),
                  const SizedBox(height: 20),
                  Text(tr('可以随时改'), style: TextStyle(fontSize: 13, color: c.grey)),
                  const SizedBox(height: 8),
                  Container(height: 0.6, color: c.line),
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Row(children: [
                      ClayTile(icon: Icons.sms_outlined, size: 36),
                      const SizedBox(width: 12),
                      Expanded(child: Text(tr('允许读短信（自动记账）'), style: TextStyle(fontSize: 14.5, color: c.ink))),
                      ClaySwitch(value: _sms, onChanged: (v) => setState(() => _sms = v)),
                    ]),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 16),
              child: ClayButton.ink(label: tr('好了'), size: ClayButtonSize.large, expand: true, busy: _busy, onTap: _picked.isEmpty ? null : _done),
            ),
          ],
        ),
      ),
    );
  }
}

class _AreaTile extends StatelessWidget {
  const _AreaTile({required this.name, required this.icon, required this.selected, required this.onTap});
  final String name;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 160),
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(18),
          color: c.slab,
          border: Border.all(color: selected ? c.ink : Colors.transparent, width: 1.6),
          boxShadow: clayShadow(c, lift: selected ? 0.5 : 1.0),
        ),
        child: Row(
          children: [
            ClayTile(icon: icon, size: 40),
            const SizedBox(width: 12),
            Expanded(child: Text(name, style: TextStyle(fontSize: 15, fontWeight: FontWeight.w500, color: c.ink))),
            if (selected) const ClayCheck(filled: true, size: 22),
          ],
        ),
      ),
    );
  }
}
