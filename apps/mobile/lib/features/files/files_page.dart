/// files_page.dart — 「成品」(陶土稿 v4-shelf): 手机上 Agent 做出来的文件, 一处找齐.
///
///   ☰  成品                              ⌕
///   [全部] [幻灯片] [表格] [文档] [图片] [网页] …
///   今天
///   ┌ 缩略 ┐ ┌ 缩略 ┐      两列卡: 上半缩略 (图片是图本身, 其它是一张平的「纸」),
///   │ 名字 │ │ 名字 │      下面名字 + 「大小 · 来自「会话名」」
///   本周 / 更早 …
///
/// 点开预览 (预览不了的直接分享), 长按: 分享 / 回到那个对话 / 删除。
/// 侧栏顶级去处 (跟 Pilot 一样): 左上 ☰ 拉侧栏, 不是返回。
/// 只列「成品」—— 扫描规则见 deliverables.dart (跳过依赖 / 源码)。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/i18n/tr.dart';
import '../../core/storage/database.dart';
import '../../shared/clay/clay.dart';
import '../../shared/widgets/neox_drawer.dart';
import '../home/state/current_session_provider.dart';
import '../home/state/home_mode_provider.dart';
import '../timeline/artifact_preview_page.dart';
import 'deliverables.dart';

class FilesPage extends ConsumerStatefulWidget {
  const FilesPage({super.key});

  @override
  ConsumerState<FilesPage> createState() => _FilesPageState();
}

class _FilesPageState extends ConsumerState<FilesPage> {
  final _scaffold = GlobalKey<ScaffoldState>();
  final _query = TextEditingController();
  DeliverableKind? _kind;
  bool _searching = false;

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  Future<void> _open(Deliverable it) async {
    if (ArtifactPreviewPage.canPreview(it.name)) {
      await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ArtifactPreviewPage(file: it.file, name: it.name)));
    } else {
      await _share(it);
    }
  }

  Future<void> _share(Deliverable it) async {
    final box = context.findRenderObject() as RenderBox?;
    await Share.shareXFiles(
      [XFile(it.file.path, name: it.name)],
      sharePositionOrigin: box == null ? null : box.localToGlobal(Offset.zero) & box.size,
    );
  }

  Future<void> _more(Deliverable it, String? sessionId) async {
    final act = await showClaySheet<String>(
      context,
      builder: (ctx) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ClaySheetHeader(title: it.name),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Column(children: [
              ClayRow(icon: Icons.ios_share_rounded, title: tr('分享'), chevron: false, onTap: () => Navigator.pop(ctx, 'share')),
              if (sessionId != null)
                ClayRow(icon: Icons.chat_bubble_outline_rounded, title: tr('回到那个对话'), chevron: false, onTap: () => Navigator.pop(ctx, 'session')),
              ClayRow(icon: Icons.delete_outline_rounded, title: tr('删除'), danger: true, chevron: false, onTap: () => Navigator.pop(ctx, 'delete')),
            ]),
          ),
          const SizedBox(height: 12),
        ],
      ),
    );
    if (!mounted) return;
    switch (act) {
      case 'share':
        await _share(it);
      case 'session':
        ref.read(currentSessionProvider.notifier).set(sessionId);
        context.go('/');
      case 'delete':
        await _delete(it);
    }
  }

  Future<void> _delete(Deliverable it) async {
    final ok = await showClaySheet<bool>(
      context,
      builder: (ctx) => Padding(
        padding: const EdgeInsets.fromLTRB(24, 4, 24, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(tr('删掉「%s」？').replaceFirst('%s', it.name), style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: ClayInk.of(ctx).ink)),
            const SizedBox(height: 8),
            Text(tr('对话里这个文件的卡片也会打不开。'), style: TextStyle(fontSize: 14.5, color: ClayInk.of(ctx).grey)),
            const SizedBox(height: 22),
            Row(children: [
              Expanded(child: ClayButton(label: tr('取消'), size: ClayButtonSize.large, expand: true, onTap: () => Navigator.pop(ctx, false))),
              const SizedBox(width: 12),
              Expanded(
                child: ClayButton(label: tr('删掉'), kind: ClayButtonKind.danger, size: ClayButtonSize.large, expand: true, onTap: () => Navigator.pop(ctx, true)),
              ),
            ]),
          ],
        ),
      ),
    );
    if (ok != true) return;
    try {
      await it.file.delete();
    } catch (_) {}
    ref.invalidate(deliverablesProvider);
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final async = ref.watch(deliverablesProvider);
    final all = (async.valueOrNull ?? const <Deliverable>[]).where((d) => !d.uploaded).toList();
    final q = _query.text.trim().toLowerCase();
    final shown = all.where((d) => (_kind == null || d.kind == _kind) && (q.isEmpty || d.name.toLowerCase().contains(q))).toList();
    /* 只给有东西的类型出筛选签 */
    final kinds = [for (final k in DeliverableKind.values) if (all.any((d) => d.kind == k)) k];

    return Scaffold(
      key: _scaffold,
      backgroundColor: c.canvas,
      drawer: const NeoxDrawer(here: 'files'),
      body: SafeArea(
        child: Column(
          children: [
            ClayTopBar(
              leading: ClayRoundButton(
                flat: true,
                size: 44,
                icon: Icons.menu_rounded,
                tooltip: tr('菜单'),
                onTap: () => _scaffold.currentState?.openDrawer(),
              ),
              titleWidget: _searching
                  ? TextField(
                      controller: _query,
                      autofocus: true,
                      onChanged: (_) => setState(() {}),
                      style: TextStyle(fontSize: 17, color: c.ink),
                      cursorColor: c.cobalt,
                      decoration: InputDecoration(
                        isDense: true,
                        border: InputBorder.none,
                        hintText: tr('找文件名'),
                        hintStyle: TextStyle(fontSize: 17, color: c.faint),
                      ),
                    )
                  : Text(tr('成品'), style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: c.ink)),
              actions: [
                ClayRoundButton(
                  flat: true,
                  size: 44,
                  icon: _searching ? Icons.close_rounded : Icons.search_rounded,
                  tooltip: _searching ? tr('关闭搜索') : tr('搜索'),
                  onTap: () => setState(() {
                    _searching = !_searching;
                    if (!_searching) _query.clear();
                  }),
                ),
              ],
            ),
            if (kinds.length > 1) ...[
              const SizedBox(height: 6),
              ClayFilterPills<DeliverableKind?>(
                options: [(null, tr('全部')), for (final k in kinds) (k, k.label)],
                value: _kind,
                onChanged: (k) => setState(() => _kind = k),
              ),
            ],
            Expanded(
              child: async.isLoading && async.valueOrNull == null
                  ? const Center(child: ClaySpinner(size: 22))
                  : shown.isEmpty
                      ? _empty(all.isEmpty, q)
                      : RefreshIndicator(
                          color: c.cobalt,
                          onRefresh: () async => ref.invalidate(deliverablesProvider),
                          child: _Grid(items: shown, onOpen: _open, onMore: _more),
                        ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _empty(bool nothingAtAll, String q) {
    if (q.isNotEmpty) {
      return ClayEmpty(art: 'empty-search', title: tr('没找到「%s」').replaceFirst('%s', _query.text.trim()), message: tr('换个说法试试'));
    }
    if (!nothingAtAll) {
      return ClayEmpty(art: 'empty-shelf', title: tr('这一类还没有'), action: ClayButton(label: tr('看全部'), onTap: () => setState(() => _kind = null)));
    }
    return ClayEmpty(
      art: 'empty-shelf',
      title: tr('还没有成品'),
      message: tr('做好的幻灯片、表格都会放在这'),
      action: ClayButton(
        label: tr('去做一个'),
        onTap: () {
          ref.read(homeModeProvider.notifier).set(HomeMode.work);
          ref.read(currentSessionProvider.notifier).set(null);
          context.go('/');
        },
      ),
    );
  }
}

/// 按「今天 / 本周 / 更早」分组的两列网格.
class _Grid extends StatelessWidget {
  const _Grid({required this.items, required this.onOpen, required this.onMore});
  final List<Deliverable> items;
  final ValueChanged<Deliverable> onOpen;
  final void Function(Deliverable, String?) onMore;

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final weekStart = today.subtract(Duration(days: today.weekday - 1));
    String bucket(DateTime t) => !t.isBefore(today) ? tr('今天') : (!t.isBefore(weekStart) ? tr('本周') : tr('更早'));
    final groups = <String, List<Deliverable>>{};
    for (final d in items) {
      groups.putIfAbsent(bucket(d.modified), () => []).add(d);
    }
    return CustomScrollView(
      physics: const AlwaysScrollableScrollPhysics(),
      slivers: [
        for (final g in groups.entries) ...[
          SliverToBoxAdapter(child: ClaySectionLabel(g.key)),
          SliverPadding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            sliver: SliverGrid(
              gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: 2,
                mainAxisSpacing: 12,
                crossAxisSpacing: 12,
                childAspectRatio: 0.82,
              ),
              delegate: SliverChildBuilderDelegate(
                (context, i) => _Card(item: g.value[i], onOpen: onOpen, onMore: onMore),
                childCount: g.value.length,
              ),
            ),
          ),
        ],
        const SliverToBoxAdapter(child: SizedBox(height: 40)),
      ],
    );
  }
}

class _Card extends ConsumerWidget {
  const _Card({required this.item, required this.onOpen, required this.onMore});
  final Deliverable item;
  final ValueChanged<Deliverable> onOpen;
  final void Function(Deliverable, String?) onMore;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = ClayInk.of(context);
    /* 工作区第一段是会话 id —— 拿来写「来自「季度销售复盘」」, 也给「回到那个对话」用 */
    final first = item.rel.contains('/') ? item.rel.split('/').first : null;
    return FutureBuilder<SessionMirrorData?>(
      future: first == null ? null : ref.read(appDatabaseProvider).sessionMirrorDao.findById(first),
      builder: (context, snap) {
        final s = snap.data;
        final from = s?.title?.trim();
        final meta = [
          _size(item.stat.size),
          if (from != null && from.isNotEmpty) tr('来自「%s」').replaceFirst('%s', from),
        ].join(' · ');
        return ClaySlab(
          radius: 18,
          padding: const EdgeInsets.all(10),
          onTap: () => onOpen(item),
          onLongPress: () => onMore(item, s?.id),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: ClipRRect(borderRadius: BorderRadius.circular(12), child: _Thumb(item: item))),
              const SizedBox(height: 10),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: Text(item.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600, color: c.ink)),
              ),
              const SizedBox(height: 3),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: Text(meta, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, color: c.grey)),
              ),
              const SizedBox(height: 2),
            ],
          ),
        );
      },
    );
  }

  static String _size(int b) {
    if (b < 1024) return '$b B';
    if (b < 1024 * 1024) return '${(b / 1024).toStringAsFixed(0)} KB';
    return '${(b / 1024 / 1024).toStringAsFixed(1)} MB';
  }
}

/// 卡片上半的缩略: 图片就是图本身; 其它画一张平的「纸」(幻灯片有标题+柱, 表格是格子, 文档是行).
class _Thumb extends StatelessWidget {
  const _Thumb({required this.item});
  final Deliverable item;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    if (item.kind == DeliverableKind.image && !item.name.toLowerCase().endsWith('.svg')) {
      return Image.file(
        item.file,
        fit: BoxFit.cover,
        width: double.infinity,
        cacheWidth: 400,
        errorBuilder: (_, __, ___) => _paper(c),
      );
    }
    return _paper(c);
  }

  Widget _paper(ClayInk c) {
    final bar = c.line;
    Widget line(double w, {Color? color, double h = 4}) => FractionallySizedBox(
          widthFactor: w,
          alignment: Alignment.centerLeft,
          child: Container(height: h, decoration: BoxDecoration(color: color ?? bar, borderRadius: BorderRadius.circular(2))),
        );
    final paper = switch (item.kind) {
      DeliverableKind.slide => AspectRatio(
          aspectRatio: 16 / 10,
          child: Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: c.slab, borderRadius: BorderRadius.circular(6)),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [line(0.8, color: c.ink.withValues(alpha: 0.7), h: 5), const SizedBox(height: 8), line(0.6), const SizedBox(height: 4), line(0.5)],
                  ),
                ),
                for (final h in [0.25, 0.4, 0.55, 0.75])
                  Container(
                    width: 6,
                    margin: const EdgeInsets.only(left: 3),
                    child: FractionallySizedBox(heightFactor: h, alignment: Alignment.bottomCenter, child: Container(color: c.cobalt.withValues(alpha: 0.75))),
                  ),
              ],
            ),
          ),
        ),
      DeliverableKind.sheet => Container(
          decoration: BoxDecoration(color: c.slab, borderRadius: BorderRadius.circular(6)),
          clipBehavior: Clip.antiAlias,
          child: Column(
            children: [
              Container(height: 8, color: c.green.withValues(alpha: 0.7)),
              for (var r = 0; r < 6; r++)
                Expanded(
                  child: Row(children: [
                    for (var col = 0; col < 4; col++)
                      Expanded(child: Container(decoration: BoxDecoration(border: Border(right: BorderSide(color: bar, width: 0.6), bottom: BorderSide(color: bar, width: 0.6))))),
                  ]),
                ),
            ],
          ),
        ),
      _ => Container(
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
          decoration: BoxDecoration(color: c.slab, borderRadius: BorderRadius.circular(6)),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              line(0.4, color: c.cobalt.withValues(alpha: 0.6)),
              const SizedBox(height: 8),
              for (final w in [0.9, 0.8, 0.85, 0.6, 0.75]) ...[line(w), const SizedBox(height: 6)],
            ],
          ),
        ),
    };
    return Container(
      color: c.fill,
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 0),
      alignment: Alignment.bottomCenter,
      child: Stack(
        children: [
          Positioned.fill(child: Align(alignment: Alignment.bottomCenter, child: paper)),
          if (item.kind != DeliverableKind.slide && item.kind != DeliverableKind.sheet && item.kind != DeliverableKind.doc)
            Positioned(right: 4, top: 0, child: Icon(item.kind.icon, size: 18, color: c.grey)),
        ],
      ),
    );
  }
}
