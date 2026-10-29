/// session_actions.dart — 会话的长按动作 (重命名 / 删除).
///
/// 为什么现在才有 (2026-08-08):
///   `deleteSession` 两条路径**早就实现好了** —— ws_client_provider 走桌面
///   session.delete, phone_local_agent 走本地 drift —— 但 features/ 里一个
///   调用点都没有。抽屉的会话行只有 onTap, 没有长按、没有右滑、没有编辑态。
///   于是会话只增不减: 加上"新建会话首发失败留下的空壳", 抽屉会越来越脏,
///   而用户毫无办法。缺的从来只是 UI。
///
/// 重命名 (2026-08-11):
///   原来没做, 因为协议里没有 session.rename —— 只改本地会被下一次 session.list
///   同步覆盖回去, "改完自己变回来"比不能改更糟。现在桌面侧补上了这个 RPC
///   (wsServer.ts), 改完还会广播 session.renamed 让所有连着的设备一起更新。
///   抽屉里一堆同名的「新会话」/「hi」终于能整理了。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/execution/run_target.dart';
import '../../../core/execution/run_target_provider.dart' show pairedDesktopNamesProvider;
import '../../../core/local_agent/phone_local_agent.dart';
import '../../../core/network/ws_client_provider.dart';
import '../../../core/storage/database.dart';
import '../../../shared/clay/clay.dart';
import '../../../shared/theme/theme_mode_provider.dart' show sharedPreferencesProvider;
import '../state/current_session_provider.dart';
import '../state/home_mode_provider.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 钉住的会话 (存在这台手机上; 全部会话页「钉住」组、长按面板共用)
final pinnedSessionsProvider = StateNotifierProvider<PinnedSessions, Set<String>>(
  (ref) => PinnedSessions(ref.read(sharedPreferencesProvider)),
);

class PinnedSessions extends StateNotifier<Set<String>> {
  PinnedSessions(this._prefs) : super((_prefs.getStringList(_key) ?? const []).toSet());
  final SharedPreferences _prefs;
  static const _key = 'neox_pinned_sessions';

  void toggle(String id) {
    final next = {...state};
    if (!next.remove(id)) next.add(id);
    state = next;
    _prefs.setStringList(_key, next.toList());
  }
}

/// 会话面板里的附加动作 (镜像同步 / 重新同步 这类只对电脑会话有意义的).
typedef SessionExtraAction = ({
  IconData icon,
  String title,
  String? subtitle,
  VoidCallback onTap,
});

/// 会话动作面板 —— 抽屉长按会话行, 或点顶栏的会话标题.
///
/// [extras] 排在重命名/删除之前。顶栏标题那个入口用它挂镜像/重新同步:
/// 原来这两项住在顶栏 ⋯ 菜单里, 跟「设备/云端/工作区」这些全局去处混在一起,
/// 而重命名/删除却只能去抽屉长按找 —— 同一个会话的操作散在两个地方。
Future<void> showSessionActions(
  BuildContext context,
  WidgetRef ref,
  SessionMirrorData session, {
  List<SessionExtraAction> extras = const [],
}) async {
  final title = (session.title?.trim().isNotEmpty ?? false)
      ? session.title!.trim()
      : tr('新会话');
  final pinned = ref.read(pinnedSessionsProvider).contains(session.id);
  /* 标题下一行灰字: 模式 · 跑在哪 · 时间 (陶土稿「工作 · Mac · 昨天 16:20」) */
  final mode = homeModeOfSession(agentMode: session.agentMode, desktopDeviceId: session.desktopDeviceId);
  final names = ref.read(pairedDesktopNamesProvider).valueOrNull ?? const <String, String>{};
  final place = isPhoneLocalDeviceId(session.desktopDeviceId) ? null : names[session.desktopDeviceId];
  final t = DateTime.fromMillisecondsSinceEpoch(session.lastMessageAt ?? session.createdAt);
  final meta = [?mode?.label, ?place, '${t.month}/${t.day} ${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}']
      .join(' · ');

  final action = await showClaySheet<String>(
    context,
    builder: (ctx) {
      /* 每行一个动作, 方块图标 + 单行字; 删除用红字 (陶土稿「长按会话」) */
      Widget row(IconData icon, String label, String result, {bool danger = false}) => Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: ClayRow(
              icon: icon,
              title: label,
              danger: danger,
              chevron: !danger,
              onTap: () => Navigator.pop(ctx, result),
            ),
          );
      return Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ClaySheetHeader(title: title, subtitle: meta),
          for (final (i, e) in extras.indexed) row(e.icon, e.title, 'extra:$i'),
          row(Icons.edit_outlined, tr('重命名'), 'rename'),
          row(Icons.push_pin_outlined, pinned ? tr('取消钉住') : tr('钉在最上面'), 'pin'),
          row(Icons.delete_outline_rounded, tr('删除'), 'delete', danger: true),
          const SizedBox(height: 12),
        ],
      );
    },
  );

  if (!context.mounted) return;
  if (action != null && action.startsWith('extra:')) {
    extras[int.parse(action.substring(6))].onTap();
    return;
  }
  if (action == 'pin') {
    ref.read(pinnedSessionsProvider.notifier).toggle(session.id);
    return;
  }
  if (action == 'rename') {
    await _promptRename(context, ref, session, title);
    return;
  }
  if (action != 'delete') return;
  await _confirmAndDelete(context, ref, session, title);
}

Future<void> _promptRename(
  BuildContext context,
  WidgetRef ref,
  SessionMirrorData session,
  String current,
) async {
  final next = await showDialog<String>(
    context: context,
    builder: (ctx) => _RenameDialog(initial: current),
  );
  final title = next?.trim() ?? '';
  if (title.isEmpty || title == current || !context.mounted) return;

  final messenger = ScaffoldMessenger.of(context);
  try {
    if (isPhoneLocalDeviceId(session.desktopDeviceId)) {
      await ref.read(phoneLocalAgentProvider).renameSession(session.id, title);
    } else {
      final ok = await ref
          .read(wsClientProvider.notifier)
          .renameSession(session.id, title);
      if (!ok) {
        /* 跟删除同样的纪律: 只改本地是假的, 下次同步就变回去。诚实拒绝。 */
        messenger.showSnackBar(
          SnackBar(content: Text(tr('电脑没连上，改不了电脑上的标题。连上后再试。'))),
        );
        return;
      }
    }
    messenger.showSnackBar(SnackBar(content: Text(tr('已重命名'))));
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text(tr('重命名失败: $e'))));
  }
}

Future<void> _confirmAndDelete(
  BuildContext context,
  WidgetRef ref,
  SessionMirrorData session,
  String title,
) async {
  final isPhoneLocal = isPhoneLocalDeviceId(session.desktopDeviceId);

  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(tr('删除会话?')),
      content: Text(
        isPhoneLocal
            ? tr('「$title」的全部消息会从这台手机上删除，无法恢复。')
            : tr('「$title」会连同电脑上的存档一起永久删除，无法恢复。'),
      ),
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
  if (ok != true || !context.mounted) return;

  final messenger = ScaffoldMessenger.of(context);
  final wasCurrent = ref.read(currentSessionProvider) == session.id;

  try {
    if (isPhoneLocal) {
      await ref.read(phoneLocalAgentProvider).deleteSession(session.id);
    } else {
      final done = await ref
          .read(wsClientProvider.notifier)
          .deleteSession(session.id);
      if (!done) {
        /* 电脑没连上就删不掉远端。只清本地是假删除 —— 下次 session.list
         * 同步又把它拉回抽屉, 用户会以为"删了又回来了"。诚实拒绝。 */
        messenger.showSnackBar(
          SnackBar(content: Text(tr('电脑没连上，删不掉电脑上的存档。连上后再试。'))),
        );
        return;
      }
    }
    /* 删的正好是当前打开的那个 → 回空态, 别停在一个已经不存在的会话上 */
    if (wasCurrent) ref.read(currentSessionProvider.notifier).set(null);
    messenger.showSnackBar(SnackBar(content: Text(tr('已删除'))));
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text(tr('删除失败: $e'))));
  }
}

/// 重命名弹窗.
///
/// 单独做成 StatefulWidget 而不是在 showDialog 外面建 controller:
/// 外面建的话只能在 showDialog 返回后 dispose, 而那一刻关闭动画还没跑完,
/// TextField 仍在树上 —— 实测直接崩 "A TextEditingController was used after
/// being disposed", 整个页面变成红屏错误页。让 dialog 自己持有、自己 dispose,
/// 生命周期天然对齐。
class _RenameDialog extends StatefulWidget {
  const _RenameDialog({required this.initial});
  final String initial;

  @override
  State<_RenameDialog> createState() => _RenameDialogState();
}

class _RenameDialogState extends State<_RenameDialog> {
  late final TextEditingController _ctrl =
      TextEditingController(text: widget.initial)
        ..selection = TextSelection(
          baseOffset: 0,
          extentOffset: widget.initial.length,
        );

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(tr('重命名会话')),
      content: TextField(
        controller: _ctrl,
        autofocus: true,
        maxLength: 60,
        textInputAction: TextInputAction.done,
        decoration: InputDecoration(
          hintText: tr('给它起个能认出来的名字'),
          counterText: '',
        ),
        onSubmitted: (v) => Navigator.pop(context, v),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(tr('取消')),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context, _ctrl.text),
          child: Text(tr('保存')),
        ),
      ],
    );
  }
}
