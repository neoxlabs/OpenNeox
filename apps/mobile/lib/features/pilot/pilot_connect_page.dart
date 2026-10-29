/// pilot_connect_page.dart — 连接 (2026-10-14, 「云端一个大脑, 手机和电脑是节点」)。
///
/// 跟电脑上「连接」页 (desktop v3/PilotConnectPage.tsx) 同一个意思: 这台手机给云端的它看什么、替它做什么。
///   看   读通知 (支付宝 / 微信 / 银行 App 的动账) · 读短信 (银行短信) → 自动记一笔
///        家 / 公司 / 车 → 出门到家的提醒当场弹, 记在家 / 在外面这几段
///   做   定闹钟、打电话、发短信、拍照、定位、操作手机上的 App —— 它要用时推到这台手机, 发消息打电话先等你点头
/// 开关和授权都还是原来那几处的 (auto_ledger / context_sense), 这里只是收成一页。
library;

import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:neox_app/core/i18n/tr.dart';

import '../../core/pilot/pilot_cloud.dart';
import '../../shared/clay/clay.dart';
import '../../shared/widgets/neox_toast.dart';
import 'auto_ledger.dart';
import 'context_sense.dart';
import 'pilot_node_status_card.dart';

class PilotConnectPage extends ConsumerStatefulWidget {
  const PilotConnectPage({super.key});

  @override
  ConsumerState<PilotConnectPage> createState() => _PilotConnectPageState();
}

class _PilotConnectPageState extends ConsumerState<PilotConnectPage> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_refresh());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /* 从系统设置给完权限回来: 再读一遍 */
  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) unawaited(_refresh());
  }

  Future<void> _refresh() async {
    await ref.read(autoLedgerProvider.notifier).refresh();
    await ref.read(contextSenseProvider.notifier).refresh();
  }

  Future<void> _markHere(String which) async {
    final r = await ref.read(contextSenseProvider.notifier).markHere(which);
    NeoxToast.show(r == null ? tr('没拿到位置，开一下定位') : tr('记住了，这是$r'));
  }

  Future<void> _pickCar() async {
    final n = ref.read(contextSenseProvider.notifier);
    final ds = await n.bondedDevices();
    if (!mounted) return;
    if (ds.isEmpty) {
      NeoxToast.show(tr('没看到配对过的蓝牙。先让手机连一次车上的蓝牙'));
      return;
    }
    final picked = await showClaySheet<({String address, String name})>(
      context,
      builder: (c) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          ClaySheetHeader(title: tr('哪个是你的车')),
          ClayGroup(margin: EdgeInsets.zero, children: [
            for (final d in ds.take(8))
              ClayRow(
                icon: Icons.directions_car_outlined,
                title: d.name,
                subtitle: d.car ? tr('看着像车载') : null,
                onTap: () => Navigator.pop(c, (address: d.address, name: d.name)),
              ),
          ]),
        ]),
      ),
    );
    if (picked == null) return;
    await n.setCar(picked.address, picked.name);
    NeoxToast.show(tr('记住了，${picked.name} 是你的车'));
  }

  @override
  Widget build(BuildContext context) {
    final ledger = ref.watch(autoLedgerProvider);
    final sense = ref.watch(contextSenseProvider);
    final c = ClayInk.of(context);
    final android = Platform.isAndroid;
    String perm(bool on, bool granted) => !on ? tr('没开') : granted ? tr('在记') : tr('还差系统授权');
    return ClayPage(
      title: tr('连接'),
      body: ListView(
        padding: const EdgeInsets.only(bottom: 48),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(24, 4, 24, 0),
            child: Text(tr('这台手机给它看什么、替它做什么。都进你的个人记录，电脑上看到的是同一份'),
                style: TextStyle(fontSize: 13, color: c.grey, height: 1.5)),
          ),
          /* 这台手机此刻算不算在线 / 它最近拿这台手机办过什么 (pilot:D-18)。
           * 没有云端实现的版本不画 —— 否则会一直显示「没连上」, 像出了故障。 */
          if (ref.watch(pilotCloudProvider) != null) const PilotNodeStatusCard(),
          ClaySectionLabel(tr('给它看的')),
          ClayGroup(children: [
            ClayRow(
              icon: Icons.receipt_long_outlined,
              title: tr('自动记账'),
              subtitle: !android
                  ? tr('iPhone 不让 App 读通知和短信；短信在 Mac 上同步 (电脑「连接」里开)')
                  : ledger.on && !ledger.working
                  ? tr('还没在记：通知和短信的系统授权都没给，点下面一项去开')
                  : tr('支付宝、微信、银行 App 的通知和银行短信，动账自动记一笔'),
              chevron: false,
              /* 开关显示的是「真的在记」, 不是「点过开」—— 没给系统授权时原来显示 On, 实际一笔都记不了
               * (2026-10-14 实测)。没授权时再点开 = 重新去要授权。 */
              trailing: android
                  ? ClaySwitch(
                      value: ledger.working,
                      onChanged: (v) => unawaited(v
                          ? ref.read(autoLedgerProvider.notifier).enable(notif: true, sms: true)
                          : ref.read(autoLedgerProvider.notifier).disable()),
                    )
                  : null,
            ),
            if (android && ledger.on) ...[
              ClayRow(
                icon: Icons.notifications_active_outlined,
                title: tr('读通知'),
                value: perm(ledger.on, ledger.notif),
                onTap: ledger.notif ? null : () => unawaited(ref.read(autoLedgerProvider.notifier).enable(notif: true, sms: false)),
              ),
              ClayRow(
                icon: Icons.sms_outlined,
                title: tr('读短信'),
                value: perm(ledger.on, ledger.sms),
                onTap: ledger.sms ? null : () => unawaited(ref.read(autoLedgerProvider.notifier).enable(notif: false, sms: true)),
              ),
            ],
            if (android) ...[
              ClayRow(
                icon: Icons.home_outlined,
                title: tr('家'),
                subtitle: sense.home ? tr('到家、出门的提醒当场弹') : tr('站在家里点一下'),
                value: sense.home ? tr('已设') : tr('这里是家'),
                onTap: () => unawaited(_markHere('home')),
              ),
              ClayRow(
                icon: Icons.work_outline_rounded,
                title: tr('公司'),
                subtitle: sense.work ? tr('到公司的提醒在这时候弹') : tr('在公司时点一下'),
                value: sense.work ? tr('已设') : tr('这里是公司'),
                onTap: () => unawaited(_markHere('work')),
              ),
              ClayRow(
                icon: Icons.directions_car_outlined,
                title: sense.car == null ? tr('你的车') : tr('车 · ${sense.car}'),
                subtitle: tr('连上车载蓝牙算开车，断开记住停在哪'),
                value: sense.car == null ? tr('选一下') : tr('换'),
                onTap: () => unawaited(_pickCar()),
              ),
              if ((sense.home || sense.work) && !sense.bgLocation)
                ClayRow(icon: Icons.location_on_outlined, title: tr('定位选「始终允许」'), subtitle: tr('不然 App 没开时它不知道你出门、到家'), danger: true),
            ],
          ]),
          ClaySectionLabel(tr('替它做的')),
          ClayGroup(children: [
            ClayRow(
              icon: Icons.smartphone_rounded,
              title: tr('用这台手机办事'),
              subtitle: tr('定闹钟、打电话、发短信、拍照、定位、操作手机上的 App。发消息、打给别人前先等你点头'),
              chevron: false,
            ),
          ]),
        ],
      ),
    );
  }
}
