/// pilot_inbox_page.dart — Pilot 首页 = 会话列表 (稿: Pilot · 当 IM 做 ①).
///
///   ☰  Pilot                                ＋
///   ( ⌕ 搜索 )
///   ┌ [猫]  小航   主管            08:30 ┐
///   │       今天 3 件事…               ② │
///   │ [拼]  我的团队  7            08:31 │
///   │ [陶]  收支                    08:31 │   ← 每个 Bot 都是一个联系人, 不分类
///   │ [陶]  家里  (关着, 整行淡)         │
///   └─────────────────────────────────────┘
///
/// 只有这一层左上是 ☰ (拉侧栏去别的模式); 点一行进聊天, 聊天页左上是返回。
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:neox_app/core/i18n/tr.dart';

import '../../core/pilot/pilot_records.dart';
import '../../shared/clay/clay.dart';
import '../../shared/widgets/neox_drawer.dart';
import 'pilot_capability_page.dart';
import 'pilot_chat_page.dart';
import 'pilot_im.dart';
import 'pilot_keepalive_banner.dart';
import 'pilot_link.dart';
import 'pilot_team_page.dart';
import 'pilot_today_page.dart';

class PilotInboxPage extends ConsumerStatefulWidget {
  const PilotInboxPage({super.key, required this.pilots});
  final List<PilotContact> pilots;

  @override
  ConsumerState<PilotInboxPage> createState() => _PilotInboxPageState();
}

class _PilotInboxPageState extends ConsumerState<PilotInboxPage> {
  final _scaffold = GlobalKey<ScaffoldState>();
  final _query = TextEditingController();

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  Future<void> _open(PilotThread t, {String? draft}) async {
    HapticFeedback.selectionClick();
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => PilotChatPage(thread: t, draft: draft)));
    /* 回来时最后一句 / 未读都可能变了 */
    if (!mounted) return;
    for (final p in widget.pilots) {
      ref.invalidate(pilotPreviewProvider(p.sessionId));
    }
    ref.invalidate(pilotTeamProvider);
  }

  /* 「今天」: 晨间简报 / 到点提醒 / 它替你办完的 (pilot:U-04) —— 通知点开和这里进的是同一页 */
  Future<void> _today() async {
    HapticFeedback.selectionClick();
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => PilotTodayPage(pilot: widget.pilots.first)));
  }

  /* 「我能帮你做什么」: 点了某句示例 → 进这个 Pilot 的会话, 把这句话填进输入框 (不直接发) */
  Future<void> _capabilities() async {
    final pick = await Navigator.of(context).push<String>(MaterialPageRoute(builder: (_) => const PilotCapabilityPage()));
    if (!mounted || pick == null) return;
    await _open(PilotThread.direct(widget.pilots.first), draft: pick);
  }

  Future<void> _plus() async {
    final chief = widget.pilots.first;
    final go = await showClaySheet<String>(
      context,
      builder: (c) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ClaySheetHeader(title: tr('加人')),
            ClayGroup(margin: EdgeInsets.zero, children: [
              ClayRow(
                icon: Icons.group_add_outlined,
                title: tr('团队成员'),
                subtitle: tr('打开 / 关掉哪几个，几点干活'),
                onTap: () => Navigator.pop(c, 'team'),
              ),
              ClayRow(
                icon: Icons.desktop_windows_outlined,
                title: tr('新建一个 Pilot'),
                subtitle: tr('在电脑上切到 Pilot 模式建，这里会自动出现'),
                chevron: false,
                faded: true,
              ),
            ]),
          ],
        ),
      ),
    );
    if (go == 'team' && mounted) {
      await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => PilotTeamPage(pilot: chief)));
      ref.invalidate(pilotTeamProvider);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final chief = widget.pilots.first;
    final team = ref.watch(pilotTeamProvider).valueOrNull ?? const <PilotSpecialist>[];
    final q = _query.text.trim();
    bool hit(String name) => q.isEmpty || name.contains(q);

    /* 行: Pilot 们 (置顶) → 群 → 专员 (开着的按最近一次排, 关着的沉底) */
    final specialists = [...team]..sort((a, b) {
        if (a.on != b.on) return a.on ? -1 : 1;
        return (b.lastAt ?? 0).compareTo(a.lastAt ?? 0);
      });
    final rows = <Widget>[
      for (final p in widget.pilots)
        if (hit(p.name)) _PilotRow(pilot: p, chief: p == chief, onTap: () => _open(PilotThread.direct(p))),
      if (team.isNotEmpty && hit(tr('我的团队')))
        _GroupRow(chief: chief, members: specialists.where((s) => s.on).toList(), count: team.where((s) => s.on).length + 1, onTap: () => _open(PilotThread.group(chief))),
      for (final s in specialists)
        if (hit(s.name)) _SpecialistRow(s: s, onTap: () => _open(PilotThread.specialist(chief, s))),
    ];

    return Scaffold(
      key: _scaffold,
      backgroundColor: c.canvas,
      drawer: const NeoxDrawer(here: 'pilot'),
      body: SafeArea(
        child: Column(
          children: [
            ClayTopBar(
              leading: ClayRoundButton(flat: true, size: 44, icon: Icons.menu_rounded, tooltip: tr('菜单'), onTap: () => _scaffold.currentState?.openDrawer()),
              titleWidget: Text('Pilot', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: c.ink)),
              actions: [
                ClayRoundButton(flat: true, size: 44, icon: Icons.today_outlined, tooltip: tr('今天'), onTap: _today),
                ClayRoundButton(flat: true, size: 44, icon: Icons.lightbulb_outline_rounded, tooltip: tr('我能帮你做什么'), onTap: _capabilities),
                ClayRoundButton(flat: true, size: 44, icon: Icons.add_rounded, tooltip: tr('加人'), onTap: _plus),
              ],
            ),
            /* 无障碍被系统关掉时, 顶部给一条可点的提示 */
            const PilotKeepAliveBanner(),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 2, 20, 10),
              child: Container(
                height: 40,
                padding: const EdgeInsets.symmetric(horizontal: 14),
                decoration: BoxDecoration(color: c.fill, borderRadius: BorderRadius.circular(20)),
                child: Row(children: [
                  Icon(Icons.search_rounded, size: 19, color: c.faint),
                  const SizedBox(width: 8),
                  Expanded(
                    child: TextField(
                      controller: _query,
                      onChanged: (_) => setState(() {}),
                      style: TextStyle(fontSize: 15, color: c.ink),
                      cursorColor: c.cobalt,
                      decoration: InputDecoration(
                        isDense: true,
                        filled: false,
                        border: InputBorder.none,
                        enabledBorder: InputBorder.none,
                        focusedBorder: InputBorder.none,
                        hintText: tr('搜索'),
                        hintStyle: TextStyle(fontSize: 15, color: c.faint),
                      ),
                    ),
                  ),
                ]),
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                color: c.cobalt,
                onRefresh: () async {
                  for (final p in widget.pilots) {
                    ref.invalidate(pilotPreviewProvider(p.sessionId));
                  }
                  ref.invalidate(pilotTeamProvider);
                  ref.invalidate(pilotContactsProvider);
                },
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
                  physics: const AlwaysScrollableScrollPhysics(),
                  children: [
                    if (rows.isEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 60),
                        child: Center(child: Text(tr('没找到'), style: TextStyle(fontSize: 14, color: c.grey))),
                      )
                    else
                      Container(
                        decoration: BoxDecoration(color: c.slab, borderRadius: BorderRadius.circular(20)),
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        child: Column(children: [
                          for (var i = 0; i < rows.length; i++) ...[
                            if (i > 0) Padding(padding: const EdgeInsets.only(left: 76, right: 14), child: Container(height: 0.6, color: c.hairline)),
                            rows[i],
                          ],
                        ]),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 一行的骨架: 头像 50 · 名字 (+ 小签) · 时间 / 最后一句 · 未读
class _Row extends StatelessWidget {
  const _Row({required this.face, required this.name, this.tag, this.time, this.line, this.unread = 0, this.faded = false, required this.onTap});
  final Widget face;
  final String name;
  final String? tag;
  final String? time;
  final String? line;
  final int unread;
  final bool faded;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(16),
      child: Opacity(
        opacity: faded ? 0.5 : 1,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
          child: Row(children: [
            face,
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(children: [
                    Expanded(
                      child: Row(children: [
                        Flexible(child: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: c.ink))),
                        if (tag != null) ...[
                          const SizedBox(width: 6),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                            decoration: BoxDecoration(color: c.fill, borderRadius: BorderRadius.circular(6)),
                            child: Text(tag!, style: TextStyle(fontSize: 11, color: c.grey)),
                          ),
                        ],
                      ]),
                    ),
                    if (time != null) ...[const SizedBox(width: 8), Text(time!, style: TextStyle(fontSize: 12.5, color: c.faint))],
                  ]),
                  const SizedBox(height: 3),
                  Row(children: [
                    Expanded(child: Text(line ?? '', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13.5, color: c.grey))),
                    if (unread > 0) ...[
                      const SizedBox(width: 8),
                      Container(
                        constraints: const BoxConstraints(minWidth: 20),
                        height: 20,
                        padding: const EdgeInsets.symmetric(horizontal: 6),
                        alignment: Alignment.center,
                        decoration: BoxDecoration(color: c.cobalt, borderRadius: BorderRadius.circular(10)),
                        child: Text(unread > 99 ? '99+' : '$unread', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Colors.white)),
                      ),
                    ],
                  ]),
                ],
              ),
            ),
          ]),
        ),
      ),
    );
  }
}

class _PilotRow extends ConsumerWidget {
  const _PilotRow({required this.pilot, required this.chief, required this.onTap});
  final PilotContact pilot;
  final bool chief;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = ref.watch(pilotPreviewProvider(pilot.sessionId)).valueOrNull;
    final last = p?.direct;
    return _Row(
      face: PilotFace.pilot(pilot),
      name: pilot.name,
      tag: chief ? tr('主管') : null,
      time: last == null ? null : pilotListTime(last.at),
      line: last == null ? (pilot.persona.isEmpty ? tr('跟它说点什么') : pilot.persona) : pilotPreviewText(last),
      unread: p?.unread ?? 0,
      onTap: onTap,
    );
  }
}

class _GroupRow extends ConsumerWidget {
  const _GroupRow({required this.chief, required this.members, required this.count, required this.onTap});
  final PilotContact chief;
  final List<PilotSpecialist> members;
  final int count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final last = ref.watch(pilotPreviewProvider(chief.sessionId)).valueOrNull?.group;
    return _Row(
      face: PilotFace.group(chief, members),
      name: tr('我的团队'),
      tag: '$count',
      time: last == null ? null : pilotListTime(last.at),
      line: last == null ? tr('${chief.name}和专员们') : pilotPreviewText(last, withSender: true, pilotName: chief.name),
      onTap: onTap,
    );
  }
}

class _SpecialistRow extends StatelessWidget {
  const _SpecialistRow({required this.s, required this.onTap});
  final PilotSpecialist s;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final at = s.lastAt == null ? null : DateTime.fromMillisecondsSinceEpoch(s.lastAt!);
    final summary = s.lastSummary?.split('\n').map((l) => l.replaceAll(RegExp(r'[*_`#>]'), '').trim()).firstWhere((l) => l.isNotEmpty, orElse: () => '');
    return _Row(
      face: PilotFace.specialist(s),
      name: s.name,
      time: at == null ? null : pilotListTime(at),
      line: !s.on
          ? tr('关着 · 点开可以打开')
          : (summary != null && summary.isNotEmpty)
              ? summary
              : (s.scheduleLabel ?? s.duty),
      faded: !s.on,
      onTap: onTap,
    );
  }
}
