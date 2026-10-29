/// where_sheet.dart — 「在哪干」(陶土稿 v5): 输入框里的设备签 + 点开的弹层.
///
///   在哪干                         自动选 [●]
///                                  电脑不在线就用手机
///   [📱] 这台手机   工具包已装 · 能做表格和文档
///   [💻] MacBook Pro ● 在线 · 同 Wi-Fi          ✓
///   [🖥] 公司 Windows ● 不在线 · 3 天前  (整行变淡)
///   [☁] 云端       电脑关着也继续跑
///   [ ＋ 连一台电脑 ]
///
/// 设备从一个页面变成一个选项 (代替「工作 / 编码首页 = 设备列表」)。
/// 只影响新会话; 已有会话跑在哪建会话时就定了。
///
/// 背后的状态还是原来那两个: [runTargetPrefProvider] (自动 / 电脑 / 云端 / 手机) +
/// [preferredDesktopProvider] (选了哪台电脑)。
library;

import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/device/device_display_name.dart';
import '../../../core/edition/edition.dart' show cloudEntriesVisibleProvider, desktopPresenceProvider;
import '../../../core/execution/run_target_provider.dart';
import '../../../core/i18n/tr.dart';
import '../../../core/local_agent/linux_env.dart';
import '../../../core/network/desktop_presence.dart';
import '../../../core/network/ws_client_provider.dart';
import '../../../core/storage/database.dart';
import '../../../core/storage/paired_desktop_kind.dart';
import '../../../shared/clay/clay.dart';
import '../../settings/settings_ui.dart' show settingsRelativeTime;
import '../state/home_mode_provider.dart';

/// 一台电脑此刻的状态: 能不能派活 + 一句话.
({bool online, String text}) desktopStatusOf(
  PairedDesktop d,
  DesktopPresenceView presence,
  WsClientState ws,
) {
  final connected = ws.activeDesktopDeviceId == d.deviceId && ws.connection == WsConnectionState.connected;
  if (connected) {
    final lan = ws.transport == WsTransport.lan;
    return (online: true, text: lan ? tr('在线 · 同 Wi-Fi') : tr('在线 · 远程'));
  }
  if (presence.isOnline(d.deviceId)) return (online: true, text: tr('在线'));
  final last = d.lastConnectedAt == null ? null : DateTime.fromMillisecondsSinceEpoch(d.lastConnectedAt!);
  return (online: false, text: last == null ? tr('不在线') : '${tr('不在线')} · ${settingsRelativeTime(last)}');
}

String desktopNameOf(PairedDesktop d) => friendlyDeviceName(d.deviceName) ?? tr('未命名电脑');

/// 列电脑的统一顺序 (侧栏 / 远程连接 / 在哪干): 在线的在前, 再按最近连过.
List<PairedDesktop> orderDesktops(Iterable<PairedDesktop> all, DesktopPresenceView presence, WsClientState ws) {
  int up(PairedDesktop d) => desktopStatusOf(d, presence, ws).online ? 0 : 1;
  return all.where(isRealPairedDesktop).toList()
    ..sort((a, b) {
      final o = up(a) - up(b);
      return o != 0 ? o : (b.lastConnectedAt ?? 0).compareTo(a.lastConnectedAt ?? 0);
    });
}

bool _looksLikeDesktopPc(PairedDesktop d) {
  final n = (d.deviceName ?? '').toLowerCase();
  return n.contains('windows') || n.contains('desktop') || n.contains('pc') || n.contains('台式');
}

/// 新会话实际按哪档走: 编码选了「本机」但手机没装工具包 (编不了) → 按自动 (电脑在线用电脑).
/// 「在哪干」是工作 / 编码共用的一个设置, 工作里选的本机不该让编码首页写着「这台手机」然后一发就拦。
RunTargetPref effectiveRunTarget(RunTargetPref pref, {required HomeMode mode, required bool phoneCanCode}) =>
    mode == HomeMode.code && pref == RunTargetPref.phone && !phoneCanCode ? RunTargetPref.auto : pref;

/// 首页 / 输入框显示用: 同 [effectiveRunTarget], 工具包状态还没读到时按没装算
RunTargetPref watchEffectiveRunTarget(WidgetRef ref) {
  final mode = ref.watch(homeModeProvider);
  final pref = ref.watch(runTargetPrefProvider);
  final linuxOk = Platform.isAndroid && (ref.watch(linuxStatusProvider).valueOrNull?.installed ?? false);
  return effectiveRunTarget(pref, mode: mode, phoneCanCode: linuxOk);
}

/// 输入框里那颗设备签: 图标 + 名字 (自动选时写此刻会落在哪).
({IconData icon, String label}) whereChipOf(WidgetRef ref) {
  final pref = watchEffectiveRunTarget(ref);
  final mode = ref.watch(homeModeProvider);
  final ws = ref.watch(wsClientProvider);
  final name = ref.watch(activeDesktopNameProvider);
  final connectedName = ws.connection == WsConnectionState.connected && ws.transport != WsTransport.cloudAgent
      ? name
      : null;
  switch (pref) {
    case RunTargetPref.phone:
      return (icon: Icons.smartphone_outlined, label: tr('手机'));
    case RunTargetPref.cloud:
      return (icon: Icons.cloud_outlined, label: tr('云端'));
    case RunTargetPref.desktop:
      return (icon: Icons.laptop_mac_outlined, label: shortDeviceLabel(name) ?? tr('电脑'));
    case RunTargetPref.auto:
      if (connectedName != null) return (icon: Icons.laptop_mac_outlined, label: shortDeviceLabel(connectedName)!);
      /* 电脑不在线: 工作落手机, 编码没装工具包时要等电脑 —— 签上照实写 */
      return mode == HomeMode.code
          ? (icon: Icons.laptop_mac_outlined, label: tr('电脑'))
          : (icon: Icons.smartphone_outlined, label: tr('手机'));
  }
}

/// 机器名太长时只取第一截 (「MacBook Pro · neox」→「MacBook Pro」, 再长截到 10 字)
String? shortDeviceLabel(String? raw) {
  final s = friendlyDeviceName(raw)?.split(' · ').first.trim();
  if (s == null || s.isEmpty) return null;
  return s.length > 12 ? '${s.substring(0, 11)}…' : s;
}

Future<void> showWhereSheet(BuildContext context, WidgetRef ref) {
  return showClaySheet<void>(context, builder: (ctx) => const _WhereSheet());
}

class _WhereSheet extends ConsumerWidget {
  const _WhereSheet();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = ClayInk.of(context);
    final pref = ref.watch(runTargetPrefProvider);
    final preferred = ref.watch(preferredDesktopProvider);
    final mode = ref.watch(homeModeProvider);
    final ws = ref.watch(wsClientProvider);
    final presence = ref.watch(desktopPresenceProvider);
    final cloudOn = ref.watch(cloudEntriesVisibleProvider);
    final linux = ref.watch(linuxStatusProvider).valueOrNull;
    final db = ref.watch(appDatabaseProvider);
    final auto = pref == RunTargetPref.auto;

    void pick(RunTargetPref p, {String? desktop}) {
      if (desktop != null) ref.read(preferredDesktopProvider.notifier).set(desktop);
      ref.read(runTargetPrefProvider.notifier).set(p);
      if (desktop != null) {
        /* 选了就去连, 发送时不用再等 */
        ref.read(wsClientProvider.notifier).connectToDesktop(desktop).catchError((Object _) {});
      }
      Navigator.pop(context);
    }

    final phoneLine = mode == HomeMode.code
        ? ((linux?.installed ?? false) ? tr('工具包已装 · 能写代码、跑程序') : tr('先下载工具包才能在手机上编码'))
        : ((linux?.installed ?? false) ? tr('工具包已装 · 能做表格和文档') : tr('联网、写文件、操作手机'));
    final phoneUsable = mode != HomeMode.code || (Platform.isAndroid && (linux?.installed ?? false));

    return StreamBuilder<List<PairedDesktop>>(
      stream: db.pairedDesktopsDao.watchReachable(),
      builder: (context, snap) {
        final desktops = (snap.data ?? const <PairedDesktop>[]).where(isRealPairedDesktop).toList();
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 6, 12, 10),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Text(tr('在哪干'), style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: c.ink)),
                  ),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(tr('自动选'), style: TextStyle(fontSize: 13.5, color: c.ink, fontWeight: FontWeight.w500)),
                          ClaySwitch(
                            value: auto,
                            onChanged: (v) => ref
                                .read(runTargetPrefProvider.notifier)
                                .set(v ? RunTargetPref.auto : (desktops.isNotEmpty ? RunTargetPref.desktop : RunTargetPref.phone)),
                          ),
                        ],
                      ),
                      Padding(
                        padding: const EdgeInsets.only(right: 10),
                        child: Text(tr('电脑不在线就用手机'), style: TextStyle(fontSize: 11.5, color: c.grey)),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            _WhereRow(
              icon: Icons.smartphone_outlined,
              title: tr('这台手机'),
              subtitle: phoneLine,
              selected: !auto && pref == RunTargetPref.phone,
              faded: !phoneUsable,
              onTap: () {
                if (!phoneUsable && mode == HomeMode.code && Platform.isAndroid) {
                  Navigator.pop(context);
                  context.push('/settings/local-linux');
                  return;
                }
                pick(RunTargetPref.phone);
              },
            ),
            for (final d in desktops)
              Builder(builder: (_) {
                final st = desktopStatusOf(d, presence, ws);
                final sel = !auto && pref == RunTargetPref.desktop && (preferred == null || preferred == d.deviceId);
                return _WhereRow(
                  icon: _looksLikeDesktopPc(d) ? Icons.desktop_windows_outlined : Icons.laptop_mac_outlined,
                  title: desktopNameOf(d),
                  subtitle: st.text,
                  dot: st.online ? c.green : c.faint,
                  selected: sel,
                  faded: !st.online,
                  onTap: () => pick(RunTargetPref.desktop, desktop: d.deviceId),
                  /* 不选它当去处, 只想看看这台电脑上的会话 (不在线也能看上次同步的) */
                  trailing: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: () {
                      Navigator.pop(context);
                      context.push('/remote/${Uri.encodeComponent(d.deviceId)}');
                    },
                    child: Padding(
                      padding: const EdgeInsets.only(left: 8),
                      child: ClayChip(label: '${tr('会话')} ›', dense: true),
                    ),
                  ),
                );
              }),
            if (cloudOn)
              _WhereRow(
                icon: Icons.cloud_outlined,
                title: tr('云端'),
                subtitle: tr('电脑关着也继续跑'),
                selected: !auto && pref == RunTargetPref.cloud,
                onTap: () => pick(RunTargetPref.cloud),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 14, 20, 10),
              child: ClayButton(
                label: tr('连一台电脑'),
                icon: Icons.add_rounded,
                expand: true,
                onTap: () {
                  Navigator.pop(context);
                  context.push('/pairing');
                },
              ),
            ),
          ],
        );
      },
    );
  }
}

class _WhereRow extends StatelessWidget {
  const _WhereRow({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.selected,
    required this.onTap,
    this.dot,
    this.faded = false,
    this.trailing,
  });

  final Widget? trailing;
  final IconData icon;
  final String title;
  final String subtitle;
  final bool selected;
  final VoidCallback onTap;
  final Color? dot;
  final bool faded;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final body = Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 10),
      child: Row(
        children: [
          ClayTile(icon: icon, size: 40),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600, color: c.ink)),
                const SizedBox(height: 2),
                Row(
                  children: [
                    if (dot != null) ...[ClayDot(color: dot!, size: 7), const SizedBox(width: 6)],
                    Flexible(
                      child: Text(subtitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12.5, color: c.grey)),
                    ),
                  ],
                ),
              ],
            ),
          ),
          if (selected) const ClayCheck(),
          ?trailing,
        ],
      ),
    );
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
      child: Opacity(
        opacity: faded ? 0.5 : 1,
        child: selected
            ? ClaySlab(padding: const EdgeInsets.symmetric(horizontal: 10), lift: 1.2, onTap: onTap, child: body)
            : Material(
                color: Colors.transparent,
                child: InkWell(
                  borderRadius: BorderRadius.circular(16),
                  onTap: onTap,
                  child: Padding(padding: const EdgeInsets.symmetric(horizontal: 10), child: body),
                ),
              ),
      ),
    );
  }
}
