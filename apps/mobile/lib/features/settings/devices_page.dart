library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/device/device_display_name.dart';
import '../../core/edition/edition.dart';
import '../../core/execution/run_target_provider.dart';
import '../../core/network/desktop_presence.dart';
import '../../core/network/ws_client_provider.dart';
import '../../core/storage/database.dart';
import '../../core/storage/paired_desktop_kind.dart';
import '../../shared/theme/neox_tokens.dart';
import 'settings_ui.dart';
import 'unpair_desktop.dart';
import 'package:neox_app/core/i18n/tr.dart';

class DevicesPage extends ConsumerWidget {
  const DevicesPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final edition = ref.read(editionProvider);
    return SettingsFrame(
      /* 2026-09-22: 抽屉那份注释（neox_drawer.dart 约 150 行）声称"三处名字统一成
       * 「设备」", 但那次只改了抽屉条目和设置里的格子 —— **这个页面自己的标题**漏了,
       * 于是用户从「设备」点进来, 落地又叫回「我的电脑」, 全仓走查时一眼就是假文档。
       * 统一成「设备」: 设置里的格子 / 抽屉注释 / 这里指的是同一个页面。 */
      title: tr('设备'),
      subtitle: tr('配对过的电脑, 在线的可以直接派活'),
      hero: 'bg-devices',
      /* 同账号设备的同步 (标题栏按钮 / 下拉刷新 / 「同步同账号电脑」行 / 同账号设备组)
       * 是账号体系的事, 由发行版加进来 (商业版见 commercial/settings/account_devices.dart)。 */
      actions: edition.devicesPageActions(context, ref),
      body: RefreshIndicator(
        onRefresh: () => edition.refreshDevicesPage(context, ref),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(bottom: 28),
          children: [
            const _ConnectionSummary(),
            const _DeviceActions(),
            const _LocalDesktopGroup(),
            ...edition.devicesPageGroups(),
          ],
        ),
      ),
    );
  }
}

class _ConnectionSummary extends ConsumerWidget {
  const _ConnectionSummary();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final state = ref.watch(wsClientProvider);
    final color = settingsConnectionColor(theme, state);
    final modeLabel = settingsConnectionModeLabel(state);
    return SettingsSurface(
      margin: const EdgeInsets.fromLTRB(20, 12, 20, 10),
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(NeoxRadius.chip + 2),
            ),
            child: Icon(settingsConnectionIcon(state), size: 20, color: color),
          ),
          const SizedBox(width: NeoxSpace.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  settingsConnectionTitle(state),
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
                ),
                /* 副标题为空就不占这一行 (见 settingsConnectionSubtitle) */
                if (settingsConnectionSubtitle(state).isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(
                    settingsConnectionSubtitle(state),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ],
            ),
          ),
          if (modeLabel != null) ...[
            const SizedBox(width: 10),
            SettingsTag(label: modeLabel, color: color),
          ],
        ],
      ),
    );
  }
}

class _DeviceActions extends ConsumerWidget {
  const _DeviceActions();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return SettingsGroup(
      title: tr('连接'),
      children: [
        SettingsRow(
          leading: Icons.qr_code_scanner_outlined,
          title: tr('连接电脑'),
          subtitle: tr('扫码或输入备份码'),
          showChevron: true,
          onTap: () => context.push('/pairing'),
        ),
        ...ref.read(editionProvider).devicesPageConnectRows(context, ref),
      ],
    );
  }
}

class _LocalDesktopGroup extends ConsumerWidget {
  const _LocalDesktopGroup();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final db = ref.watch(appDatabaseProvider);
    final wsState = ref.watch(wsClientProvider);
    return StreamBuilder<List<PairedDesktop>>(
      /* 与工作区一致: 用 watchAll, 连不上的残留也能看见并长按解除 */
      stream: db.pairedDesktopsDao.watchAll(),
      builder: (context, snap) {
        final desktops = (snap.data ?? const <PairedDesktop>[])
            .where(isRealPairedDesktop)
            .toList(growable: false);
        if (desktops.isEmpty) {
          return SettingsGroup(
            title: tr('已配对'),
            children: [
              SettingsRow(
                leading: Icons.desktop_windows_outlined,
                title: tr('尚无配对电脑'),
                subtitle: tr('连接过的电脑显示在这里'),
              ),
            ],
          );
        }
        /* 2026-08-04: 这个列表原来是纯展示 —— 没有 onTap。用户配了多台电脑,
         * 在这里看得见却点不动, 而路由永远取排序第一台 (session_router 的
         * desktops.first)。用户原话: "我已配对的, 我都不能切换"。
         * 现在点一下 = 设为首选, 再点一下 = 取消回自动。 */
        final preferred = ref.watch(preferredDesktopProvider);
        /* 可达性 = 云端说的在线 + 我们自己试连的结果, 两者缺一不可:
         * 只看 presence 会把"开着但连不上"说成在线 (真机上正是这个坑),
         * 只看试连结果又分不清"没开机"和"开着但这条路不通"。 */
        final presence = ref.watch(desktopPresenceProvider);
        final unreachable = ref.watch(unreachableDesktopsProvider);
        final scheme = Theme.of(context).colorScheme;
        return SettingsGroup(
          /* 操作提示放分组标题一次, 不在每一行重复 */
          title: tr('已配对 · 点击设为首选 · 长按解除'),
          children: [
            for (final desktop in desktops)
              SettingsRow(
                leading: Icons.desktop_mac_outlined,
                /* 机器码不往脸上拄 —— 2026-09-22 真机实拍: 这一行显示过
                 * `JDMCVMPHIYKSSVX` (原本是 `deviceName ?? deviceId`, 而 deviceName
                 * 本身就可能是机器码)。认不出人话就退回「未命名电脑」: 它至少说了
                 * "这是一台电脑", 而机器码什么也没说。 */
                title: friendlyDeviceName(desktop.deviceName) ?? tr('未命名电脑'),
                /* 操作说明 (再点改回自动 / 长按解除) 不再塞进每一行 —— 挪到分组下方一行提示 */
                subtitle: preferred == desktop.deviceId
                    ? tr('新会话固定用这台')
                    : _localDesktopSubtitle(desktop),
                tag: _desktopTag(
                  isPreferred: preferred == desktop.deviceId,
                  isActive:
                      wsState.activeDesktopDeviceId == desktop.deviceId &&
                      wsState.connection == WsConnectionState.connected,
                  reach: _reachOf(desktop.deviceId, presence, unreachable),
                ),
                tagColor: _tagColor(
                  scheme,
                  isPreferred: preferred == desktop.deviceId,
                  isActive:
                      wsState.activeDesktopDeviceId == desktop.deviceId &&
                      wsState.connection == WsConnectionState.connected,
                  reach: _reachOf(desktop.deviceId, presence, unreachable),
                ),
                onTap: () {
                  final next = preferred == desktop.deviceId
                      ? null
                      : desktop.deviceId;
                  ref.read(preferredDesktopProvider.notifier).set(next);
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text(
                        next == null
                            ? tr('已改回自动选择电脑')
                            : tr('新会话将使用「${friendlyDeviceName(desktop.deviceName) ?? tr('未命名电脑')}」'),
                      ),
                    ),
                  );
                },
                onLongPress: () =>
                    showPairedDesktopActions(context, ref, desktop),
              ),
          ],
        );
      },
    );
  }
}

/// 一台电脑此刻的**可达性**, 跟"配对关系"是两回事。
///
/// 2026-09-03 加。在此之前这个列表只显示配对状态 (首选 / 当前 / 已配对) ——
/// 三台电脑长得一模一样, 用户看不出哪台开着、哪台连得上, 只能挨个点。
/// 真机上就出过这个事: 手机死磕一台连不上的 Windows, 而旁边的 Mac 开着能连,
/// 界面上两台都写着"已配对", 谁也看不出区别。
enum _Reach {
  /// 云端说它在线, 而且我们连上过 / 能连上
  online,

  /// 云端说它在线, 但连不上 (配对失效 / 防火墙 / 端口不通) —— 黄色, 我们正在自动修
  degraded,

  /// 云端说它离线, 或者从没上报过
  offline,

  /// 在线通道还没通 (刚回前台 / 网络在切) —— 不知道, 不能说"不在线"
  unknown,
}

_Reach _reachOf(
  String deviceId,
  DesktopPresenceView presence,
  Set<String> unreachable,
) {
  if (!presence.isOnline(deviceId)) return presence.live ? _Reach.offline : _Reach.unknown;
  return unreachable.contains(deviceId) ? _Reach.degraded : _Reach.online;
}

/// 标签口径: 当前 > 首选 > 可达性。
/// "首选"是用户的选择 (影响新会话去哪), "当前"是此刻连着谁, 可达性是**客观事实** ——
/// 三者分开, 用户才能看出"我选了 A, 现在连的是 B, 而 C 根本没开机"。
String _desktopTag({
  required bool isPreferred,
  required bool isActive,
  required _Reach reach,
}) {
  if (isActive) return isPreferred ? tr('首选 · 已连接') : tr('已连接');
  final base = switch (reach) {
    _Reach.online => tr('在线'),
    _Reach.degraded => tr('在线 · 连不上'),
    _Reach.offline => tr('不在线'),
    _Reach.unknown => tr('确认中'),
  };
  return isPreferred ? tr('首选 · $base') : base;
}

Color _tagColor(
  ColorScheme scheme, {
  required bool isPreferred,
  required bool isActive,
  required _Reach reach,
}) {
  if (isActive) return NeoxClaudePalette.success;
  return switch (reach) {
    _Reach.online => NeoxClaudePalette.success,
    /* 黄色 = "它开着, 但这条路此刻不通" —— 跟"没开机"必须一眼分得开:
     * 前者是我们该自动修的问题, 后者用户只能去开电脑。 */
    _Reach.degraded => NeoxClaudePalette.warning,
    _Reach.offline || _Reach.unknown => scheme.onSurfaceVariant,
  };
}

/* 「同账号设备」组与同步动作挪到了 commercial/settings/account_devices.dart ——
 * 它们读的是账号概览, 由发行版通过 devicesPage* 插槽加回这一页。 */

String _localDesktopSubtitle(PairedDesktop desktop) {
  final last = desktop.lastConnectedAt == null
      ? null
      : DateTime.fromMillisecondsSinceEpoch(desktop.lastConnectedAt!);
  return last == null ? tr('未连接过') : tr('${settingsRelativeTime(last)}连接过');
}
