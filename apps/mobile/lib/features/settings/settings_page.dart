/// settings_page.dart — 设置 (陶土稿 v5「有头图的安静列表」).
///
///   ←                                     (开关 / 齿轮 / 盾牌 陶土插画)
///   (L) lmk1010 [Max]
///       本月用了 26% · 重置 10/20
///   [▯ 4 台设备] [◇ 128 个成品] [● Pilot 已开]       ← 三颗小泥块, 点了各自进去
///   ┌ 设备与连接 · 模型 · 语音 · 操作手机 (· 工具包) ┐
///   ┌ 外观 · 通知 · 应用锁 · 语言 ┐
///   ┌ 系统更新 [3.10.25 可更新] · 意见反馈 · 关于 Neox ┐
library;

import 'package:flutter/foundation.dart' show TargetPlatform, defaultTargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/device/device_display_name.dart';
import '../../core/edition/edition.dart';
import '../../core/i18n/tr.dart';
import '../../core/network/ws_client_provider.dart';
import '../../core/notifications/inbox.dart';
import '../../core/security/biometric_lock.dart';
import '../../core/startup/app_update.dart';
import '../../core/storage/database.dart';
import '../../core/storage/paired_desktop_kind.dart';
import '../../shared/clay/clay.dart';
import '../../shared/theme/theme_mode_provider.dart';
import '../../shared/widgets/neox_badge.dart';
import '../files/deliverables.dart';
import '../home/state/selected_model_provider.dart';
import '../pilot/pilot_link.dart';
import 'about_page.dart';
import 'appearance_page.dart';
import 'notify_settings_page.dart';
import 'settings_ui.dart';

const _phoneCh = MethodChannel('neox.phone/tools');

class SettingsPage extends ConsumerWidget {
  const SettingsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final edition = ref.read(editionProvider);
    final c = ClayInk.of(context);
    final refresher = edition.settingsRefresher(ref);
    final canPop = ModalRoute.of(context)?.canPop ?? false;

    final list = ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.only(bottom: 32),
      children: [
        const _Header(),
        /* 发行版的升级卡等 (商业版: 免费档才有) —— 原来是 sliver, 这里摊平 */
        for (final s in edition.settingsHeaderSlivers(ref))
          if (s is SliverToBoxAdapter && s.child != null) s.child!,
        const SizedBox(height: 4),
        const _QuickChips(),
        const SizedBox(height: 6),
        SettingsGroup(children: [
          const _DevicesRow(),
          const _ModelRow(),
          SettingsRow(leading: Icons.graphic_eq_rounded, title: tr('语音'), showChevron: true, onTap: () => context.push('/settings/voice')),
          /* 操作手机 / 工具包只有安卓 (iOS 不许 App 读别的 App 的屏幕, 也跑不了 Linux) */
          if (defaultTargetPlatform == TargetPlatform.android)
            SettingsRow(leading: Icons.touch_app_outlined, title: tr('操作手机'), showChevron: true, onTap: () => context.push('/settings/phone-use')),
          if (defaultTargetPlatform == TargetPlatform.android && edition.pilotAvailable)
            SettingsRow(leading: Icons.battery_charging_full_rounded, title: tr('让 Pilot 一直在线'), showChevron: true, onTap: () => context.push('/pilot/keepalive')),
          if (defaultTargetPlatform == TargetPlatform.android)
            SettingsRow(leading: Icons.handyman_outlined, title: tr('工具包'), showChevron: true, onTap: () => context.push('/settings/local-linux')),
        ]),
        SettingsGroup(children: [
          const _ThemeRow(),
          const _NotifyRow(),
          const _AppLockRow(),
          SettingsRow(
            leading: Icons.language_rounded,
            title: tr('语言'),
            trailing: Text(isEnglishUi ? 'English' : '中文', style: TextStyle(fontSize: 13.5, color: c.grey)),
            showChevron: defaultTargetPlatform == TargetPlatform.android,
            /* 跟系统语言走; 安卓 13+ 可以单独给 Neox 设 (系统的单应用语言页) */
            onTap: defaultTargetPlatform == TargetPlatform.android
                ? () => _phoneCh.invokeMethod('openAppLocaleSettings').catchError((_) => null)
                : null,
          ),
        ]),
        SettingsGroup(children: [
          /* 开源版不查更新 (新版本在 GitHub, 关于页里有入口) */
          if (edition.officialServices) const _UpdateRow(),
          SettingsRow(
            leading: Icons.chat_bubble_outline_rounded,
            title: tr('意见反馈'),
            showChevron: true,
            onTap: () => openNeoxFeedback(context, ref),
          ),
          SettingsRow(
            leading: Icons.info_outline_rounded,
            title: tr('关于 ${edition.productName}'),
            showChevron: true,
            onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const AboutPage())),
          ),
        ]),
      ],
    );

    return Scaffold(
      backgroundColor: c.canvas,
      body: SafeArea(
        child: _CanPop(
          canPop: canPop,
          child: refresher == null ? list : RefreshIndicator(onRefresh: refresher, color: c.ink, backgroundColor: c.slab, child: list),
        ),
      ),
    );
  }
}

/// 头部要不要画 ← (从侧栏推进来的才有上一页)
class _CanPop extends InheritedWidget {
  const _CanPop({required this.canPop, required super.child});
  final bool canPop;

  static bool of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<_CanPop>()?.canPop ?? false;

  @override
  bool updateShouldNotify(_CanPop old) => old.canPop != canPop;
}

/// 头部: 右上陶土插画 (开关 / 齿轮 / 盾牌), 左边头像 + 名字 + 套餐 + 额度; 右上角一颗消息铃
class _Header extends ConsumerWidget {
  const _Header();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = ClayInk.of(context);
    final account = ref.read(editionProvider).settingsAccountTile();
    final unread = ref.watch(inboxProvider).unread;
    return SizedBox(
      height: 190,
      child: Stack(
        children: [
          const Positioned(right: -6, top: 0, child: ClayArt('settings-head', width: 210)),
          if (_CanPop.of(context))
            Positioned(
              left: 8,
              top: 4,
              child: ClayRoundButton(icon: Icons.arrow_back_rounded, flat: true, size: 44, onTap: () => Navigator.maybePop(context)),
            ),
          Positioned(
            right: 12,
            top: 4,
            child: GestureDetector(
              onTap: () => context.push('/inbox'),
              child: Padding(
                padding: const EdgeInsets.all(8),
                child: Badge(
                  isLabelVisible: unread > 0,
                  backgroundColor: c.cobalt,
                  label: Text(unread > 99 ? '99+' : '$unread'),
                  child: Icon(Icons.notifications_none_rounded, color: c.ink, size: 24),
                ),
              ),
            ),
          ),
          Positioned(
            left: 24,
            right: 24,
            bottom: 18,
            child: account ?? Text(tr('设置'), style: TextStyle(fontSize: 26, fontWeight: FontWeight.w700, color: c.ink)),
          ),
        ],
      ),
    );
  }
}

/// 三颗小泥块: N 台设备 / N 个成品 / Pilot 已开
class _QuickChips extends ConsumerWidget {
  const _QuickChips();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = ClayInk.of(context);
    final db = ref.watch(appDatabaseProvider);
    final cloudDesktops = ref.watch(accountDesktopCountProvider);
    final deliverables = ref.watch(deliverablesProvider).valueOrNull?.length;
    final pilots = ref.watch(pilotContactsProvider).valueOrNull;
    Widget chip({required Widget lead, required String big, required String small, required VoidCallback onTap}) => Expanded(
          child: ClaySlab(
            radius: 16,
            padding: const EdgeInsets.fromLTRB(10, 10, 8, 10),
            onTap: onTap,
            child: Row(
              children: [
                lead,
                const SizedBox(width: 8),
                Flexible(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(big, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: c.ink)),
                      Text(small, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11.5, color: c.grey)),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: StreamBuilder<List<PairedDesktop>>(
        stream: db.pairedDesktopsDao.watchAll(),
        builder: (context, snap) {
          final local = (snap.data ?? const <PairedDesktop>[]).where(isRealPairedDesktop).length;
          /* 这台手机也算一台 */
          final devices = 1 + (local > 0 ? local : (cloudDesktops > 0 ? cloudDesktops : 0));
          final pilotOn = pilots != null && pilots.isNotEmpty;
          return Row(
            children: [
              chip(
                lead: ClayTile(icon: Icons.smartphone_rounded, size: 32),
                big: '$devices',
                small: tr('台设备'),
                onTap: () => context.push('/settings/devices'),
              ),
              const SizedBox(width: 10),
              chip(
                lead: ClayTile(icon: Icons.inventory_2_outlined, size: 32),
                big: deliverables == null ? '—' : '$deliverables',
                small: tr('个成品'),
                onTap: () => context.push('/files'),
              ),
              if (ref.watch(editionProvider).pilotAvailable) ...[
              const SizedBox(width: 10),
              chip(
                lead: Padding(padding: const EdgeInsets.all(6), child: ClayDot(color: pilotOn ? c.green : c.line, size: 12)),
                big: 'Pilot',
                small: pilots == null ? tr('…') : (pilotOn ? tr('已开') : tr('没开')),
                onTap: () => context.push('/pilot'),
              ),
              ],
            ],
          );
        },
      ),
    );
  }
}

/// 设备与连接: 灰字写「Mac 在线」/ 「没连电脑」
class _DevicesRow extends ConsumerWidget {
  const _DevicesRow();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = ClayInk.of(context);
    final ws = ref.watch(wsClientProvider);
    final db = ref.watch(appDatabaseProvider);
    return StreamBuilder<List<PairedDesktop>>(
      stream: db.pairedDesktopsDao.watchAll(),
      builder: (context, snap) {
        final desktops = (snap.data ?? const <PairedDesktop>[]).where(isRealPairedDesktop).toList();
        String value;
        if (ws.connection == WsConnectionState.connected) {
          final hit = desktops.where((d) => d.deviceId == ws.activeDesktopDeviceId).firstOrNull;
          value = tr('${friendlyDeviceName(hit?.deviceName) ?? tr('电脑')} 在线');
        } else if (ws.connection == WsConnectionState.connecting) {
          value = tr('正在连接');
        } else {
          value = desktops.isEmpty ? tr('没连电脑') : tr('${desktops.length} 台电脑');
        }
        return SettingsRow(
          leading: Icons.laptop_mac_outlined,
          title: tr('设备与连接'),
          subtitle: value,
          showChevron: true,
          trailing: ws.connection == WsConnectionState.connected ? NeoxStatusDot(color: c.green, size: 7) : null,
          onTap: () => context.push('/settings/devices'),
        );
      },
    );
  }
}

/// 模型: 灰字写当前默认模型
class _ModelRow extends ConsumerWidget {
  const _ModelRow();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final id = ref.watch(effectiveModelProvider);
    final models = ref.watch(availableModelsProvider).valueOrNull ?? const [];
    return SettingsRow(
      leading: Icons.hub_outlined,
      title: tr('模型'),
      subtitle: id.isEmpty ? null : modelDisplayName(id, models),
      showChevron: true,
      onTap: () => context.push('/settings/models'),
    );
  }
}

class _ThemeRow extends ConsumerWidget {
  const _ThemeRow();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return SettingsRow(
      leading: Icons.palette_outlined,
      title: tr('外观'),
      subtitle: themeModeLabel(ref.watch(themeModeProvider)),
      showChevron: true,
      onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const AppearancePage())),
    );
  }
}

class _NotifyRow extends StatelessWidget {
  const _NotifyRow();

  @override
  Widget build(BuildContext context) => SettingsRow(
        leading: Icons.notifications_none_rounded,
        title: tr('通知'),
        showChevron: true,
        onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const NotifySettingsPage())),
      );
}

class _AppLockRow extends ConsumerWidget {
  const _AppLockRow();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final lock = ref.watch(biometricLockProvider);
    return SettingsRow(
      leading: Icons.lock_outline_rounded,
      title: tr('应用锁'),
      subtitle: lock.available ? null : tr('此设备不支持'),
      trailing: SettingsSwitch(
        value: lock.enabled,
        onChanged: lock.available ? (v) => ref.read(biometricLockProvider.notifier).setEnabled(v) : null,
      ),
      enabled: lock.available,
    );
  }
}

/// 系统更新: 有新版时右边一颗淡蓝签「3.10.25 可更新」
class _UpdateRow extends ConsumerWidget {
  const _UpdateRow();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = ClayInk.of(context);
    final status = ref.watch(appUpdateStatusProvider).valueOrNull;
    final has = status != null && status.hasUpdate;
    return SettingsRow(
      leading: Icons.sync_rounded,
      title: tr('系统更新'),
      tag: has ? tr('${status.latestVersion} 可更新') : null,
      tagColor: c.cobalt,
      showChevron: true,
      onTap: () => has
          ? context.push('/update')
          : Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const AboutPage())),
    );
  }
}

/// 三连格里的一格 (标题 / 值 / 第三行)。v5 设置页不再用三连格; 留着给发行版的格子 (会员) 和别处复用。
class SettingsServiceTile extends StatelessWidget {
  const SettingsServiceTile({
    super.key,
    required this.icon,
    required this.title,
    required this.value,
    required this.subtitle,
    required this.valueColor,
    required this.onTap,
    this.leadingDot = false,
    this.dotColor,
    this.clay,
    this.badge,
    this.badgeColor,
  });

  final String? badge;
  final Color? badgeColor;
  final IconData icon;
  final String? clay;
  final String title;
  final String value;
  final String subtitle;
  final Color valueColor;
  final VoidCallback onTap;
  final bool leadingDot;
  final Color? dotColor;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final caption = subtitle.isEmpty ? title : subtitle;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(10, 12, 4, 12),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            ClayTile(icon: icon, size: 32, bead: badge != null ? (badgeColor ?? c.cobalt) : null),
            const SizedBox(width: 10),
            Flexible(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (leadingDot) ...[NeoxStatusDot(color: dotColor ?? valueColor, size: 6), const SizedBox(width: 4)],
                      Flexible(
                        child: Text(value, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: valueColor, fontWeight: FontWeight.w600, fontSize: 14.5)),
                      ),
                    ],
                  ),
                  const SizedBox(height: 1),
                  Text(caption, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: c.grey, fontSize: 11.5)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
