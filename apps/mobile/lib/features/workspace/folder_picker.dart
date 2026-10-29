/// folder_picker.dart — 在手机上翻电脑的文件夹，选一个当项目。
///
/// 为什么需要它: 手机端原来只能从「已打开 / 最近」里挑工作区，桌面那边 workspace.open
/// 还要求目标必须在最近会话里出现过 —— 于是"拿电脑上某个文件夹当项目"这件事在手机上
/// 做不到。用户原话："没有选择项目的地方…我想打开电脑上某个文件夹新建工作区，或者是
/// 打开这个项目新建会话，都很难。"
///
/// 边界跟桌面一致: 只能翻用户主目录之下 (桌面 workspace.browse 会拒绝越界)。
///
/// 2026-10-14 按陶土稿 v5 (稿: android/site/img/v5-folder.jpg) 改成泥板样式:
/// 白泥板列表 + 顶部面包屑 + 底部墨色「就这个」。稿里的「新建文件夹」与「最近」分组
/// 暂未做 —— 桌面 workspace 协议还没有建目录的接口, 最近工作区不在这个选择器的数据里。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/ws_client_provider.dart';
import '../../shared/clay/clay.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 打开文件夹选择器。选中并确认后返回该目录路径; 取消返回 null。
Future<String?> pickDesktopFolder(BuildContext context, WidgetRef ref) {
  return showClaySheet<String>(
    context,
    maxHeightFactor: 0.85,
    scrollable: false,
    builder: (_) => const _FolderPickerSheet(),
  );
}

class _FolderPickerSheet extends ConsumerStatefulWidget {
  const _FolderPickerSheet();
  @override
  ConsumerState<_FolderPickerSheet> createState() => _FolderPickerSheetState();
}

class _FolderPickerSheetState extends ConsumerState<_FolderPickerSheet> {
  DirListing? _listing;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load(null);
  }

  Future<void> _load(String? path) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final r = await ref.read(wsClientProvider.notifier).browseDesktopDirs(path: path);
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (r == null) {
        /* 拿不到多半是没连上电脑 —— 说清楚原因, 别只给个空列表让人以为电脑里没文件夹 */
        _error = tr('读不到电脑上的文件夹，请确认电脑端 Neox 在线');
      } else {
        _listing = r;
      }
    });
  }

  /// 把绝对路径显示成 `~/a/b` —— 手机屏窄, 完整路径一行放不下且没信息量。
  String _pretty(String path, String home) {
    if (home.isNotEmpty && path.startsWith(home)) {
      final rest = path.substring(home.length);
      return rest.isEmpty ? '~' : '~$rest';
    }
    return path;
  }

  /// 面包屑: `~` → 每一级目录 (每级带它自己的绝对路径, 点了直接跳过去)。
  /// 不在主目录下时只有一段完整路径。
  List<({String label, String path})> _crumbs(DirListing listing) {
    final path = listing.path;
    final home = listing.home;
    if (home.isEmpty || !path.startsWith(home)) {
      return [(label: path, path: path)];
    }
    final sep = path.contains('\\') && !path.contains('/') ? '\\' : '/';
    final segs = path
        .substring(home.length)
        .split(RegExp(r'[\\/]'))
        .where((s) => s.isNotEmpty)
        .toList();
    final out = <({String label, String path})>[(label: '~', path: home)];
    var acc = home;
    for (final s in segs) {
      acc = acc.endsWith(sep) ? '$acc$s' : '$acc$sep$s';
      out.add((label: s, path: acc));
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final listing = _listing;
    return Column(
      children: [
        ClaySheetHeader(title: tr('在哪个项目里')),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.only(bottom: 12),
            children: [
              ClaySectionLabel(tr('浏览')),
              if (listing != null && !_loading && _error == null) _breadcrumb(c, listing),
              _body(c, listing),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
          child: ClayButton.ink(
            label: tr('就这个'),
            expand: true,
            onTap: (listing == null || _loading)
                ? null
                : () => Navigator.pop(context, listing.path),
          ),
        ),
      ],
    );
  }

  Widget _breadcrumb(ClayInk c, DirListing listing) {
    final crumbs = _crumbs(listing);
    final base = TextStyle(fontSize: 13.5, color: c.grey, height: 1.3);
    final row = <Widget>[];
    for (var i = 0; i < crumbs.length; i++) {
      final last = i == crumbs.length - 1;
      if (i > 0) row.add(Text(' / ', style: base));
      row.add(GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: last || _loading ? null : () => _load(crumbs[i].path),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Text(
            crumbs[i].label,
            style: last ? base.copyWith(color: c.ink, fontWeight: FontWeight.w600) : base,
          ),
        ),
      ));
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      child: Row(
        children: [
          if (listing.parent != null)
            IconButton(
              icon: Icon(Icons.arrow_upward_rounded, size: 20, color: c.grey),
              tooltip: tr('上一级'),
              onPressed: _loading ? null : () => _load(listing.parent),
            ),
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              reverse: true,
              child: Row(mainAxisSize: MainAxisSize.min, children: row),
            ),
          ),
        ],
      ),
    );
  }

  Widget _body(ClayInk c, DirListing? listing) {
    if (_loading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 48),
        child: Center(child: ClaySpinner(size: 22)),
      );
    }
    if (_error != null) {
      return ClayEmpty(art: 'empty-offline', title: _error!);
    }
    if (listing == null) return const SizedBox.shrink();
    if (listing.entries.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 32),
        child: Center(
          child: Text(
            tr('这个文件夹里没有子文件夹'),
            style: TextStyle(fontSize: 13.5, color: c.grey),
          ),
        ),
      );
    }
    return ClayGroup(
      children: [
        for (final e in listing.entries)
          ClayRow(
            icon: e.isRepo ? Icons.folder_special_outlined : Icons.folder_outlined,
            title: e.name,
            subtitle: _pretty(e.path, listing.home),
            value: e.isRepo ? tr('Git 项目') : null,
            onTap: () => _load(e.path),
          ),
      ],
    );
  }
}
