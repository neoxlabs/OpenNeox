/// image_gallery.dart — 「我画过的」画布列表.
///
/// 走查发现的洞: 图片工作台只有一个「+ 新建」, 点一下就换一张空白画布, **上一张
/// 再也找不回来**。那些画布是 kind='image' 的本地会话, 一直躺在库里, 只是没有
/// 任何入口能看到它们 —— 同时又混进了聊天抽屉的「最近」列表 (那边没按 kind
/// 过滤), 两头都不对。
///
/// 这里给它一个正经的家: 缩略图网格 + 标题 + 时间, 点进去接着改, 长按可删。
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/storage/app_paths.dart';
import '../../core/storage/database.dart';
import '../../shared/theme/neox_tokens.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 一张画布 + 它的封面图 (最近一次成功出图的第一张).
class _Canvas {
  const _Canvas({required this.session, this.coverPath});
  final SessionMirrorData session;
  final String? coverPath;
}

/// 打开画廊, 返回用户选中的 sessionId; 关掉返回 null.
Future<String?> showImageGallery(BuildContext context, WidgetRef ref) {
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    backgroundColor: Theme.of(context).colorScheme.surface,
    builder: (ctx) => const _GallerySheet(),
  );
}

class _GallerySheet extends ConsumerStatefulWidget {
  const _GallerySheet();

  @override
  ConsumerState<_GallerySheet> createState() => _GallerySheetState();
}

class _GallerySheetState extends ConsumerState<_GallerySheet> {
  late Future<List<_Canvas>> _future = _load();

  Future<List<_Canvas>> _load() async {
    final db = ref.read(appDatabaseProvider);
    final all = await db.sessionMirrorDao.getAll();
    final canvases = all.where((s) => s.kind == 'image').toList()
      ..sort(
        (a, b) => (b.lastMessageAt ?? b.createdAt).compareTo(
          a.lastMessageAt ?? a.createdAt,
        ),
      );

    final out = <_Canvas>[];
    for (final s in canvases) {
      out.add(_Canvas(session: s, coverPath: await _coverOf(db, s.id)));
    }
    /* 一张图都没出过的空画布不列 —— 用户点了「+」又没画就退出去的那些,
     * 列出来只是一格灰底, 徒增噪音。 */
    return out.where((c) => c.coverPath != null).toList();
  }

  Future<String?> _coverOf(AppDatabase db, String sessionId) async {
    try {
      final events = await db.sessionEventsDao.getBySessionId(sessionId);
      for (final ev in events.reversed) {
        if (ev.kind != 'direct_image') continue;
        final p = jsonDecode(ev.payload);
        if (p is! Map || p['status'] != 'ok') continue;
        final paths = p['paths'];
        if (paths is! List) continue;
        for (final path in paths.whereType<String>().map(AppPaths.rebase)) {
          if (File(path).existsSync()) return path;
        }
      }
    } catch (_) {
      /* 坏数据当没封面 */
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return SafeArea(
      child: ConstrainedBox(
        /* minWidth 撑满: 空状态只有一行字时, 面板会缩成那行字的宽度浮在屏幕中间 */
        constraints: BoxConstraints(
          minWidth: double.infinity,
          maxHeight: MediaQuery.sizeOf(context).height * 0.8,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(
                NeoxSpace.xl,
                0,
                NeoxSpace.xl,
                NeoxSpace.md,
              ),
              child: Text(
                tr('我画过的'),
                style: theme.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            Flexible(
              child: FutureBuilder<List<_Canvas>>(
                future: _future,
                builder: (context, snap) {
                  if (snap.connectionState != ConnectionState.done) {
                    return const Padding(
                      padding: EdgeInsets.symmetric(vertical: 40),
                      child: Center(child: CircularProgressIndicator()),
                    );
                  }
                  final items = snap.data ?? const <_Canvas>[];
                  if (items.isEmpty) {
                    return Padding(
                      padding: const EdgeInsets.fromLTRB(
                        NeoxSpace.xl,
                        NeoxSpace.md,
                        NeoxSpace.xl,
                        NeoxSpace.xxxl,
                      ),
                      child: Text(
                        tr('画好的图会保存在这里'),
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                    );
                  }
                  return GridView.builder(
                    padding: const EdgeInsets.fromLTRB(
                      NeoxSpace.lg,
                      0,
                      NeoxSpace.lg,
                      NeoxSpace.xl,
                    ),
                    gridDelegate:
                        const SliverGridDelegateWithFixedCrossAxisCount(
                          crossAxisCount: 3,
                          mainAxisSpacing: NeoxSpace.sm,
                          crossAxisSpacing: NeoxSpace.sm,
                          childAspectRatio: 0.78,
                        ),
                    itemCount: items.length,
                    itemBuilder: (context, i) =>
                        _CanvasTile(canvas: items[i], onDeleted: _reload),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _reload() => setState(() => _future = _load());
}

class _CanvasTile extends ConsumerWidget {
  const _CanvasTile({required this.canvas, required this.onDeleted});

  final _Canvas canvas;
  final VoidCallback onDeleted;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final title = (canvas.session.title ?? '').trim();

    return GestureDetector(
      onTap: () => Navigator.pop(context, canvas.session.id),
      onLongPress: () => _confirmDelete(context, ref),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: ClipRRect(
              borderRadius: NeoxRadius.inputR,
              child: Container(
                width: double.infinity,
                color: scheme.surfaceContainerHigh,
                child: canvas.coverPath == null
                    ? Icon(Icons.image_outlined, color: scheme.onSurfaceVariant)
                    : Image.file(
                        File(canvas.coverPath!),
                        fit: BoxFit.cover,
                        errorBuilder: (_, __, ___) => Icon(
                          Icons.broken_image_outlined,
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
              ),
            ),
          ),
          const SizedBox(height: 4),
          Text(
            title.isEmpty ? tr('未命名') : title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.labelSmall?.copyWith(fontSize: 12.5),
          ),
        ],
      ),
    );
  }

  Future<void> _confirmDelete(BuildContext context, WidgetRef ref) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(tr('删掉这张画布?')),
        content: Text(tr('里面的图会一起删除，无法恢复。')),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(tr('取消')),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(
              foregroundColor: Theme.of(ctx).colorScheme.error,
            ),
            child: Text(tr('删除')),
          ),
        ],
      ),
    );
    if (ok != true) return;
    final db = ref.read(appDatabaseProvider);
    await db.sessionEventsDao.deleteBySessionId(canvas.session.id);
    await db.sessionMirrorDao.deleteById(canvas.session.id);
    onDeleted();
  }
}
