/// pilot_auto_page.dart — 自动化 (2026-10-14): 它到点 / 到地方会自己动的, 一张表看全, 能停能删。
///
/// 跟电脑上「自动化」页 (desktop v3/PilotAutoPage.tsx) 同一份数据、同一套开关:
///   它定期替你做的   早上简报 (档案 pilot.brief) · 各专员的定时活 (档案 team.〈专员〉)
///   你让它记着的     trigger 记录: 每年 / 每周 / 某天 / 到了某地 / 见到某人 —— 开关 = 写一条 paused 的更正; 左滑删
///   定好的提醒       账本里一次性的提醒 (改 / 删跟它说)
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:neox_app/core/i18n/tr.dart';

import '../../core/pilot/pilot_brief.dart';
import '../../core/pilot/pilot_cloud.dart';
import '../../core/pilot/pilot_records.dart';
import '../../shared/clay/clay.dart';
import '../../shared/widgets/neox_toast.dart';

class PilotAutoPage extends ConsumerStatefulWidget {
  const PilotAutoPage({super.key, required this.pilotId});
  final String pilotId;

  @override
  ConsumerState<PilotAutoPage> createState() => _PilotAutoPageState();
}

class _PilotAutoPageState extends ConsumerState<PilotAutoPage> {
  Map<String, Object?> _facts = const {};
  List<PilotSpecialist> _team = const [];
  List<PilotRecord>? _rules;
  List<({String title, DateTime at})> _reminders = const [];

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    final cloud = ref.read(pilotCloudProvider);
    if (cloud == null) return;
    final api = cloud.records;
    final results = await Future.wait<Object?>([
      api.query(types: const ['fact.assert'], limit: 200).catchError((_) => <PilotRecord>[]),
      api.team().catchError((_) => <PilotSpecialist>[]),
      api.query(types: const ['trigger'], limit: 100).catchError((_) => <PilotRecord>[]),
      cloud.board(widget.pilotId).catchError((_) => <String, dynamic>{}),
    ]);
    if (!mounted) return;
    final facts = <String, Object?>{};
    /* 新的在前: 同 key 第一条就是现在的值 */
    for (final r in results[0] as List<PilotRecord>) {
      final k = r.data['key'];
      if (k is String && !facts.containsKey(k)) facts[k] = r.data['value'];
    }
    final board = results[3] as Map;
    setState(() {
      _facts = facts;
      _team = [for (final s in results[1] as List<PilotSpecialist>) if (s.scheduleLabel != null) s];
      _rules = results[2] as List<PilotRecord>;
      _reminders = [
        for (final x in (board['reminders'] as List? ?? const []))
          if (x is Map && x['at'] is num) (title: '${x['title']}', at: DateTime.fromMillisecondsSinceEpoch((x['at'] as num).toInt())),
      ]..sort((a, b) => a.at.compareTo(b.at));
    });
  }

  Future<void> _setFact(String key, bool on) async {
    setState(() => _facts = {..._facts, key: on ? 'on' : 'off'});
    await ref.read(pilotCloudProvider)?.records.log([
      {'type': 'fact.assert', 'data': {'key': key, 'value': on ? 'on' : 'off'}},
    ]);
  }

  Future<void> _pause(PilotRecord r, bool paused) async {
    final api = ref.read(pilotCloudProvider)?.records;
    if (api == null) return;
    await api.log([
      /* 带原来的时间: 不带就按「现在」记, 列表按时间排, 一点开关这条就跳到最上面 (2026-10-14 实测) */
      {'type': 'trigger', 'supersedes': r.id, 'occurred_at': r.at.millisecondsSinceEpoch, 'data': {...r.data, 'paused': paused}},
    ]);
    NeoxToast.show(paused ? tr('先停了，不会响') : tr('开了'));
    unawaited(_load());
  }

  Future<void> _delete(PilotRecord r) async {
    setState(() => _rules = [for (final x in _rules ?? const <PilotRecord>[]) if (x.id != r.id) x]);
    await ref.read(pilotCloudProvider)?.records.delete(r.id);
  }

  /// 一条规则说成人话: 「每年 3 月 8 日 09:00」「每周日 20:00」「到了 公司」「见到 张姐」
  String _when(Map<String, dynamic> d) {
    final time = d['time'] is String ? d['time'] as String : '09:00';
    final leadDays = d['leadDays'];
    final lead = d['leadDays'] is num && (d['leadDays'] as num) > 0 ? tr(' · 提前 $leadDays 天') : '';
    final date = '${d['date'] ?? ''}';
    switch (d['when']) {
      case 'yearly':
        final p = date.split('-');
        return p.length == 2 ? tr('每年 ${int.tryParse(p[0])} 月 ${int.tryParse(p[1])} 日 $time') + lead : date;
      case 'date':
        return '$date $time$lead';
      case 'weekly':
        final w = (d['weekday'] as num?)?.toInt() ?? 1;
        final wd = trWeekday(w.clamp(1, 7));
        return '${tr('每$wd')} $time';
      case 'place':
        final place = '${d['place'] ?? ''}';
        return d['on'] == 'leave' ? tr('离开 $place') : tr('到了 $place');
      case 'person':
        final who = '${d['who'] ?? ''}';
        return tr('见到 $who');
    }
    return '';
  }

  String _at(DateTime t) {
    final now = DateTime.now();
    final days = DateTime(t.year, t.month, t.day).difference(DateTime(now.year, now.month, now.day)).inDays;
    final hm = '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
    if (days == 0) return tr('今天 $hm');
    if (days == 1) return tr('明天 $hm');
    return tr('${t.month}月${t.day}日 $hm');
  }

  @override
  Widget build(BuildContext context) {
    final briefOn = PilotBrief.enabled(_facts);
    final briefTime = PilotBrief.timeOf(_facts);
    final rules = _rules;
    final birthdays = _facts.keys.where((k) => RegExp(r'^person\..+\.birthday$').hasMatch(k)).length;
    final now = DateTime.now();
    final reminders = [for (final r in _reminders) if (r.at.isAfter(now.subtract(const Duration(minutes: 1)))) r];
    return ClayPage(
      title: tr('自动化'),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.only(bottom: 48),
          children: [
            ClaySectionLabel(tr('它定期替你做的')),
            ClayGroup(children: [
              ClayRow(
                icon: Icons.wb_sunny_outlined,
                title: tr('早上简报'),
                subtitle: tr('每天 $briefTime · 今天的安排、该留意的'),
                chevron: false,
                trailing: ClaySwitch(value: briefOn, onChanged: (v) => unawaited(_setFact('pilot.brief', v))),
              ),
              for (final s in _team)
                ClayRow(
                  icon: Icons.repeat_rounded,
                  title: s.scheduleLabel!,
                  subtitle: s.name,
                  chevron: false,
                  trailing: ClaySwitch(
                    value: (_facts['team.${s.id}'] ?? (s.on ? 'on' : 'off')) != 'off',
                    onChanged: (v) => unawaited(_setFact('team.${s.id}', v)),
                  ),
                ),
            ]),
            ClaySectionLabel(tr('你让它记着的')),
            if (rules == null)
              const Padding(padding: EdgeInsets.all(24), child: Center(child: ClaySpinner()))
            else if (rules.isEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
                child: Text(tr('还没有。跟它说「每周日晚上八点提醒我给爸妈打电话」「到了公司提醒我拿快递」'),
                    style: TextStyle(fontSize: 13, color: ClayInk.of(context).grey, height: 1.5)),
              )
            else
              ClayGroup(children: [
                for (final r in rules)
                  Dismissible(
                    key: ValueKey(r.id),
                    direction: DismissDirection.endToStart,
                    onDismissed: (_) => unawaited(_delete(r)),
                    background: Container(
                      alignment: Alignment.centerRight,
                      padding: const EdgeInsets.only(right: 24),
                      color: ClayInk.of(context).red,
                      child: const Icon(Icons.delete_outline_rounded, color: Colors.white),
                    ),
                    child: ClayRow(
                      icon: r.data['when'] == 'place' ? Icons.place_outlined : r.data['when'] == 'person' ? Icons.person_outline_rounded : Icons.repeat_rounded,
                      title: '${r.data['text'] ?? r.title}',
                      subtitle: _when(r.data) + (r.data['paused'] == true ? tr(' · 已暂停') : ''),
                      faded: r.data['paused'] == true,
                      chevron: false,
                      trailing: ClaySwitch(value: r.data['paused'] != true, onChanged: (v) => unawaited(_pause(r, !v))),
                    ),
                  ),
              ]),
            if (birthdays > 0)
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 10, 24, 0),
                child: Text(tr('$birthdays 个人的生日会提前 3 天和当天提醒你'),
                    style: TextStyle(fontSize: 12.5, color: ClayInk.of(context).grey)),
              ),
            ClaySectionLabel(tr('定好的提醒')),
            if (reminders.isEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
                child: Text(tr('没有挂着的提醒'), style: TextStyle(fontSize: 13, color: ClayInk.of(context).grey)),
              )
            else
              ClayGroup(children: [
                for (final r in reminders) ClayRow(icon: Icons.notifications_none_rounded, title: r.title, subtitle: _at(r.at)),
              ]),
          ],
        ),
      ),
    );
  }
}
