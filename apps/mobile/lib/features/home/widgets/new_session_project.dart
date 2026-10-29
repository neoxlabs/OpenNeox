/// new_session_project.dart — 「在哪个项目里开」这件事的入口.
///
/// **为什么要有它** (2026-09-18 用户原话)
/// 「新建会话没有按钮不方便 找不到 不能选择项目 或者打开电脑里的项目 等 缺少功能」
///
/// 能力其实早就有 —— `fetchWorkspaces` / `fetchRecentWorkspaces` /
/// `pickDesktopFolder` / `createSessionInWorkspace` 全都在, 只是全埋在
/// **抽屉 → 工作区**那一页里。而人开新会话的地方是首页输入框, 不是抽屉:
/// 站在输入框前面的人没有任何线索知道"我可以先挑个项目"。
///
/// 所以这里不加新能力, 只把那条路搬到开新会话的地方来 —— 一个 sheet:
///   · 电脑上开着的工作区 (最可能想接着干的)
///   · 最近打开过的
///   · 翻电脑上的文件夹 (选任意目录)
/// 挑完 → 在电脑上打开那个工作区 + 在里面起一条会话 → 直接进去。
///
/// 没连电脑时**不装作能用**: 项目在电脑上, 连不上就说连不上, 并指到连接页。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/errors/friendly_error.dart';
import '../../../core/network/ws_client_provider.dart';
import '../../../shared/theme/neox_tokens.dart';
import '../../workspace/folder_picker.dart';
import '../state/current_project_provider.dart';
import '../state/current_session_provider.dart'
    show currentSessionProvider, openSessionOnHome;
import 'package:neox_app/core/i18n/tr.dart';

/// 电脑连上了没有 —— 项目都在电脑上, 这是能不能挑的前提.
///
/// 判据跟工作区页一致 (connected + 不是云端 + 有具体设备), 不另立一套:
/// 两处口径不同的话, 一处说能挑一处说不能, 用户只会以为 app 抽风。
bool desktopReadyForProjects(WsClientState s) =>
    s.connection == WsConnectionState.connected &&
    s.transport != WsTransport.cloudAgent &&
    s.activeDesktopDeviceId != null;

/// 挑一个项目并在里面开会话; 成功后已经跳进那条会话.
Future<void> pickProjectAndStartSession(
  BuildContext context,
  WidgetRef ref,
) async {
  if (!desktopReadyForProjects(ref.read(wsClientProvider))) {
    final go = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(tr('先连上电脑')),
        content: Text(tr('项目在电脑上，连上之后才能选。')),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(tr('知道了')),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(tr('去连接')),
          ),
        ],
      ),
    );
    if (go == true && context.mounted) context.push('/settings/connection');
    return;
  }

  final picked = await showModalBottomSheet<_Picked>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    backgroundColor: Theme.of(context).colorScheme.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (_) => const _ProjectSheet(),
  );
  if (picked == null || !context.mounted) return;

  await enterProject(
    context,
    ref,
    path: picked.path,
    name: picked.name,
    continueSessionId: picked.continueSessionId,
  );
}

/// 进入一个项目: 在电脑上打开工作区 → 记成当前项目 → 开一条新会话 (或接着上次).
///
/// **默认是新会话** (2026-09-22 用户: 「连接后无法新建会话 新会话 只能继续项目」)。
/// 原来这里「接着上次」优先 —— 而电脑给几乎每个项目都带着最近会话, 于是挑项目
/// 永远是打开旧会话, 在项目里开新会话这件事根本做不到。
/// 现在跟 Claude 客户端一样: 进项目 = 一个空白的新对话, 第一条消息发出时才真正
/// 建会话 (session_router 按当前项目建), 不会先堆一条空会话。
/// 接着上次是显式的另一个按钮 ([continueSessionId])。
Future<void> enterProject(
  BuildContext context,
  WidgetRef ref, {
  required String path,
  required String name,
  String? continueSessionId,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  void toast(String m) =>
      messenger.showSnackBar(SnackBar(content: Text(m)));

  try {
    final ws = ref.read(wsClientProvider.notifier);
    if (!await ws.openWorkspaceOnDesktop(path)) {
      toast(tr('打开项目失败，请确认电脑在线'));
      return;
    }
    /* 选项目是**进入一个上下文**, 不是一次跳转 (2026-09-18 用户: 「进入项目还是没
     * UI 显示当前在什么项目下..完全懵逼」)。记下来, 首页药丸会显示它,
     * 之后开的新会话也默认落在这里。 */
    ref.read(currentProjectProvider.notifier).set(
      CurrentProject(
        path: path,
        name: name,
        desktopDeviceId: ref.read(wsClientProvider).activeDesktopDeviceId,
      ),
    );
    if (!context.mounted) return;

    if (continueSessionId != null && continueSessionId.isNotEmpty) {
      openSessionOnHome(context, ref, continueSessionId);
      return;
    }
    ref.read(currentSessionProvider.notifier).set(null);
    GoRouter.of(context).go('/');
  } catch (e) {
    toast(friendlyError(e, fallback: tr('打开项目失败，请稍后重试')));
  }
}

class _Picked {
  const _Picked({required this.path, required this.name, this.continueSessionId});
  final String path;
  final String name;
  /// 非空 = 用户点的是「接着上次」, 打开这条而不是开新会话
  final String? continueSessionId;
}

class _ProjectSheet extends ConsumerStatefulWidget {
  const _ProjectSheet();

  @override
  ConsumerState<_ProjectSheet> createState() => _ProjectSheetState();
}

class _ProjectSheetState extends ConsumerState<_ProjectSheet> {
  late Future<List<List<WorkspaceInfo>>> _future;

  @override
  void initState() {
    super.initState();
    final ws = ref.read(wsClientProvider.notifier);
    _future = Future.wait([ws.fetchWorkspaces(), ws.fetchRecentWorkspaces()]);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * 0.8,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
            child: Text(tr('在哪个项目里干'), style: theme.textTheme.titleMedium),
          ),
          Flexible(
            child: FutureBuilder<List<List<WorkspaceInfo>>>(
              future: _future,
              builder: (ctx, snap) {
                if (snap.connectionState != ConnectionState.done) {
                  return const Padding(
                    padding: EdgeInsets.symmetric(vertical: 32),
                    child: Center(child: CircularProgressIndicator()),
                  );
                }
                /* 读不到就说读不到 —— 翻文件夹那条路仍然给, 别让人卡在这一屏 */
                final open = snap.data?[0] ?? const <WorkspaceInfo>[];
                final recentAll = snap.data?[1] ?? const <WorkspaceInfo>[];
                final openPaths = open.map((w) => w.path).toSet();
                final recent = recentAll
                    .where((w) => !openPaths.contains(w.path))
                    .toList();

                return SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (snap.hasError)
                        _hint(tr('没读到电脑上的项目列表，可以直接翻文件夹。'), scheme),
                      if (open.isNotEmpty) _label(tr('电脑上开着的'), theme),
                      for (final w in open) _tile(w, theme, openNow: true),
                      if (recent.isNotEmpty) _label(tr('最近打开过'), theme),
                      for (final w in recent) _tile(w, theme, openNow: false),
                      if (open.isEmpty && recent.isEmpty && !snap.hasError)
                        _hint(tr('电脑上还没有打开过的项目。'), scheme),
                      Divider(
                        height: 1,
                        color: scheme.outlineVariant.withValues(alpha: 0.4),
                      ),
                      ListTile(
                        leading: const Icon(Icons.folder_open_outlined,
                            size: 20),
                        title: Text(
                          tr('翻电脑上的文件夹'),
                          style: TextStyle(fontSize: 15.5),
                        ),
                        subtitle: Text(
                          tr('选任意目录当项目'),
                          style: TextStyle(
                            fontSize: 13,
                            color: scheme.onSurfaceVariant,
                          ),
                        ),
                        onTap: _browse,
                      ),
                      const SizedBox(height: 6),
                    ],
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _browse() async {
    final path = await pickDesktopFolder(context, ref);
    if (path == null || path.isEmpty || !mounted) return;
    final name =
        path.split('/').where((s) => s.isNotEmpty).lastOrNull ?? path;
    Navigator.pop(context, _Picked(path: path, name: name));
  }

  Widget _label(String text, ThemeData theme) => Padding(
    padding: const EdgeInsets.fromLTRB(24, 12, 24, 4),
    child: Text(
      text,
      style: theme.textTheme.labelSmall?.copyWith(
        color: theme.colorScheme.onSurfaceVariant,
        fontWeight: FontWeight.w700,
        letterSpacing: 0.3,
      ),
    ),
  );

  Widget _hint(String text, ColorScheme scheme) => Padding(
    padding: const EdgeInsets.fromLTRB(24, 8, 24, 12),
    child: Text(
      text,
      style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant),
    ),
  );

  Widget _tile(WorkspaceInfo w, ThemeData theme, {required bool openNow}) {
    final scheme = theme.colorScheme;
    /* 副标题给**路径**而不是"最近打开" —— 同名文件夹 (client/ server/) 很常见,
     * 只写名字的话两行长得一模一样, 挑错了要跑一遍才发现。 */
    return ListTile(
      leading: Icon(
        openNow ? Icons.folder_outlined : Icons.history,
        size: 20,
        color: openNow ? scheme.primary : null,
      ),
      title: Text(
        w.name.isEmpty ? w.path : w.name,
        style: const TextStyle(fontSize: 15.5),
      ),
      subtitle: Text(
        w.path,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant),
      ),
      /* 点整行 = 在这个项目里开新会话; 右边这颗才是接着上次 (见 enterProject) */
      trailing: (w.recentSessionId?.isNotEmpty ?? false)
          ? TextButton(
              style: TextButton.styleFrom(
                visualDensity: VisualDensity.compact,
                padding: const EdgeInsets.symmetric(horizontal: 8),
                minimumSize: const Size(0, 32),
                shape: RoundedRectangleBorder(borderRadius: NeoxRadius.smallR),
                backgroundColor: scheme.primary.withValues(alpha: 0.10),
              ),
              onPressed: () => Navigator.pop(
                context,
                _Picked(
                  path: w.path,
                  name: w.name,
                  continueSessionId: w.recentSessionId,
                ),
              ),
              child: Text(
                tr('接着上次'),
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  color: scheme.primary,
                ),
              ),
            )
          : null,
      onTap: () => Navigator.pop(context, _Picked(path: w.path, name: w.name)),
    );
  }
}
