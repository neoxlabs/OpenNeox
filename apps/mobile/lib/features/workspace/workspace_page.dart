/// workspace_page.dart — Desktop 工作区入口.
///
/// 这里承接桌面版的 workspace 心智: 手机不是只看会话列表, 也能按 Desktop
/// 当前/最近工作区进入 agent。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/ws_client_provider.dart';
import '../../core/storage/database.dart';
import '../../core/storage/paired_desktop_kind.dart';
import '../../shared/widgets/neox_section.dart';
import '../../shared/theme/neox_tokens.dart';
import '../../shared/widgets/neox_inline_empty.dart';
import '../home/state/current_session_provider.dart' show openSessionOnHome;
import '../home/widgets/new_session_project.dart' show enterProject;
import '../settings/unpair_desktop.dart';
import 'folder_picker.dart';
import 'package:neox_app/core/i18n/tr.dart';

class WorkspacePage extends ConsumerStatefulWidget {
  const WorkspacePage({super.key});

  @override
  ConsumerState<WorkspacePage> createState() => _WorkspacePageState();
}

class _WorkspacePageState extends ConsumerState<WorkspacePage> {
  Future<_WorkspaceSnapshot>? _snapshotFuture;
  String? _snapshotKey;
  String? _busyPath;

  bool _isCloudVirtual(PairedDesktop d) => isCloudAgentPairedDesktop(d);

  bool _isDesktopConnected(WsClientState state) {
    return state.connection == WsConnectionState.connected &&
        state.transport != WsTransport.cloudAgent &&
        state.activeDesktopDeviceId != null;
  }

  void _ensureSnapshot(WsClientState state) {
    if (!_isDesktopConnected(state)) return;
    final key = '${state.activeDesktopDeviceId}:${state.transport}';
    if (_snapshotKey == key && _snapshotFuture != null) return;
    _snapshotKey = key;
    _snapshotFuture = _loadSnapshot();
  }

  Future<_WorkspaceSnapshot> _loadSnapshot() async {
    final ws = ref.read(wsClientProvider.notifier);
    final results = await Future.wait<List<WorkspaceInfo>>([
      ws.fetchWorkspaces(),
      ws.fetchRecentWorkspaces(),
    ]);
    final open = results[0];
    final recent = results[1];
    final openPaths = open.map((w) => w.path).toSet();
    return _WorkspaceSnapshot(
      open: open,
      recent: recent.where((w) => !openPaths.contains(w.path)).toList(),
    );
  }

  void _refreshWorkspaces() {
    setState(() {
      _snapshotFuture = _loadSnapshot();
    });
  }

  Future<void> _connectDesktop(PairedDesktop desktop) async {
    await ref
        .read(wsClientProvider.notifier)
        .connectToDesktop(desktop.deviceId);
    if (mounted) _refreshWorkspaces();
  }

  /// 翻电脑上的文件夹 → 选中 → 在那里打开工作区并起一条新会话。
  ///
  /// 走的是 _enterWorkspace 同一条路 (enterProject),
  /// 只是工作区来源从"列表里挑"换成"自己翻出来的目录"。
  Future<void> _browseAndOpen() async {
    final picked = await pickDesktopFolder(context, ref);
    if (picked == null || picked.isEmpty || !mounted) return;
    final name =
        picked.split('/').where((s) => s.isNotEmpty).lastOrNull ?? picked;
    await _enterWorkspace(WorkspaceInfo(path: picked, name: name));
    if (mounted) _refreshWorkspaces();
  }

  /// 已开着的工作区再 open 一次是幂等的 (电脑回 already_open), 不用区分。
  Future<void> _enterWorkspace(WorkspaceInfo workspace) async {
    if (_busyPath != null || workspace.path.isEmpty) return;
    setState(() => _busyPath = workspace.path);
    try {
      /* 跟首页挑项目同一条路 (enterProject): 进项目 = 新会话。
       * 原来这里也是「有最近会话就打开那条」, 于是在项目里开新会话做不到 (2026-09-22)。
       * 想接着干的, 下面会话列表里点那一条。 */
      await enterProject(
        context,
        ref,
        path: workspace.path,
        name: workspace.name,
      );
    } finally {
      if (mounted) setState(() => _busyPath = null);
    }
  }


  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final db = ref.watch(appDatabaseProvider);
    final wsState = ref.watch(wsClientProvider);
    _ensureSnapshot(wsState);

    return Scaffold(
      backgroundColor: theme.colorScheme.surfaceContainerLowest,
      appBar: AppBar(
        backgroundColor: theme.colorScheme.surfaceContainerLowest,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        title: Text(
          tr('工作区'),
          style: theme.textTheme.titleMedium?.copyWith(
            fontWeight: FontWeight.w600,
          ),
        ),
        actions: [
          IconButton(
            tooltip: tr('刷新'),
            icon: const Icon(Icons.refresh, size: 18),
            onPressed: _isDesktopConnected(wsState) ? _refreshWorkspaces : null,
          ),
          const SizedBox(width: 6),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(
            height: 1,
            color: theme.colorScheme.outlineVariant.withValues(alpha: 0.4),
          ),
        ),
      ),
      body: StreamBuilder<List<PairedDesktop>>(
        stream: db.pairedDesktopsDao.watchAll(),
        builder: (context, pairedSnap) {
          final paired = pairedSnap.data ?? const <PairedDesktop>[];
          final desktops = paired.where((d) => !_isCloudVirtual(d)).toList();
          final activeDesktop = _findDesktop(
            desktops,
            wsState.activeDesktopDeviceId,
          );

          return StreamBuilder<List<SessionMirrorData>>(
            stream: db.sessionMirrorDao.watchAll(),
            builder: (context, mirrorSnap) {
              final mirrors = mirrorSnap.data ?? const <SessionMirrorData>[];
              final activeMirrors = activeDesktop == null
                  ? const <SessionMirrorData>[]
                  : mirrors
                        .where(
                          (m) => m.desktopDeviceId == activeDesktop.deviceId,
                        )
                        .toList();

              return ListView(
                children: [
                  /* 一台电脑都没配过时不画连接面板: 它和下面「连接电脑」那行说的是同一件事
                   * (2026-09-17 走查: 「未连接电脑 · 连接电脑后可直接打开本机工作区 [配对]」
                   * 紧接着「连接电脑 · 扫码或同账号自动发现后才能打开本机工作区」)。 */
                  if (desktops.isNotEmpty) ...[
                    NeoxSectionLabel(text: tr('连接')),
                    _ConnectionPanel(
                      state: wsState,
                      activeDesktop: activeDesktop,
                    ),
                  ],
                  NeoxSectionLabel(text: tr('我的电脑')),
                  if (desktops.isEmpty)
                    NeoxListRow(
                      leading: const Icon(Icons.qr_code_scanner_outlined),
                      title: tr('连接电脑'),
                      subtitle: tr('连上后在这里打开电脑上的项目'),
                      trailing: const Icon(Icons.chevron_right, size: 18),
                      onTap: () => context.push('/pairing'),
                    )
                  else
                    for (final desktop in desktops)
                      _DesktopRow(
                        desktop: desktop,
                        selected:
                            desktop.deviceId == wsState.activeDesktopDeviceId,
                        state: desktop.deviceId == wsState.activeDesktopDeviceId
                            ? wsState.connection
                            : WsConnectionState.disconnected,
                        onTap: () => _connectDesktop(desktop),
                        onLongPress: () =>
                            showPairedDesktopActions(context, ref, desktop),
                      ),
                  if (_isDesktopConnected(wsState)) ...[
                    /* 刷新只留顶栏那一个 */
                    NeoxSectionLabel(text: tr('当前打开')),
                    /* 「打开电脑上的文件夹」—— 这页原来只能从"已打开/最近"里挑,
                     * 想拿电脑上任意一个项目目录开工在手机上根本做不到。 */
                    ListTile(
                      leading: const Icon(Icons.folder_open_outlined, size: 22),
                      title: Text(tr('打开电脑上的文件夹')),
                      subtitle: Text(tr('选一个项目目录开始')),
                      trailing: const Icon(Icons.chevron_right, size: 18),
                      onTap: _busyPath != null ? null : _browseAndOpen,
                    ),
                    const Divider(height: 1),
                    FutureBuilder<_WorkspaceSnapshot>(
                      future: _snapshotFuture,
                      builder: (context, snap) {
                        if (snap.connectionState != ConnectionState.done) {
                          return const _LoadingRows();
                        }
                        final data =
                            snap.data ??
                            const _WorkspaceSnapshot(open: [], recent: []);
                        if (data.open.isEmpty && data.recent.isEmpty) {
                          return NeoxInlineEmpty(
                            icon: Icons.folder_outlined,
                            title: tr('这台电脑没有可用工作区'),
                            subtitle: tr('在电脑端打开一个目录后显示'),
                          );
                        }
                        return Column(
                          children: [
                            for (final workspace in data.open)
                              _WorkspaceRow(
                                workspace: workspace,
                                busy: _busyPath == workspace.path,
                                current: true,
                                onTap: () => _enterWorkspace(workspace),
                              ),
                            if (data.recent.isNotEmpty)
                              NeoxSectionLabel(text: tr('最近使用')),
                            for (final workspace in data.recent)
                              _WorkspaceRow(
                                workspace: workspace,
                                busy: _busyPath == workspace.path,
                                current: false,
                                onTap: () => _enterWorkspace(workspace),
                              ),
                          ],
                        );
                      },
                    ),
                    if (activeMirrors.isNotEmpty) ...[
                      NeoxSectionLabel(text: tr('工作区任务')),
                      for (final row in _workspaceSessionRows(activeMirrors))
                        NeoxListRow(
                          leading: const Icon(Icons.folder_outlined),
                          title: row.name,
                          subtitle: tr('${row.count} 个任务'),
                          trailing: const Icon(Icons.chevron_right, size: 18),
                          onTap: row.latestSessionId == null
                              ? null
                              : () => openSessionOnHome(
                                  context,
                                  ref,
                                  row.latestSessionId!,
                                ),
                        ),
                    ],
                  ],
                  const SizedBox(height: 32),
                ],
              );
            },
          );
        },
      ),
    );
  }

  PairedDesktop? _findDesktop(List<PairedDesktop> items, String? id) {
    if (id == null) return null;
    for (final item in items) {
      if (item.deviceId == id) return item;
    }
    return null;
  }

  List<_WorkspaceSessionRow> _workspaceSessionRows(
    List<SessionMirrorData> mirrors,
  ) {
    final groups = <String, List<SessionMirrorData>>{};
    for (final mirror in mirrors) {
      final name = mirror.workspaceName?.trim();
      final key = name == null || name.isEmpty ? tr('未命名工作区') : name;
      groups.putIfAbsent(key, () => <SessionMirrorData>[]).add(mirror);
    }
    final rows = <_WorkspaceSessionRow>[];
    for (final entry in groups.entries) {
      entry.value.sort(
        (a, b) => (b.lastMessageAt ?? b.createdAt).compareTo(
          a.lastMessageAt ?? a.createdAt,
        ),
      );
      rows.add(
        _WorkspaceSessionRow(
          name: entry.key,
          count: entry.value.length,
          latestSessionId: entry.value.first.id,
        ),
      );
    }
    rows.sort((a, b) => b.count.compareTo(a.count));
    return rows;
  }
}

class _WorkspaceSnapshot {
  const _WorkspaceSnapshot({required this.open, required this.recent});

  final List<WorkspaceInfo> open;
  final List<WorkspaceInfo> recent;
}

class _WorkspaceSessionRow {
  const _WorkspaceSessionRow({
    required this.name,
    required this.count,
    required this.latestSessionId,
  });

  final String name;
  final int count;
  final String? latestSessionId;
}

class _ConnectionPanel extends StatelessWidget {
  const _ConnectionPanel({required this.state, required this.activeDesktop});

  final WsClientState state;
  final PairedDesktop? activeDesktop;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final connected =
        state.connection == WsConnectionState.connected &&
        state.transport != WsTransport.cloudAgent;
    final color = connected
        ? NeoxClaudePalette.success
        : state.connection == WsConnectionState.connecting
        ? NeoxClaudePalette.warning
        : state.connection == WsConnectionState.error
        ? theme.colorScheme.error
        : theme.colorScheme.outline;
    final title = connected
        ? activeDesktop?.deviceName ?? activeDesktop?.deviceId ?? tr('我的电脑已连接')
        : state.connection == WsConnectionState.connecting
        ? tr('正在连接我的电脑')
        : state.connection == WsConnectionState.error
        ? tr('电脑连接失败')
        : tr('未连接电脑');
    final subtitle = connected
        ? switch (state.transport) {
            WsTransport.lan => tr('同 Wi-Fi 直连'),
            WsTransport.cloudRelay => tr('远程连接'),
            WsTransport.cloudAgent => tr('云端任务运行中'),
            WsTransport.none => tr('已连接'),
          }
        : state.errorMessage ?? tr('点下面的电脑连接');

    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 6, 20, 12),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainer.withValues(alpha: 0.65),
          borderRadius: NeoxRadius.chipR,
          border: Border.all(
            color: theme.colorScheme.outlineVariant.withValues(alpha: 0.35),
          ),
        ),
        child: Row(
          children: [
            Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(color: color, shape: BoxShape.circle),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DesktopRow extends StatelessWidget {
  const _DesktopRow({
    required this.desktop,
    required this.selected,
    required this.state,
    required this.onTap,
    this.onLongPress,
  });

  final PairedDesktop desktop;
  final bool selected;
  final WsConnectionState state;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final parts = <String>[
      if (desktop.lastSeenLanIp != null)
        '${desktop.lastSeenLanIp}:${desktop.lastSeenLanPort ?? '-'}',
      if (selected) _stateLabel(state),
    ];
    final joined = parts.join(' · ');
    final subtitle = parts.isEmpty
        ? tr('点击连接 · 长按可解除配对')
        : tr('$joined · 长按可解除配对');

    return NeoxListRow(
      leading: Icon(
        Icons.desktop_mac_outlined,
        color: selected ? theme.colorScheme.primary : null,
      ),
      title: desktop.deviceName ?? desktop.deviceId,
      subtitle: subtitle,
      trailing: selected
          ? Icon(Icons.check_circle, size: 17, color: theme.colorScheme.primary)
          : const Icon(Icons.chevron_right, size: 18),
      onTap: onTap,
      onLongPress: onLongPress,
    );
  }

  String _stateLabel(WsConnectionState state) {
    switch (state) {
      case WsConnectionState.connected:
        return tr('已连接');
      case WsConnectionState.connecting:
        return tr('连接中');
      case WsConnectionState.error:
        return tr('连接失败');
      case WsConnectionState.disconnected:
        return tr('未连接');
    }
  }
}

class _WorkspaceRow extends StatelessWidget {
  const _WorkspaceRow({
    required this.workspace,
    required this.busy,
    required this.current,
    required this.onTap,
  });

  final WorkspaceInfo workspace;
  final bool busy;
  final bool current;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final name = workspace.name.isEmpty ? workspace.path : workspace.name;
    final subtitle = [
      if (workspace.path.isNotEmpty) workspace.path,
      if (current) tr('当前打开'),
      if (workspace.recentSessionId != null) tr('有最近任务'),
    ].join(' · ');
    return NeoxListRow(
      leading: Icon(current ? Icons.folder_open_outlined : Icons.history),
      title: name,
      subtitle: subtitle,
      trailing: busy
          ? const SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : const Icon(Icons.chevron_right, size: 18),
      onTap: busy ? null : onTap,
    );
  }
}

class _LoadingRows extends StatelessWidget {
  const _LoadingRows();

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        NeoxListRow(
          leading: SizedBox(
            width: 16,
            height: 16,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          title: tr('正在读取工作区'),
          subtitle: tr('正在同步当前和最近使用的工作区'),
        ),
      ],
    );
  }
}
