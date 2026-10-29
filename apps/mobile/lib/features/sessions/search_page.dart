/// search_page.dart — 搜索 (陶土稿 v5「搜索」).
///
///   ← [ 🔍 合同                ✕ ]
///   [全部] 对话 成品
///   对话   修改供应商合同 / …把「合同」里的日期… / 昨天
///   成品   [缩略] 合同修订.docx / 8 页 · 周二
///
/// 命中词用淡钴蓝底标出来。搜不到给空状态 (放大镜 + 空托盘)。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/i18n/tr.dart';
import '../../core/storage/database.dart';
import '../../shared/clay/clay.dart';
import '../../shared/widgets/neox_drawer.dart';
import '../files/deliverables.dart';
import '../home/state/home_mode_provider.dart';
import '../timeline/artifact_preview_page.dart';

enum _Scope { all, sessions, files }

class SearchPage extends ConsumerStatefulWidget {
  const SearchPage({super.key, this.initial = ''});

  final String initial;

  @override
  ConsumerState<SearchPage> createState() => _SearchPageState();
}

class _SearchPageState extends ConsumerState<SearchPage> {
  late final _ctrl = TextEditingController(text: widget.initial);
  _Scope _scope = _Scope.all;

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final q = _ctrl.text.trim();
    final db = ref.watch(appDatabaseProvider);
    final files = ref.watch(deliverablesProvider).valueOrNull ?? const <Deliverable>[];
    return Scaffold(
      backgroundColor: c.canvas,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(6, 8, 16, 10),
              child: Row(
                children: [
                  ClayRoundButton(
                    flat: true,
                    size: 44,
                    icon: Icons.arrow_back_rounded,
                    onTap: () => Navigator.of(context).maybePop(),
                    child: Icon(Icons.arrow_back_rounded, size: 24, color: c.ink),
                  ),
                  Expanded(
                    child: ClayField(
                      controller: _ctrl,
                      hint: tr('搜索对话和成品'),
                      icon: Icons.search_rounded,
                      autofocus: widget.initial.isEmpty,
                      textInputAction: TextInputAction.search,
                      onChanged: (_) => setState(() {}),
                      trailing: q.isEmpty
                          ? null
                          : GestureDetector(
                              onTap: () => setState(_ctrl.clear),
                              child: Icon(Icons.cancel_rounded, size: 18, color: c.faint),
                            ),
                    ),
                  ),
                ],
              ),
            ),
            ClayFilterPills<_Scope>(
              options: [(_Scope.all, tr('全部')), (_Scope.sessions, tr('对话')), (_Scope.files, tr('成品'))],
              value: _scope,
              onChanged: (s) => setState(() => _scope = s),
            ),
            const SizedBox(height: 6),
            Expanded(
              child: StreamBuilder<List<SessionMirrorData>>(
                stream: db.sessionMirrorDao.watchAll(),
                builder: (context, snap) {
                  if (q.isEmpty) {
                    return Center(child: Text(tr('输入关键词，搜对话标题和成品文件名'), style: TextStyle(color: c.grey, fontSize: 13.5)));
                  }
                  final lower = q.toLowerCase();
                  final sessions = _scope == _Scope.files
                      ? const <SessionMirrorData>[]
                      : visibleTopLevelSessions(snap.data ?? const [])
                          .where((s) => (s.title ?? '').toLowerCase().contains(lower) || (s.workspaceName ?? '').toLowerCase().contains(lower))
                          .toList();
                  final hits = _scope == _Scope.sessions
                      ? const <Deliverable>[]
                      : files.where((f) => f.name.toLowerCase().contains(lower)).toList();
                  if (sessions.isEmpty && hits.isEmpty) {
                    return ClayEmpty(art: 'empty-search', title: tr('没找到「$q」'), message: tr('换个说法试试'));
                  }
                  return ListView(
                    padding: const EdgeInsets.only(bottom: 24),
                    children: [
                      if (sessions.isNotEmpty) ...[
                        ClaySectionLabel(tr('对话')),
                        for (final s in sessions.take(30))
                          _Hit(
                            icon: switch (homeModeOfSession(agentMode: s.agentMode, desktopDeviceId: s.desktopDeviceId)) {
                              HomeMode.chat => Icons.chat_bubble_outline_rounded,
                              HomeMode.code => Icons.code_rounded,
                              _ => Icons.description_outlined,
                            },
                            title: sessionDisplayTitle(s),
                            query: q,
                            meta: _ago(sessionLastTime(s)),
                            onTap: () {
                              openSessionFromList(ref, s);
                              context.go('/');
                            },
                          ),
                      ],
                      if (hits.isNotEmpty) ...[
                        ClaySectionLabel(tr('成品')),
                        for (final f in hits.take(30))
                          _Hit(
                            icon: f.kind.icon,
                            title: f.name,
                            query: q,
                            meta: '${f.kind.label} · ${_ago(f.modified)}',
                            onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(
                              builder: (_) => ArtifactPreviewPage(file: f.file, name: f.name),
                            )),
                          ),
                      ],
                    ],
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

String _ago(DateTime t) {
  final d = DateTime.now().difference(t);
  if (d.inMinutes < 1) return tr('刚刚');
  if (d.inHours < 1) return tr('${d.inMinutes} 分钟前');
  if (d.inDays < 1) return tr('${d.inHours} 小时前');
  if (d.inDays == 1) return tr('昨天');
  if (d.inDays < 7) return tr('${d.inDays} 天前');
  return '${t.month}/${t.day}';
}

class _Hit extends StatelessWidget {
  const _Hit({required this.icon, required this.title, required this.query, required this.meta, required this.onTap});

  final IconData icon;
  final String title;
  final String query;
  final String meta;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final base = TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: c.ink);
    final i = title.toLowerCase().indexOf(query.toLowerCase());
    final spans = i < 0
        ? [TextSpan(text: title)]
        : [
            TextSpan(text: title.substring(0, i)),
            TextSpan(text: title.substring(i, i + query.length), style: TextStyle(backgroundColor: c.cobaltSoft, color: c.ink)),
            TextSpan(text: title.substring(i + query.length)),
          ];
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
      child: ClaySlab(
        onTap: onTap,
        padding: const EdgeInsets.fromLTRB(12, 12, 14, 12),
        child: Row(
          children: [
            ClayTile(icon: icon, size: 36),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text.rich(TextSpan(style: base, children: spans), maxLines: 1, overflow: TextOverflow.ellipsis),
                  const SizedBox(height: 2),
                  Text(meta, style: TextStyle(fontSize: 12.5, color: c.grey)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
