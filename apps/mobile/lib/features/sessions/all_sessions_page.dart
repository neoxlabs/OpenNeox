/// all_sessions_page.dart — 全部会话 (侧栏「全部 ›」, 陶土稿 v5).
///
///   ←  全部                                    🔍
///   [全部] 对话 工作 编码
///   钉住   …
///   今天   修复登录限流 / 编码 · Mac · 14:20        ●等你
///   昨天 / 本周 / 更早 …
///   左滑一条: [钉住] [删除]
///
/// 子 Agent 不单独成行 (进父任务里看)。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/execution/run_target.dart';
import '../../core/execution/run_target_provider.dart';
import '../../core/i18n/tr.dart';
import '../../core/network/stream_buffer_provider.dart' show sessionPendingApprovalsProvider;
import '../../core/storage/database.dart';
import '../../shared/clay/clay.dart';
import '../../shared/widgets/neox_drawer.dart';
import '../home/state/home_mode_provider.dart';
import '../home/widgets/session_actions.dart';
import '../timeline/state/running_sessions_provider.dart';

enum _Filter { all, chat, work, code }

class AllSessionsPage extends ConsumerStatefulWidget {
  const AllSessionsPage({super.key});

  @override
  ConsumerState<AllSessionsPage> createState() => _AllSessionsPageState();
}

class _AllSessionsPageState extends ConsumerState<AllSessionsPage> {
  _Filter _filter = _Filter.all;

  bool _match(SessionMirrorData s) {
    if (_filter == _Filter.all) return true;
    final m = homeModeOfSession(agentMode: s.agentMode, desktopDeviceId: s.desktopDeviceId) ?? HomeMode.work;
    return switch (_filter) {
      _Filter.chat => m == HomeMode.chat,
      _Filter.work => m == HomeMode.work,
      _Filter.code => m == HomeMode.code,
      _Filter.all => true,
    };
  }

  @override
  Widget build(BuildContext context) {
    final db = ref.watch(appDatabaseProvider);
    final pinned = ref.watch(pinnedSessionsProvider);
    return ClayPage(
      title: tr('全部'),
      actions: [
        ClayRoundButton(
          flat: true,
          size: 44,
          icon: Icons.search_rounded,
          tooltip: tr('搜索'),
          onTap: () => context.push('/search'),
          child: Icon(Icons.search_rounded, size: 24, color: ClayInk.of(context).ink),
        ),
      ],
      body: StreamBuilder<List<SessionMirrorData>>(
        stream: db.sessionMirrorDao.watchAll(),
        builder: (context, snap) {
          final all = visibleTopLevelSessions(snap.data ?? const []).where(_match).toList();
          final pins = all.where((s) => pinned.contains(s.id)).toList();
          final rest = all.where((s) => !pinned.contains(s.id)).map((s) => (s: s, depth: 0)).toList();
          final groups = groupSessionsByRecency(rest);
          return Column(
            children: [
              ClayFilterPills<_Filter>(
                options: [
                  (_Filter.all, tr('全部')),
                  (_Filter.chat, tr('对话')),
                  (_Filter.work, tr('工作')),
                  (_Filter.code, tr('编码')),
                ],
                value: _filter,
                onChanged: (f) => setState(() => _filter = f),
              ),
              const SizedBox(height: 6),
              Expanded(
                child: all.isEmpty
                    ? ClayEmpty(art: 'empty-shelf', title: tr('还没有会话'), message: tr('回首页说一句就开始了'))
                    : ListView(
                        padding: const EdgeInsets.only(bottom: 24),
                        children: [
                          if (pins.isNotEmpty) ...[
                            ClaySectionLabel(tr('钉住')),
                            for (final s in pins) _SessionRow(session: s),
                          ],
                          for (final g in groups) ...[
                            ClaySectionLabel(g.label),
                            for (final r in g.rows) _SessionRow(session: r.s),
                          ],
                        ],
                      ),
              ),
            ],
          );
        },
      ),
    );
  }
}

String _hm(DateTime t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

class _SessionRow extends ConsumerWidget {
  const _SessionRow({required this.session});

  final SessionMirrorData session;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = ClayInk.of(context);
    final mode = homeModeOfSession(agentMode: session.agentMode, desktopDeviceId: session.desktopDeviceId) ?? HomeMode.work;
    final names = ref.watch(pairedDesktopNamesProvider).valueOrNull ?? const <String, String>{};
    final place = isPhoneLocalDeviceId(session.desktopDeviceId)
        ? (mode == HomeMode.chat ? null : tr('这台手机'))
        : names[session.desktopDeviceId];
    final t = sessionLastTime(session);
    final now = DateTime.now();
    final when = t.year == now.year && t.month == now.month && t.day == now.day ? _hm(t) : '${t.month}/${t.day} ${_hm(t)}';
    final running = ref.watch(runningSessionsProvider).contains(session.id);
    final waiting = ref.watch(sessionPendingApprovalsProvider(session.id)).isNotEmpty;
    final pinned = ref.watch(pinnedSessionsProvider).contains(session.id);
    final row = Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: () {
          openSessionFromList(ref, session);
          context.go('/');
        },
        onLongPress: () => showSessionActions(context, ref, session),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 20, 10),
          child: Row(
            children: [
              ClayTile(
                size: 36,
                icon: switch (mode) {
                  HomeMode.chat => Icons.chat_bubble_outline_rounded,
                  HomeMode.code => Icons.code_rounded,
                  HomeMode.work => Icons.description_outlined,
                },
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(sessionDisplayTitle(session),
                              maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600, color: c.ink)),
                        ),
                        if (pinned) ...[const SizedBox(width: 6), Icon(Icons.push_pin_outlined, size: 14, color: c.grey)],
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text([mode.label, ?place, when].join(' · '),
                        maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12.5, color: c.grey)),
                  ],
                ),
              ),
              if (waiting)
                ClayChip(label: tr('等你'), tone: ClayTone.amber, dense: true, leading: ClayDot(color: c.amber, size: 6))
              else if (running)
                ClayChip(label: tr('执行中'), tone: ClayTone.cobalt, dense: true, leading: const ClaySpinner(size: 10)),
            ],
          ),
        ),
      ),
    );
    return Dismissible(
      key: ValueKey('sess-${session.id}'),
      direction: DismissDirection.endToStart,
      confirmDismiss: (_) async {
        final pick = await showClaySheet<String>(
          context,
          builder: (ctx) => Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              ClaySheetHeader(title: sessionDisplayTitle(session)),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: ClayRow(
                  icon: Icons.push_pin_outlined,
                  title: pinned ? tr('取消钉住') : tr('钉在最上面'),
                  chevron: false,
                  onTap: () => Navigator.pop(ctx, 'pin'),
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: ClayRow(
                  icon: Icons.delete_outline_rounded,
                  title: tr('删除'),
                  danger: true,
                  chevron: false,
                  onTap: () => Navigator.pop(ctx, 'more'),
                ),
              ),
              const SizedBox(height: 12),
            ],
          ),
        );
        if (pick == 'pin') ref.read(pinnedSessionsProvider.notifier).toggle(session.id);
        if (pick == 'more' && context.mounted) await showSessionActions(context, ref, session);
        return false;
      },
      background: Container(
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.only(right: 24),
        color: c.redSoft,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.push_pin_outlined, color: c.ink, size: 20),
            const SizedBox(width: 18),
            Icon(Icons.delete_outline_rounded, color: c.redInk, size: 20),
          ],
        ),
      ),
      child: row,
    );
  }
}
