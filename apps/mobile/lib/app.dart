/// app.dart — Neox 顶层 MaterialApp shell + lifecycle 观察.
///
/// 这里把 WidgetsBindingObserver 接进来, 应用锁 controller 知道 app 何时 pause/resume,
/// 决定要不要把 unlocked 状态重置 (超时再锁).
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/edition/edition.dart';
import 'core/network/keep_alive_service.dart';
import 'core/network/ws_client_provider.dart';
import 'features/timeline/state/timeline_state.dart';
import 'core/notifications/inbox.dart';
import 'core/notifications/local_notifications.dart';
import 'core/router.dart';
import 'core/security/biometric_lock.dart';
import 'core/startup/startup_coordinator.dart';
import 'features/home/state/selected_model_provider.dart' show availableModelsProvider;
import 'shared/theme/app_theme.dart';
import 'shared/theme/display_prefs.dart';
import 'shared/theme/theme_mode_provider.dart';
import 'shared/theme/theme_variant_provider.dart';
import 'shared/widgets/neox_drawer.dart' show openSessionFromOutside;
import 'shared/widgets/neox_toast.dart';
import 'features/pilot/context_sense.dart';
import 'features/pilot/phone_signals.dart';

class NeoxApp extends ConsumerStatefulWidget {
  const NeoxApp({super.key});
  @override
  ConsumerState<NeoxApp> createState() => _NeoxAppState();
}

class _NeoxAppState extends ConsumerState<NeoxApp> with WidgetsBindingObserver {
  final _messengerKey = GlobalKey<ScaffoldMessengerState>();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    /* 点 agent 通知 → 回到对应会话: 退回首页那一层 (停在电脑页 / 设置里也能看见), 模式和连接跟着会话走,
     * 电脑上的会话左上给 ← 回那台电脑 */
    LocalNotifications.onSessionTap = (sessionId) {
      unawaited(openSessionFromOutside(ref, ref.read(appRouterProvider), sessionId));
    };
    /* 每晚问一句 → 打开 Pilot */
    LocalNotifications.onPayloadTap = (p) => ref.read(appRouterProvider).push(p.startsWith('route:') ? p.substring(6) : '/pilot');
    /* 点推送通知进 App → 打开消息页 (不然进来只看到首页, 刚才通知说了什么无处可查) */
    InboxStore.instance.openRequests.addListener(_openInbox);
  }

  void _openInbox() {
    final router = ref.read(appRouterProvider);
    final to = InboxStore.instance.openTarget == 'pilot_today' ? '/pilot/today' : '/inbox';
    if (router.routerDelegate.currentConfiguration.uri.path != to) router.push(to);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    InboxStore.instance.openRequests.removeListener(_openInbox);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final lock = ref.read(biometricLockProvider.notifier);
    switch (state) {
      case AppLifecycleState.paused:
      case AppLifecycleState.hidden:
        lock.onPaused();
        /* 心跳放松 — 没人看屏幕时不必每 8s 把射频拉起来一次 */
        ref.read(wsClientProvider.notifier).setForeground(false);
        _keepAliveIfTaskRunning();
        break;
      case AppLifecycleState.resumed:
        lock.onResumed();
        /* 前台服务的使命结束 (它只在后台保活用) */
        unawaited(KeepAliveService.stop());
        ref.read(wsClientProvider.notifier).setForeground(true);
        unawaited(ref.read(startupCoordinatorProvider).reconnectOnForeground());
        /* 回到 App = 已经响过的闹钟级提醒你知道了, 撤掉「再叫你一次」 */
        unawaited(LocalNotifications.ackAlarms());
        /* 模型列表重拉: 原来只在启动时拉一次, App 挂后台期间服务端下架的模型 (2026-10-05 的
         * gpt-6-luna) 回来还列着、还能选。重拉期间旧列表照常显示, 不会闪空。 */
        ref.invalidate(availableModelsProvider);
        /* 回前台 → 先探测连接 (死了立刻重连), 再 attachOrCatchUp 补齐进度:
         * Execution 快照 + EntryLog gap-fill。只认 activeTimelineSessionId —— 首页打开电脑会话时
         * 会设上它, 打开手机本地会话时会清掉; 手机会话拿去问电脑, 电脑回"不存在", 本地数据会被删。 */
        final ws = ref.read(wsClientProvider);
        final activeSid = ws.activeTimelineSessionId;
        unawaited(
          ref.read(wsClientProvider.notifier).resumeAndCatchUp(activeSid),
        );
        break;
      case AppLifecycleState.inactive:
        /* 离开前台的第一拍就挂 —— 安卓 12+ 不许进了后台再起前台服务, 等到 paused 可能被拒。
         * inactive 时界面还可见, 系统放行; 只是拉下通知栏也会走这里, 回来立刻撤掉, 无害。 */
        _keepAliveIfTaskRunning();
        break;
      case AppLifecycleState.detached:
        break;
    }
  }

  /// 电脑上正有任务在跑时切走 → 挂前台服务, 安卓就不会冻结进程, 连接和进度都留着。
  /// 没任务在跑就不挂: 空闲时断了回来再连也不损失什么, 省电。
  void _keepAliveIfTaskRunning() {
    final wsNow = ref.read(wsClientProvider);
    /* 只看电脑会话 (手机本地会话不需要连接保活) */
    final sid = wsNow.activeTimelineSessionId;
    if (wsNow.connection == WsConnectionState.connected &&
        wsNow.transport != WsTransport.cloudAgent &&
        sid != null &&
        ref.read(timelineStateProvider(sid)).agentRunning) {
      unawaited(KeepAliveService.start());
    }
  }

  @override
  Widget build(BuildContext context) {
    final router = ref.watch(appRouterProvider);
    final themeMode = ref.watch(themeModeProvider);
    final variant = ref.watch(themeVariantProvider);
    /* 设置 → 外观: 字号乘在系统字号上; 动效关掉 = 按「减少动画」走 */
    final display = ref.watch(displayPrefsProvider);
    /* 发行版常驻的 provider (商业版: presence 在线通道) 挂在 App 壳上保活 */
    ref.read(editionProvider).watchAppShell(ref);
    /* 手机上的通知 / 短信 / 未接来电交给云端的 Pilot (features/pilot/phone_signals.dart) */
    ref.read(phoneSignalsProvider);
    /* 情境层: 到家 / 出门 / 开车 / 外地的状态入库 (features/pilot/context_sense.dart) */
    ref.read(contextSenseLifecycleProvider);
    /* 连电脑的通道 (同 Wi-Fi 直连 ↔ 远程中继) 怎么切都不弹提示 —— 2026-10-05 用户:
     * 「后台连接与否不能影响用户, 没必要提示自动连接上」。那条 SnackBar 正好盖在输入框上,
     * 还会把真正的错误提示顶掉。连接状态在电脑会话里自有显示, 这里静默。 */
    return MaterialApp.router(
      title: 'Neox',
      /* 本地化代理 (2026-08-08) — 之前完全没配, 后果是**现在就有的**:
       * Flutter 内建控件的文案走 Material/Cupertino 自带的本地化包, 没有
       * delegates 时一律退回英文 —— 文本框长按弹出的是 "Paste / Select All",
       * 日期选择器、滚动语义、清除按钮的 tooltip 也全是英文, 跟满屏中文界面
       * 混在一起。我们自己的文案是中文硬编码, 反而没问题。
       *
       * 2026-09-24 放开英文: 自家文案走 core/i18n/tr.dart (中文原文即 key,
       * 英文对照在 en_strings.dart), 系统语言非中文时业务文案与系统控件一起切英文。
       * 顺序有意义: 系统语言都不匹配时 Flutter 取第一个。英文放第一 ——
       * 跟 tr() 的判断一致 (非 zh 一律英文), 否则法语系统会是"业务文案英文 +
       * 系统控件中文"。zh 系统照样按语言码匹配到下面的中文项。 */
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      supportedLocales: const [
        Locale('en'),
        Locale('zh', 'CN'),
        Locale('zh', 'TW'),
        Locale('zh', 'HK'),
      ],
      theme: AppTheme.build(variant: variant, brightness: Brightness.light),
      darkTheme: AppTheme.build(variant: variant, brightness: Brightness.dark),
      themeMode: themeMode,
      routerConfig: router,
      debugShowCheckedModeBanner: false,
      /* 关掉 iOS 系统长按菜单, 统一用 Flutter 画的 (样式同 iOS)。Flutter 3.32 的 SelectableText 在
       * iOS 16+ 默认弹系统菜单, 而系统菜单要求有输入连接 —— 只读的回复正文没有: debug 包整屏变红,
       * release 包长按选中后不出「拷贝」(2026-10-08 模拟器实测, 回复正文 markdown 就是 SelectableText)。 */
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          supportsShowingSystemContextMenu: false,
          textScaler: TextScaler.linear(MediaQuery.textScalerOf(context).scale(1) * display.textScale),
          disableAnimations: MediaQuery.of(context).disableAnimations || !display.motion,
        ),
        /* 全局提示改成顶部胶囊 (见 neox_toast.dart): 页面里照常 showSnackBar, 这一层接住 */
        child: NeoxToastLayer(
          child: NeoxScaffoldMessenger(key: _messengerKey, child: child!),
        ),
      ),
    );
  }
}
