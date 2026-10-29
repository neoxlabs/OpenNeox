/// connect_picker.dart — 「当前连接」点开后的设备选择器.
///
/// 2026-08-12 明康原话:「当前连接等 点击后 应该可以显示链接列表..不然太难用了」。
///
/// 之前「当前连接」是一行纯展示: 没有 onTap、没有箭头, 但长得跟上下能点的行
/// 一模一样, 用户必然去点, 点了没反应。而"我能连哪几台 / 想换一台"这件事只
/// 存在于另一个页面 (我的设备), 从连接页完全走不过去。
///
/// 这里把列表直接搬到点击的落点上: 看得见每台电脑的在线状态, 点一台就连它。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/edition/edition.dart';
import '../../core/errors/friendly_error.dart';
import '../../core/network/ws_client_provider.dart';
import '../../core/storage/database.dart';
import '../../core/storage/paired_desktop_kind.dart';
import '../../shared/theme/neox_tokens.dart';
import 'package:neox_app/core/i18n/tr.dart';

Future<void> showConnectPicker(BuildContext context, WidgetRef ref) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    backgroundColor: Theme.of(context).colorScheme.surface,
    builder: (_) => const _ConnectPickerSheet(),
  );
}

class _ConnectPickerSheet extends ConsumerWidget {
  const _ConnectPickerSheet();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final db = ref.watch(appDatabaseProvider);
    final ws = ref.watch(wsClientProvider);
    final presence = ref.watch(desktopPresenceProvider);

    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.8,
        ),
        child: StreamBuilder<List<PairedDesktop>>(
          stream: db.pairedDesktopsDao.watchAll(),
          builder: (context, snap) {
            /* watchAll 而不是只列"能连的": 连不上的残留也要看得见, 否则用户
             * 会以为设备凭空消失了 (跟 devices_page 同一条纪律)。 */
            final all = (snap.data ?? const <PairedDesktop>[])
                .where(isRealPairedDesktop)
                .toList();

            return Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    NeoxSpace.xl,
                    0,
                    NeoxSpace.xl,
                    NeoxSpace.sm,
                  ),
                  child: Text(
                    tr('连到哪台电脑'),
                    style: theme.textTheme.titleSmall
                        ?.copyWith(fontWeight: FontWeight.w700),
                  ),
                ),
                if (all.isEmpty)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(
                      NeoxSpace.xl,
                      NeoxSpace.sm,
                      NeoxSpace.xl,
                      NeoxSpace.xxl,
                    ),
                    child: Text(
                      tr('还没有配对过电脑。去「我的设备」扫码配对一台。'),
                      style: theme.textTheme.bodyMedium
                          ?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                  )
                else
                  Flexible(
                    child: ListView.builder(
                      shrinkWrap: true,
                      itemCount: all.length,
                      itemBuilder: (context, i) {
                        final d = all[i];
                        final isActive = ws.activeDesktopDeviceId == d.deviceId &&
                            ws.connection == WsConnectionState.connected;
                        final online =
                            presence.isOnline(d.deviceId) || isActive;
                        final connectable = canConnectPairedDesktop(d);

                        return ListTile(
                          /* 陶土电脑; 不在线的淡一半 (原来靠绿 / 灰两色区分) */
                          leading: Opacity(
                            opacity: online ? 1 : 0.45,
                            child: Image.asset(
                              NeoxClay.of('i-laptop'),
                              width: 32,
                              height: 32,
                            ),
                          ),
                          title: Text(
                            d.deviceName ?? d.deviceId,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 16),
                          ),
                          subtitle: Text(
                            /* 三种状态说清楚, 别让用户猜为什么点不动 */
                            !connectable
                                ? tr('配对信息不完整 — 去「我的设备」重新配对')
                                : isActive
                                    ? tr('当前已连接')
                                    : online
                                        ? tr('在线 · 点这里连它')
                                        : tr('离线 — 电脑上的 Neox 可能没开'),
                            style: const TextStyle(fontSize: 13),
                          ),
                          trailing: isActive
                              ? Icon(Icons.check,
                                  size: 18, color: scheme.primary)
                              : null,
                          enabled: connectable && !isActive,
                          onTap: () async {
                            final messenger = ScaffoldMessenger.of(context);
                            Navigator.pop(context);
                            try {
                              await ref
                                  .read(wsClientProvider.notifier)
                                  .connectToDesktop(d.deviceId);
                            } catch (e) {
                              messenger.showSnackBar(
                                SnackBar(
                                  content: Text(
                                    friendlyError(e, fallback: tr('连接失败，请稍后重试')),
                                  ),
                                ),
                              );
                            }
                          },
                        );
                      },
                    ),
                  ),
                const SizedBox(height: NeoxSpace.md),
              ],
            );
          },
        ),
      ),
    );
  }
}
