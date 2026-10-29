/// router.dart — go_router 配置 + 路由守卫.
///
/// 路由约定 (2026-06-28 重构 — 拆掉 StatefulShellRoute 3-tab, 改单 home + drawer):
///   /                      → HomeStagePage      (新主页, 对话即首页 + 抽屉)
///   /workspace             → WorkspacePage      (从抽屉进, 全屏)
///   /settings              → SettingsPage       (从抽屉账户区进, 全屏)
///   /pairing               → 顶层工具页
///   /settings/*            → 设置二级详情 (设备 / 连接体验 / 自己的 Key)
///   发行版自己的页面 (商业版: /login /register /forgot-password /cloud
///   /settings/account /settings/membership) 由 [NeoxEdition.routes] 加进来。
///
/// 注: 没有 /timeline/:id 路由 — 会话渲染在 '/' 主页内 (currentSessionProvider 切换),
/// 二级页要进会话统一走 openSessionOnHome().
///
/// 守卫 (redirect): 引导页 > 发行版守卫 (商业版: 没登录访问要登录路由 → /login;
/// 已登录访问 /login* → /) > 应用锁。发行版守卫跟着 [NeoxEdition.routerRefresh] 重判。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/home/home_stage_page.dart';
import '../features/image/image_studio_page.dart';
import '../features/inbox/inbox_page.dart';
import '../features/voice/voice_chat_page.dart';
import '../features/onboarding/onboarding_page.dart';
import '../features/onboarding/onboarding_state.dart';
import '../features/pairing/pairing_page.dart';
import '../features/pilot/pilot_home_page.dart';
import '../features/pilot/pilot_keepalive_page.dart';
import '../features/pilot/pilot_today_page.dart';
import '../features/settings/connection_page.dart';
import '../features/settings/devices_page.dart';
import '../features/settings/local_models_page.dart';
import '../features/settings/models_hub_page.dart';
import '../features/settings/providers_page.dart';
import '../features/settings/voice_settings_page.dart';
import '../features/settings/phone_use_page.dart';
import '../features/settings/local_linux_page.dart';
import '../features/files/files_page.dart';
import '../features/sessions/all_sessions_page.dart';
import '../features/sessions/search_page.dart';
import '../features/remote/remote_pages.dart';
import '../features/settings/cloud_asr_page.dart';
import '../features/settings/update_page.dart';
import '../features/settings/settings_page.dart';
import '../features/workbench/workbench_page.dart';
import '../features/workspace/workspace_page.dart';
import '../features/home/state/home_mode_provider.dart';
import 'edition/edition.dart';
import 'security/biometric_lock.dart';
import 'security/biometric_lock_screen.dart';
import 'security/secure_screen.dart';

/* 2026-06-24: 公开路由扩展 — 未登录用户也能用 app (LAN pair 桌面 / BYOK 等本地能力).
 *   旧版只允许 /login,/register 等 → BYOK user 必须先登 NeoxCloud 才能进, UX 阻塞.
 *   现在 '/' (sessions 主壳) 跟其它本地功能页都允许未登访问 — 云端功能 (membership / cloud relay /
 *   syncDesktops) 单独 gate, 不阻塞主流程.
 *   这里只列**核心**路由; 发行版自己的公开页 (登录 / 注册 …) 由它的守卫自己认。 */
const _publicRoutes = {
  '/',
  '/pairing',
  /* BYOK 零账号原则 (2026-07-20 用户拍板): 只有订阅功能 (cloudAgent / 云中转)
   * 需要登录。本地能力 — LAN 配对桌面、我的设备、工作区、连接管理、自己的
   * Key、设置 — 一律零账号可用。用户自建中转 (SSH 隧道到自己服务器) 也属于
   * 本地能力: 手动填 host:port 直连即可, 不经 NeoxCloud。 */
  '/settings',
  /* 09-30「我的模型」把自己的 Key 和本地模型收进这一页, 这里漏加 → 没登录点进去被弹去登录,
   * 自己的 Key、手机本地模型都进不去 (Pilot 离线时手机上的它就没有脑子用)。2026-10-02 模拟器实测补上 */
  '/settings/models',
  '/settings/models/local',
  '/settings/providers',
  /* 语音: 本地识别 / 本地声音 / 自己的阿里云 Key 都不需要账号, 没登录点「语音」被弹去登录 (2026-10-10 模拟器实测补上) */
  '/settings/voice',
  '/settings/voice/cloud',
  '/settings/devices',
  '/update',
  /* 消息页: 推送 / 任务事件 / 提醒的本机记录, 不需要账号 */
  '/inbox',
  '/history',
  '/search',
  '/files',
  '/settings/connection',
  '/workspace',
  '/image',
  /* Pilot 住在配对的电脑上, 跟工作区一样零账号可用 */
  '/pilot',
};

const _lockRoute = '/locked';

/// 根 Navigator —— 不在页面里的代码 (agent 工具要你确认「打给王总?」) 靠它弹对话框
final rootNavigatorKey = GlobalKey<NavigatorState>();

/// 首启引导 — 没看过时**任何**路由都先落到这里.
///
/// 放在 auth gate 之前: 引导不需要账号 (BYOK 零账号是产品主张), 而且先让人
/// 知道这是个什么东西、再问要不要登录, 顺序才对。
const _onboardingRoute = '/onboarding';

/// FLAG_SECURE 页面 (防截屏) — 集中由 router 导航监听管理.
/// 之前分散在各页 initState/dispose 里 set/clear, 页面重叠/替换时顺序竞争
/// 导致 flag 泄漏 — 主页截图全黑 (真机实锤). 现在单点判定: 当前路由在这个
/// 集合里就 set, 否则 clear, 永不漂移.
///
/// 2026-08-04 清空: 登录/注册页原本在这里防截屏, 代价是用户连反馈问题都截不了图
/// (用户实录: "应用支持截屏, 你现在限制了, 得放开")。这几页上能被截到的只有用户
/// 自己正在输入的邮箱, 密码框系统本来就不进截图 —— 收益不抵代价。
/// 保留这套机制本身: 以后真有需要防截屏的页面 (比如展示恢复码), 往里加一条即可。
const _secureRoutes = <String>{};

/// 「今天」路由指向哪一页 (pilot:U-04) —— 推送点开和导航共用这一个入口。
/// 单独留成函数是为了让测试钉住: 它只能打开今天页, 不能再指回会话列表。
Widget buildPilotTodayRoute() => const PilotTodayPage();

final appRouterProvider = Provider<GoRouter>((ref) {
  /* 监听 发行版守卫信号 (商业版=登录态) 跟 biometric lock 双状态变化 — 任一变化都 re-evaluate redirect. */
  final edition = ref.read(editionProvider);
  final notifier = ValueNotifier<int>(0);
  final editionRefresh = edition.routerRefresh;
  if (editionRefresh != null) {
    ref.listen<Object?>(editionRefresh, (_, _) {
      notifier.value++;
    });
  }
  ref.listen<bool>(onboardingSeenProvider, (_, _) {
    notifier.value++;
  });
  ref.listen<BiometricLockState>(biometricLockProvider, (_, _) {
    notifier.value++;
  });
  ref.onDispose(notifier.dispose);

  final router = GoRouter(
    navigatorKey: rootNavigatorKey,
    initialLocation: '/',
    refreshListenable: notifier,
    redirect: (context, state) {
      /* 引导优先于一切 —— 包括登录态判断. 看过一次就永远不再拦. */
      if (!ref.read(onboardingSeenProvider)) {
        return state.matchedLocation == _onboardingRoute
            ? null
            : _onboardingRoute;
      }
      if (state.matchedLocation == _onboardingRoute) return '/';

      final loc = state.matchedLocation;
      final isLockRoute = loc == _lockRoute;
      /* 没有 Pilot 的发行版: 推送 / 深链 / 旧状态带进来的 /pilot 一律回首页 */
      if (loc.startsWith('/pilot') && !edition.pilotAvailable) return '/';

      /* 核心判定 = 应用锁。发行版守卫决定它在什么前提下生效 (商业版: 登录之后),
       * 以及前后要不要再加跳转 (商业版: 未登录 → /login, 已登录在登录页 → /)。 */
      String? lockRedirect() {
        final lock = ref.read(biometricLockProvider);
        /* 应用锁需要解锁 → 强制 /locked */
        if (lock.shouldGate) {
          return isLockRoute ? null : _lockRoute;
        }
        /* 在锁屏路由但已不需要锁 → 跳主壳 */
        if (isLockRoute) return '/';
        return null;
      }

      return edition.redirect(
        ref,
        loc,
        isCorePublic: _publicRoutes.contains(loc),
        coreRedirect: lockRedirect,
      );
    },
    routes: [
      /* ── 发行版自己的页面 (商业版: 登录 / 注册 / 云端 / 账户 / 会员) ── */
      ...edition.routes(),
      GoRoute(
        path: _lockRoute,
        builder: (_, __) => const BiometricLockScreen(),
      ),
      GoRoute(
        path: _onboardingRoute,
        builder: (context, _) => OnboardingPage(
          /* markSeen 已在页内做掉, redirect 会跟着 provider 变化把这里弹走;
           * 显式 go('/') 是兜底 —— 跟登录页那条同样的理由 (imperative route 上
           * redirect 判定不可靠), 不再依赖单点生效。 */
          onDone: () => context.go('/'),
        ),
      ),

      /* ── 全屏页 (从 home / drawer 进, 不属主流) ─────────────── */
      GoRoute(path: '/pairing', builder: (_, __) => const PairingPage()),
      GoRoute(
        path: '/settings/devices',
        builder: (_, __) => const DevicesPage(),
      ),
      GoRoute(
        path: '/settings/connection',
        builder: (_, __) => const ConnectionPage(),
      ),
      GoRoute(
        path: '/settings/providers',
        builder: (_, __) => const ProvidersPage(),
      ),
      GoRoute(
        path: '/settings/voice',
        builder: (_, __) => const VoiceSettingsPage(),
      ),
      GoRoute(
        path: '/settings/phone-use',
        builder: (_, __) => const PhoneUsePage(),
      ),
      GoRoute(
        path: '/settings/local-linux',
        builder: (_, __) => const LocalLinuxPage(),
      ),
      GoRoute(
        path: '/files',
        builder: (_, __) => const FilesPage(),
      ),
      GoRoute(
        path: '/remote',
        builder: (_, __) => const RemotePage(),
      ),
      GoRoute(
        path: '/remote/:deviceId',
        builder: (_, s) => RemoteDesktopPage(deviceId: Uri.decodeComponent(s.pathParameters['deviceId'] ?? '')),
      ),
      /* 某台设备上的会话 —— 工作 / 编码 的首页本身就是设备页 (见 features/workbench),
       * 这里只挂"点进某一台设备"的下一层 */
      GoRoute(
        path: '/workbench/:mode/device/:deviceId',
        builder: (_, s) => DeviceSessionsPage(
          mode: homeModeFromWire(s.pathParameters['mode']) ?? HomeMode.work,
          deviceId: Uri.decodeComponent(s.pathParameters['deviceId'] ?? ''),
        ),
      ),
      GoRoute(
        path: '/settings/voice/cloud',
        builder: (_, __) => const CloudAsrPage(),
      ),
      GoRoute(
        path: '/settings/models',
        builder: (_, __) => const ModelsHubPage(),
      ),
      GoRoute(
        path: '/settings/models/local',
        builder: (_, __) => const LocalModelsPage(),
      ),
      /* 应用内更新 —— 零账号可用 (装包这件事跟登录无关), 见 _publicRoutes */
      GoRoute(path: '/update', builder: (_, __) => const UpdatePage()),
      GoRoute(path: '/inbox', builder: (_, _) => const InboxPage()),
      /* 侧栏「全部 ›」/ 搜索 (陶土稿 v5) */
      GoRoute(path: '/history', builder: (_, _) => const AllSessionsPage()),
      GoRoute(path: '/search', builder: (_, s) => SearchPage(initial: s.uri.queryParameters['q'] ?? '')),

      /* ── 主页 (新): 对话即首页 + 左抽屉, 无底部 tab ─────────── */
      GoRoute(path: '/', builder: (_, _) => const HomeStagePage()),
      /* ── 从抽屉/账户区跳进的全屏页 ─────────────────────────── */
      GoRoute(path: '/workspace', builder: (_, _) => const WorkspacePage()),
      /* Pilot: 你的助理们 —— 跟对话 / 工作 / 编码 分开的独立入口 */
      GoRoute(path: '/pilot', builder: (_, _) => const PilotHomePage()),
      /* 让 Pilot 一直在线: 无障碍 / 通知 / 电池白名单 / 自启动逐项跳转 (安卓) */
      GoRoute(path: '/pilot/keepalive', builder: (_, _) => const PilotKeepAlivePage()),
      /* Pilot「今天」: 晨间简报 / 到点提醒 / 成品做好了 的推送点开就到这 ——
         2026-10-14 曾改指会话列表, 用户点「今天」看到的是聊天, 2026-10-18 改回来 (pilot:U-04) */
      GoRoute(path: '/pilot/today', builder: (_, _) => buildPilotTodayRoute()),
      GoRoute(path: '/image', builder: (_, _) => const ImageStudioPage()),
      /* Chat 的语音对话: 圆球 + 边听边说, 走的还是手机 Chat 那条路 */
      GoRoute(path: '/voice-chat', builder: (_, _) => const VoiceChatPage()),
      GoRoute(path: '/settings', builder: (_, _) => const SettingsPage()),
    ],
  );

  /* FLAG_SECURE 集中控制 — 每次导航后按当前路由单点判定 (见 _secureRoutes 注释) */
  void syncSecureFlag() {
    /* 不能用 currentConfiguration.uri — go_router 源码明确写着
     * "This uri only reflects RouteMatchs that are not ImperativeRouteMatch",
     * 也就是 context.push('/login') 之后 uri 仍停在 '/settings', 判定必然落空,
     * FLAG_SECURE 在登录/注册/找回密码页从来没置上过 (真机 dumpsys window 实锤).
     * 用最后一个 match 的 matchedLocation: imperative push 与 go 都取得到真实路由. */
    final config = router.routerDelegate.currentConfiguration;
    final loc = config.isNotEmpty
        ? config.last.matchedLocation
        : config.uri.path;
    if (_secureRoutes.contains(loc)) {
      SecureScreen.setSecure();
    } else {
      SecureScreen.clearSecure();
    }
  }

  router.routerDelegate.addListener(syncSecureFlag);
  ref.onDispose(() => router.routerDelegate.removeListener(syncSecureFlag));
  /* 冷启动首帧也判一次 (首次导航 listener 可能已错过) */
  Future.microtask(syncSecureFlag);

  return router;
});
