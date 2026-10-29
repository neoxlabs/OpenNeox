/// pilot_team_page.dart — Pilot 团队 (2026-10-11, 设计见 docs/NEOX_PILOT_ASSISTANT_DESIGN_2026_10_11.md §6)。
///
/// 多个管理: 顶上主管 (你只跟它说话, 它分派), 下面专员宫格 —— 每格一句此刻的状态
///           「1 号出了月报」「下次 周日 20:00」「关着」, 开着的亮、关着的灰。
/// 单个管理: 点一格拉出它的底板 —— 负责什么、能看哪些数据、定时做什么下次几点、最近交了什么、
///           今天干了几次花了多少, 开关, 「现在做一次」(交给主管派给它)。
/// 开关 / 改钟点写进档案 (`team.<id>` = off / `team.<id>.time`), 触发引擎和主管都认。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:neox_app/core/i18n/tr.dart';

import '../../core/pilot/pilot_cloud.dart';
import '../../core/pilot/pilot_records.dart';
import '../../shared/clay/clay.dart';
import '../../shared/theme/neox_tokens.dart';
import '../../shared/widgets/neox_toast.dart';
import 'pilot_link.dart';
import 'pilot_talk.dart';

/// 记录类型 → 人话 (「它能看」那一行)
const _seesZh = {
  'health.': '体重 / 睡眠 / 步数 / 体检', 'fitness.workout': '运动', 'mood': '心情', 'habit.check': '打卡',
  'finance.': '收支', 'asset.snapshot': '资产', 'bill': '账单', 'task': '待办',
  'social.interaction': '和谁联系过', 'trigger': '你定的日子', 'work.focus': '专注时段', 'event.calendar': '日程',
  'knowledge.item': '知识库 / 成品', 'place.visit': '去过的地方', 'context.state': '在家 / 开车 / 外地',
};

String _when(String? next) {
  if (next == null) return '';
  final d = DateTime.tryParse(next.replaceFirst(' ', 'T'));
  if (d == null) return next;
  final now = DateTime.now();
  final days = DateTime(d.year, d.month, d.day).difference(DateTime(now.year, now.month, now.day)).inDays;
  final hm = '${d.hour}:${d.minute.toString().padLeft(2, '0')}';
  if (days == 0) return tr('今天 $hm');
  if (days == 1) return tr('明天 $hm');
  if (days < 7) return '${trWeekday(d.weekday)} $hm';
  return tr('${d.month} 月 ${d.day} 日 $hm');
}

String _ago(int ms) {
  final m = DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(ms)).inMinutes;
  if (m < 60) return tr('${m < 1 ? 1 : m} 分钟前');
  if (m < 60 * 24) return tr('${m ~/ 60} 小时前');
  return tr('${m ~/ (60 * 24)} 天前');
}

class PilotTeamPage extends ConsumerStatefulWidget {
  const PilotTeamPage({super.key, this.pilot});
  final PilotContact? pilot;

  @override
  ConsumerState<PilotTeamPage> createState() => _PilotTeamPageState();
}

class _PilotTeamPageState extends ConsumerState<PilotTeamPage> {
  List<PilotSpecialist>? _team;
  PilotContact? _chief;
  String? _error;

  PilotRecordsApi? get _api => ref.read(pilotCloudProvider)?.records;

  @override
  void initState() {
    super.initState();
    _chief = widget.pilot;
    unawaited(_load());
    if (_chief == null) {
      unawaited(ref.read(pilotLinkProvider).listPilots().then((l) {
        if (mounted && l.isNotEmpty) setState(() => _chief = l.first);
      }).catchError((_) {}));
    }
  }

  Future<void> _load() async {
    try {
      final t = await _api?.team();
      if (mounted) setState(() { _team = t; _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = '$e'.replaceFirst('Bad state: ', ''));
    }
  }

  Future<void> _toggle(PilotSpecialist s, bool on) async {
    HapticFeedback.selectionClick();
    await _api?.log([{'type': 'fact.assert', 'data': {'key': 'team.${s.id}', 'value': on ? 'on' : 'off'}}]);
    NeoxToast.show(on ? tr('${s.name} 开工了') : tr('${s.name} 先歇着'));
    /* 档案投影有一两秒延迟 */
    await Future<void>.delayed(const Duration(milliseconds: 1500));
    await _load();
  }

  /// 现在做一次: 交给主管, 主管派给它 (结论在主管的对话里, 也记进它的「最近」)
  Future<void> _runNow(PilotSpecialist s) async {
    final chief = _chief;
    if (chief == null) return;
    final task = s.scheduleLabel == null ? s.duty : s.scheduleLabel!;
    final answer = ref.read(pilotTalkProvider).ask(chief, tr('让${s.name}现在做一次：$task。做完用两三句告诉我结论。'));
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (c) => _RunSheet(name: s.name, clay: s.clay, answer: answer),
    );
    await _load();
  }

  Future<void> _open(PilotSpecialist s) async {
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (c) => _SpecialistSheet(
        s: s,
        onToggle: (on) async {
          Navigator.pop(c);
          await _toggle(s, on);
        },
        onRun: () async {
          Navigator.pop(c);
          await _runNow(s);
        },
      ),
    );
  }

  /// 现在做一次: 让主管把开着的都过一遍, 有要紧的告诉我
  Future<void> _runAll() async {
    final chief = _chief;
    if (chief == null) return;
    final answer = ref.read(pilotTalkProvider).ask(chief, tr('把你在盯的都过一遍（收支、日程、睡眠、关系、出行），有要紧的、能替我办的直接办，最后用两三句告诉我。'));
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (c) => _RunSheet(name: chief.name, clay: 'i-chip', answer: answer),
    );
    await _load();
  }

  /// 陶土稿 v5「它在盯的」: 头上一间房 (猫守着一排表盘), 下面两列泥块 —— 每块一个开关 + 一句什么时候管;
  /// 底下墨色「现在做一次」+ 最近一次几点。
  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final team = _team;
    final lastAt = team?.map((s) => s.lastAt ?? 0).fold<int>(0, (a, b) => b > a ? b : a) ?? 0;
    final chiefName = _chief?.name ?? 'Pilot';
    return ClayPage(
      title: tr('$chiefName在盯的'),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: EdgeInsets.zero,
          children: [
            const AspectRatio(aspectRatio: 2.0, child: ClayArt('pilot/scene-team', fit: BoxFit.cover)),
            const SizedBox(height: 16),
            if (team == null && _error == null)
              const Padding(padding: EdgeInsets.symmetric(vertical: 60), child: Center(child: ClaySpinner(size: 20)))
            else if (_error != null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 40),
                child: Center(child: ClayButton(label: tr('没连上，点一下重试'), kind: ClayButtonKind.clay, onTap: _load)),
              )
            else
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: GridView.count(
                  crossAxisCount: 2,
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  mainAxisSpacing: 12,
                  crossAxisSpacing: 12,
                  childAspectRatio: 1.15,
                  children: [for (final s in team!) _Cell(s: s, onTap: () => _open(s), onToggle: (v) => _toggle(s, v))],
                ),
              ),
            const SizedBox(height: 16),
          ],
        ),
      ),
      bottom: Row(
        children: [
          ClayButton.ink(label: tr('现在做一次'), size: ClayButtonSize.large, onTap: _chief == null ? null : _runAll),
          const SizedBox(width: 16),
          if (lastAt > 0) Flexible(child: Text(tr('最近一次 · ${_ago(lastAt)}'), style: TextStyle(fontSize: 13, color: c.grey))),
        ],
      ),
    );
  }
}

/// 专员 → 稿里那种两个字的名字和一个图标
({String name, IconData icon}) _short(PilotSpecialist s) => switch (s.id) {
      'finance' => (name: tr('收支'), icon: Icons.credit_card_rounded),
      'work' => (name: tr('日程'), icon: Icons.calendar_month_outlined),
      'health' => (name: tr('身体'), icon: Icons.bedtime_outlined),
      'social' => (name: tr('关系'), icon: Icons.people_outline_rounded),
      'travel' => (name: tr('出行'), icon: Icons.flight_rounded),
      'home' => (name: tr('家里'), icon: Icons.home_outlined),
      _ => (name: s.name, icon: Icons.adjust_rounded),
    };

/// 一格: 陶土方块图标 (最近交过东西的带一颗蓝珠) + 右上开关; 名字 + 一句什么时候管. 关着的整格淡下去
class _Cell extends StatelessWidget {
  const _Cell({required this.s, required this.onTap, required this.onToggle});
  final PilotSpecialist s;
  final VoidCallback onTap;
  final ValueChanged<bool> onToggle;

  String get _status {
    if (!s.on) return tr('关着');
    if (s.scheduleLabel != null) return s.scheduleLabel!;
    if (s.lastAt != null && DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(s.lastAt!)).inDays < 2) {
      return tr('${_ago(s.lastAt!)}交了一份');
    }
    if (s.next != null) return tr('下次 ${_when(s.next)}');
    return tr('随叫随到');
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final short = _short(s);
    final fresh = s.on && s.lastAt != null && DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(s.lastAt!)).inDays < 2;
    return ClaySlab(
      radius: 20,
      padding: const EdgeInsets.fromLTRB(14, 14, 12, 12),
      onTap: onTap,
      child: Opacity(
        opacity: s.on ? 1 : 0.55,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ClayTile(icon: short.icon, size: 44, bead: fresh ? c.cobalt : null),
                const Spacer(),
                ClaySwitch(value: s.on, onChanged: onToggle),
              ],
            ),
            const Spacer(),
            Text(short.name, style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700, color: c.ink)),
            const SizedBox(height: 2),
            Text(_status, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12.5, color: c.grey)),
          ],
        ),
      ),
    );
  }
}

/// 单个专员的底板
class _SpecialistSheet extends StatelessWidget {
  const _SpecialistSheet({required this.s, required this.onToggle, required this.onRun});
  final PilotSpecialist s;
  final ValueChanged<bool> onToggle;
  final VoidCallback onRun;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    final sees = s.sees.map((x) => _seesZh[x] ?? x).toSet().join(' · ');
    Widget row(String clay, String label, String value) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Image.asset(NeoxClay.of(clay), width: 26, height: 26, filterQuality: FilterQuality.medium),
            const SizedBox(width: NeoxSpace.md),
            SizedBox(width: 56, child: Text(label, style: theme.textTheme.labelLarge?.copyWith(color: mute))),
            Expanded(child: Text(value, style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600, height: 1.35))),
          ]),
        );
    return SafeArea(
      top: false,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.85),
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(NeoxSpace.xl, 0, NeoxSpace.xl, NeoxSpace.xl),
          children: [
            Row(children: [
              Image.asset(NeoxClay.of(s.clay), width: 56, height: 56, filterQuality: FilterQuality.medium),
              const SizedBox(width: NeoxSpace.md),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(s.name, style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
                  Text(s.duty, style: theme.textTheme.bodySmall?.copyWith(color: mute)),
                ]),
              ),
              ClaySwitch(value: s.on, onChanged: onToggle),
            ]),
            const SizedBox(height: NeoxSpace.md),
            if (s.scheduleLabel != null) row('i-calendar', tr('定时'), s.on && s.next != null ? tr('${s.scheduleLabel} · 下次 ${_when(s.next)}') : s.scheduleLabel!),
            row('i-shield', tr('能看'), tr('$sees（别的房间它看不到）')),
            row('i-chip', tr('今天'), s.today == 0 ? tr('还没干活') : tr('干了 ${s.today} 次 · 约 ${(s.tokensToday / 1000).toStringAsFixed(1)}k token')),
            if (s.lastSummary != null && s.lastSummary!.isNotEmpty) ...[
              const SizedBox(height: NeoxSpace.md),
              Text(tr('最近交的 · ${_ago(s.lastAt!)}'), style: theme.textTheme.labelLarge?.copyWith(color: mute)),
              const SizedBox(height: 6),
              Container(
                padding: const EdgeInsets.all(NeoxSpace.md),
                decoration: BoxDecoration(color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.5), borderRadius: BorderRadius.circular(16)),
                child: Text(s.lastSummary!, style: theme.textTheme.bodyMedium?.copyWith(height: 1.5)),
              ),
            ],
            const SizedBox(height: NeoxSpace.lg),
            Align(
              alignment: Alignment.centerRight,
              child: ClayButton.ink(label: tr('现在做一次'), onTap: onRun),
            ),
          ],
        ),
      ),
    );
  }
}

class _RunSheet extends StatelessWidget {
  const _RunSheet({required this.name, required this.clay, required this.answer});
  final String name;
  final String clay;
  final Future<String> answer;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      top: false,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.75),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(NeoxSpace.xl, 0, NeoxSpace.xl, NeoxSpace.xl),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(children: [
              Image.asset(NeoxClay.of(clay), width: 32, height: 32, filterQuality: FilterQuality.medium),
              const SizedBox(width: NeoxSpace.sm),
              Text(name, style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
            ]),
            const SizedBox(height: NeoxSpace.md),
            Flexible(
              child: FutureBuilder<String>(
                future: answer,
                builder: (c, s) => s.connectionState != ConnectionState.done
                    ? Row(children: [
                        const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                        const SizedBox(width: NeoxSpace.md),
                        Expanded(child: Text(tr('主管交给$name了，翻记录中…'), style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant))),
                      ])
                    : SingleChildScrollView(
                        child: Text(s.hasError ? tr('没办成：${s.error}') : (s.data ?? '').trim(), style: theme.textTheme.bodyLarge?.copyWith(height: 1.55)),
                      ),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}
