import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/attachments/local_attachment_store.dart';
import '../../core/execution/run_target_provider.dart';
import '../../core/execution/unpaired_desktops_provider.dart';
import '../../core/network/lan_endpoint_hints_provider.dart';
import '../../core/network/ws_client_provider.dart';
import '../../core/storage/database.dart';
import '../home/state/current_session_provider.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 长按已配对电脑 → 菜单 → 确认解除。
///
/// 闭环:
///   删本地配对 + 写入拒绝名单(防 auto_pair 回写) + 清首选 +
///   清该机会话镜像/事件/inbox + 清 LAN hints + 当前连接则断开。
Future<void> showPairedDesktopActions(
  BuildContext context,
  WidgetRef ref,
  PairedDesktop desktop,
) async {
  final name = _desktopLabel(desktop);
  final action = await showModalBottomSheet<String>(
    context: context,
    showDragHandle: true,
    builder: (ctx) {
      final scheme = Theme.of(ctx).colorScheme;
      return SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: Icon(Icons.link_off, color: scheme.error),
              title: Text(
                tr('解除配对'),
                style: TextStyle(
                  color: scheme.error,
                  fontWeight: FontWeight.w600,
                ),
              ),
              subtitle: Text(tr('删除与「$name」的链接；同账号也不会再自动加回')),
              onTap: () => Navigator.pop(ctx, 'unpair'),
            ),
            const SizedBox(height: 8),
          ],
        ),
      );
    },
  );
  if (action != 'unpair' || !context.mounted) return;
  await confirmAndUnpairDesktop(context, ref, desktop);
}

Future<void> confirmAndUnpairDesktop(
  BuildContext context,
  WidgetRef ref,
  PairedDesktop desktop,
) async {
  final name = _desktopLabel(desktop);
  final isAccountTrusted =
      desktop.deviceToken?.startsWith('account:') ?? false;
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(tr('解除配对?')),
      content: Text(
        isAccountTrusted
            ? tr('将删除与「$name」的链接，且不再自动同步回来。需要时请重新扫码连接。')
            : tr('将删除与「$name」的链接。电脑端不受影响，需要时重新扫码即可。'),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx, false),
          child: Text(tr('取消')),
        ),
        TextButton(
          style: TextButton.styleFrom(
            foregroundColor: Theme.of(ctx).colorScheme.error,
          ),
          onPressed: () => Navigator.pop(ctx, true),
          child: Text(tr('解除')),
        ),
      ],
    ),
  );
  if (confirmed != true || !context.mounted) return;

  final deviceId = desktop.deviceId;
  final ws = ref.read(wsClientProvider);
  final wasActive = ws.activeDesktopDeviceId == deviceId;
  final wasPreferred = ref.read(preferredDesktopProvider) == deviceId;
  final db = ref.read(appDatabaseProvider);

  try {
    final mirrors =
        await db.sessionMirrorDao.getByDesktopDeviceId(deviceId);
    for (final m in mirrors) {
      await db.sessionEventsDao.deleteBySessionId(m.id);
      await LocalAttachmentStore.instance.deleteSession(m.id);
    }
    await db.sessionMirrorDao.deleteByDesktopDeviceId(deviceId);
    await db.inboxPendingDao.deleteByDesktopDeviceId(deviceId);
    await db.pairedDesktopsDao.deleteByDeviceId(deviceId);

    ref.read(unpairedDesktopsProvider.notifier).reject(deviceId);
    ref.read(lanEndpointHintsProvider.notifier).clear(deviceId);
    if (wasPreferred) {
      ref.read(preferredDesktopProvider.notifier).set(null);
    }

    final currentSid = ref.read(currentSessionProvider);
    if (currentSid != null &&
        mirrors.any((m) => m.id == currentSid)) {
      ref.read(currentSessionProvider.notifier).set(null);
    }

    if (wasActive) {
      await ref.read(wsClientProvider.notifier).disconnect();
    }
  } catch (e) {
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(tr('解除失败: $e'))),
    );
    return;
  }

  if (!context.mounted) return;
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(content: Text(tr('已解除与「$name」的配对'))),
  );
}

String _desktopLabel(PairedDesktop desktop) {
  final name = desktop.deviceName?.trim();
  if (name != null && name.isNotEmpty) return name;
  return desktop.deviceId;
}
