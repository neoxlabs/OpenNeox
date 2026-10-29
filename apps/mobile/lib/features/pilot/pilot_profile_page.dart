/// pilot_profile_page.dart — 资料页 (稿: Pilot · 当 IM 做 ④). 聊天页点头像 / ⋯ 进来, 左上返回。
///
/// Pilot:  大头像 + 一句身份 · [发消息][打电话][记一笔] · 它替你看着的 (钱 / 身体 / 足迹 / 关系 → 房间)
///         · 在哪工作 / 模型 / 关于你 / 开权限 / 消息免打扰
/// 专员:   大头像 + 负责什么 · [发消息][现在做一次] · 能看 / 几点做 / 开着
///
/// 返回值: 要在聊天里替你说的一句 (「现在做一次」) —— 聊天页拿到就发。
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:neox_app/core/i18n/tr.dart';

import '../../core/edition/edition.dart' show PlanModel, planModelsProvider;
import '../../core/notifications/local_notifications.dart';
import '../../core/notifications/notify_prefs.dart';
import '../../core/pilot/pilot_brain.dart';
import '../../core/pilot/pilot_cloud.dart';
import '../../core/pilot/pilot_records.dart';
import '../../shared/clay/clay.dart';
import '../../shared/theme/neox_tokens.dart' show NeoxClay;
import '../../shared/widgets/neox_toast.dart';
import 'call/pilot_call_controller.dart';
import 'pilot_about_page.dart';
import 'pilot_auto_page.dart';
import 'pilot_connect_page.dart';
import 'pilot_im.dart';
import 'pilot_jarvis_page.dart';
import 'pilot_link.dart';
import 'pilot_stage.dart';

const _phoneCh = MethodChannel('neox.phone/tools');

/// 专员能看的记录类型 → 人话
const _seesZh = {
  'health.': '身体', 'fitness.workout': '运动', 'mood': '心情', 'habit.check': '打卡',
  'finance.': '收支', 'asset.snapshot': '资产', 'bill': '账单', 'task': '待办',
  'social.interaction': '联系人', 'trigger': '你定的日子', 'work.focus': '专注', 'event.calendar': '日程',
  'knowledge.item': '知识库', 'place.visit': '去过的地方', 'context.state': '在家 / 外地',
};

class PilotProfilePage extends ConsumerStatefulWidget {
  const PilotProfilePage({super.key, required this.thread});
  final PilotThread thread;

  @override
  ConsumerState<PilotProfilePage> createState() => _PilotProfilePageState();
}

class _PilotProfilePageState extends ConsumerState<PilotProfilePage> {
  PilotThread get t => widget.thread;
  PilotContact get pilot => t.pilot;

  bool _needNotif = false;
  bool _needA11y = false;
  bool _needExact = false;
  late String _model = pilot.modelId ?? kPilotDefaultModel;
  late bool _on = t.specialist?.on ?? true;

  @override
  void initState() {
    super.initState();
    if (t.kind == PilotThreadKind.direct) unawaited(_checkPerms());
  }

  Future<void> _checkPerms() async {
    if (!Platform.isAndroid) return;
    final st = await _phoneCh.invokeMethod<Map>('status').catchError((_) => null);
    if (!mounted || st == null) return;
    final exact = await LocalNotifications.canScheduleExact();
    if (!mounted) return;
    setState(() {
      _needNotif = st['notifications'] != true;
      _needA11y = st['accessibility'] != true;
      _needExact = !exact;
    });
  }

  // ───────── Pilot ─────────

  String _modelName(String id) {
    for (final m in ref.read(planModelsProvider) ?? const <PlanModel>[]) {
      if (m.modelId == id && m.displayName.isNotEmpty) return m.displayName;
    }
    return id;
  }

  /// 换模型: 套餐里能用的对话模型, 能看图的标一下
  Future<void> _pickModel() async {
    final models = [
      for (final m in ref.read(planModelsProvider) ?? const <PlanModel>[])
        if (m.allowed && m.modality == 'chat' && m.modelId != 'neox-free') m,
    ];
    if (models.isEmpty || !mounted) return;
    final picked = await showClaySheet<String>(
      context,
      builder: (c) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ClaySheetHeader(title: tr('${pilot.name} 用哪个模型')),
            ClayGroup(margin: EdgeInsets.zero, children: [
              for (final m in models)
                ClayRow(
                  title: m.displayName.isEmpty ? m.modelId : m.displayName,
                  subtitle: switch ([if (m.modelId == kPilotDefaultModel) tr('默认'), if (m.vision == true) tr('能看图')].join(' · ')) {
                    '' => null,
                    final s => s,
                  },
                  selected: m.modelId == _model,
                  onTap: () => Navigator.pop(c, m.modelId),
                ),
            ]),
          ],
        ),
      ),
    );
    if (picked == null || picked == _model || !mounted) return;
    final cloud = ref.read(pilotCloudProvider);
    if (cloud == null) return;
    final before = _model;
    setState(() => _model = picked);
    try {
      await cloud.setModel(pilot.sessionId, picked);
      NeoxToast.show(tr('换成 ${_modelName(picked)} 了'));
    } catch (e) {
      if (!mounted) return;
      setState(() => _model = before);
      NeoxToast.show(tr('没换成：$e'));
    }
  }

  Future<void> _openPermissions() async {
    await showClaySheet<void>(
      context,
      builder: (c) {
        Widget row(IconData icon, String label, VoidCallback go) => ClayRow(
              icon: icon,
              title: label,
              onTap: () {
                Navigator.pop(c);
                go();
              },
            );
        return Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              ClaySheetHeader(title: tr('开权限')),
              ClayGroup(margin: EdgeInsets.zero, children: [
                if (_needNotif) row(Icons.mark_email_unread_outlined, tr('看手机消息'), () => unawaited(_phoneCh.invokeMethod('openNotificationAccess').catchError((_) => null))),
                if (_needA11y) row(Icons.touch_app_outlined, tr('替你点 App'), () => unawaited(_phoneCh.invokeMethod('openAccessibilitySettings').catchError((_) => null))),
                if (_needExact) row(Icons.alarm_rounded, tr('准点叫你'), () => unawaited(LocalNotifications.requestExact())),
              ]),
            ],
          ),
        );
      },
    );
    unawaited(_checkPerms());
  }

  void _room(PilotRoom r) => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => PilotJarvisPage(pilot: pilot, initialRoom: r)));

  // ───────── 专员 ─────────

  Future<void> _toggle(bool on) async {
    HapticFeedback.selectionClick();
    final s = t.specialist!;
    setState(() => _on = on);
    try {
      await ref.read(pilotCloudProvider)?.records.log([{'type': 'fact.assert', 'data': {'key': 'team.${s.id}', 'value': on ? 'on' : 'off'}}]);
      NeoxToast.show(on ? tr('${s.name} 开工了') : tr('${s.name} 先歇着'));
      ref.invalidate(pilotTeamProvider);
    } catch (e) {
      if (mounted) setState(() => _on = !on);
      NeoxToast.show(tr('没改成：$e'));
    }
  }

  // ───────── 画 ─────────

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final s = t.specialist;
    final face = s != null ? PilotFace.specialist(s, size: 96) : PilotFace.pilot(pilot, size: 96);
    final line = s != null ? s.duty : (pilot.persona.isNotEmpty ? pilot.persona : tr('你的主管 · 替你盯着日子里的事'));

    Widget act(IconData icon, String label, VoidCallback onTap) => Expanded(
          child: ClaySlab(
            radius: 18,
            padding: const EdgeInsets.symmetric(vertical: 12),
            onTap: onTap,
            child: Column(children: [
              Icon(icon, size: 22, color: c.ink),
              const SizedBox(height: 4),
              Text(label, style: TextStyle(fontSize: 12.5, color: c.ink)),
            ]),
          ),
        );

    final actions = <Widget>[
      act(Icons.chat_bubble_outline_rounded, tr('发消息'), () => Navigator.of(context).pop()),
      if (s == null) ...[
        act(Icons.phone_outlined, tr('打电话'), () => ref.read(pilotCallControllerProvider).callOut(pilot)),
        act(Icons.edit_note_rounded, tr('记一笔'), () => showPilotQuickSheet(context, ref)),
      ] else
        act(Icons.play_arrow_rounded, tr('现在做一次'), () => Navigator.of(context).pop(tr('现在做一次：${s.scheduleLabel ?? s.duty}。做完用两三句告诉我结论。'))),
    ];

    return ClayPage(
      title: '',
      body: ListView(
        padding: const EdgeInsets.only(bottom: 32),
        children: [
          Center(child: face),
          const SizedBox(height: 12),
          Center(child: Text(s?.name ?? pilot.name, style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: c.ink))),
          Padding(
            padding: const EdgeInsets.fromLTRB(32, 4, 32, 18),
            child: Text(line, textAlign: TextAlign.center, style: TextStyle(fontSize: 13.5, color: c.grey, height: 1.5)),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(children: [
              for (var i = 0; i < actions.length; i++) ...[if (i > 0) const SizedBox(width: 10), actions[i]],
            ]),
          ),
          if (s == null) ..._pilotSections(c) else ..._specialistSections(c, s),
        ],
      ),
    );
  }

  List<Widget> _pilotSections(ClayInk c) {
    ref.watch(notifyPrefsVersionProvider);
    final rooms = [PilotRoom.money, PilotRoom.body, PilotRoom.trips, PilotRoom.people];
    const art = {PilotRoom.money: 'i-coins', PilotRoom.body: 'i-pulse', PilotRoom.trips: 'i-route', PilotRoom.people: 'i-person'};
    return [
      ClaySectionLabel(tr('它替你看着的')),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16),
        child: Row(children: [
          for (var i = 0; i < rooms.length; i++) ...[
            if (i > 0) const SizedBox(width: 8),
            Expanded(
              child: ClaySlab(
                radius: 16,
                padding: const EdgeInsets.fromLTRB(4, 12, 4, 10),
                onTap: () => _room(rooms[i]),
                child: Column(children: [
                  Image.asset(NeoxClay.of(art[rooms[i]]!), width: 36, height: 36, filterQuality: FilterQuality.medium),
                  const SizedBox(height: 6),
                  Text(rooms[i].label, style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: c.ink)),
                ]),
              ),
            ),
          ],
        ]),
      ),
      ClaySectionLabel(tr('设置')),
      ClayGroup(children: [
        ClayRow(icon: Icons.hub_outlined, title: tr('模型'), value: _modelName(_model), onTap: _pickModel),
        /* 跟电脑上同名的两页 (2026-10-14): 它到点会自己动的 / 这台手机给它看什么、替它做什么 */
        ClayRow(
          icon: Icons.schedule_rounded,
          title: tr('自动化'),
          value: tr('到点它会做的'),
          onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => PilotAutoPage(pilotId: pilot.sessionId))),
        ),
        ClayRow(
          icon: Icons.cable_rounded,
          title: tr('连接'),
          value: tr('这台手机'),
          onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const PilotConnectPage())),
        ),
        ClayRow(
          icon: Icons.person_outline_rounded,
          title: tr('关于你'),
          value: tr('它记住的事'),
          onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const PilotAboutPage())),
        ),
        if (_needNotif || _needA11y || _needExact) ClayRow(icon: Icons.shield_outlined, title: tr('开权限'), value: tr('还差几项'), onTap: _openPermissions),
        ClayRow(
          icon: Icons.notifications_off_outlined,
          title: tr('消息免打扰'),
          chevron: false,
          trailing: ClaySwitch(
            value: !NotifyPrefs.enabled(NotifyKind.pilot),
            onChanged: (v) async {
              await NotifyPrefs.set(NotifyKind.pilot, !v);
              ref.read(notifyPrefsVersionProvider.notifier).state++;
            },
          ),
        ),
      ]),
    ];
  }

  List<Widget> _specialistSections(ClayInk c, PilotSpecialist s) {
    final sees = [
      for (final k in s.sees)
        tr(_seesZh.entries.firstWhere((e) => k.startsWith(e.key), orElse: () => MapEntry(k, k)).value),
    ].toSet().join(isEnglishUi ? ', ' : '、');
    return [
      ClaySectionLabel(tr('它的活')),
      ClayGroup(children: [
        ClayRow(icon: Icons.schedule_rounded, title: tr('几点做'), value: s.scheduleLabel ?? tr('随叫随到'), chevron: false),
        if (sees.isNotEmpty) ClayRow(icon: Icons.visibility_outlined, title: tr('能看'), subtitle: sees, chevron: false),
        if (s.lastAt != null)
          ClayRow(
            icon: Icons.history_rounded,
            title: tr('最近一次'),
            value: pilotListTime(DateTime.fromMillisecondsSinceEpoch(s.lastAt!)),
            chevron: false,
          ),
        ClayRow(
          icon: Icons.power_settings_new_rounded,
          title: tr('开着'),
          chevron: false,
          trailing: ClaySwitch(value: _on, onChanged: _toggle),
        ),
      ]),
    ];
  }
}
