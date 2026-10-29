/// pilot_home_page.dart — 侧栏点 Pilot 进来的那一页 (2026-10-01; 2026-10-14 改成 IM).
///
/// 有 Pilot → 会话列表 (PilotInboxPage: 每个 Pilot / 专员一个联系人 + 团队群);
/// 第一次用 → 先问「先帮你盯什么」; 没开通 / 没连上 → 陶土空状态。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:neox_app/core/i18n/tr.dart';

import '../../core/notifications/local_notifications.dart';
import '../../shared/clay/clay.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'pilot_inbox_page.dart';
import 'pilot_keepalive_page.dart';
import 'pilot_link.dart';
import 'pilot_setup_page.dart';

class PilotHomePage extends ConsumerStatefulWidget {
  const PilotHomePage({super.key});

  @override
  ConsumerState<PilotHomePage> createState() => _PilotHomePageState();
}

class _PilotHomePageState extends ConsumerState<PilotHomePage> {
  /// 这台手机第一次进: 先问「先帮你盯什么」(null = 还没查完)
  bool? _setup;

  @override
  void initState() {
    super.initState();
    /* Pilot 要能找到你: App 在后台 / 锁屏时来电靠通知响铃, 进 Pilot 页时把通知权限要了 */
    unawaited(LocalNotifications.ensurePermission());
    unawaited(pilotNeedsSetup().then((v) {
      if (mounted) setState(() => _setup = v);
    }));
    /* 记住「停在 Pilot」: 下次冷启动直接回到会话列表; 自己退出来就不记了 (进程被杀不走 dispose) */
    unawaited(SharedPreferences.getInstance().then((p) => p.setString(kPilotLastOpenPref, 'list')));
  }

  @override
  void dispose() {
    unawaited(SharedPreferences.getInstance().then((p) => p.remove(kPilotLastOpenPref)));
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final contacts = ref.watch(pilotContactsProvider);
    return contacts.when(
      loading: () => const ClayPage(title: 'Pilot', body: Center(child: ClaySpinner(size: 22))),
      error: (_, __) => ClayPage(
        title: 'Pilot',
        body: ClayEmpty(
          art: 'empty-offline',
          title: tr('没连上 Pilot'),
          message: tr('检查一下网络，再试一次'),
          action: ClayButton.ink(label: tr('重试'), onTap: () => ref.invalidate(pilotContactsProvider)),
        ),
      ),
      data: (list) => list.isEmpty
          ? ClayPage(
              title: 'Pilot',
              body: ClayEmpty(
                art: 'empty-shelf',
                title: tr('还没有 Pilot'),
                message: tr('在电脑上切到 Pilot 模式建一个，这里就有了'),
                action: ClayButton(label: tr('返回'), kind: ClayButtonKind.clay, onTap: () => context.canPop() ? context.pop() : context.go('/')),
              ),
            )
          : switch (_setup) {
              null => const ClayPage(title: 'Pilot', body: SizedBox.shrink()),
              true => PilotSetupPage(
                  name: list.first.name,
                  onDone: () {
                    setState(() => _setup = false);
                    /* 首次开 Pilot 时把「让 Pilot 一直在线」引导一次, 之后从设置进 */
                    unawaited(promptPilotKeepAliveOnce(context));
                  },
                ),
              false => PilotInboxPage(pilots: list),
            },
    );
  }
}
