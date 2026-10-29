/// bootstrap.dart — Neox mobile 启动流程 (两个发行版共用).
///
/// 入口文件只决定"装哪个发行版" (lib/main.dart = 商业版, lib/main_open.dart = 开源版),
/// 其余启动步骤都在这里:
///   1. ensureInitialized
///   2. 替换 ErrorWidget builder (用自家小红卡, 不霸屏)
///   3. 并发预加载: SharedPreferences + 发行版自己的预加载 (商业版 = 登录凭证)
///   4. ProviderScope.override 装上发行版与预加载结果
///      → 商业版 NeoxCloudAuthController 一开始就 isLoggedIn 正确, AuthGate 不需要 splash 等异步
library;

import 'dart:async' show runZonedGuarded, unawaited;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app.dart';
import 'core/edition/edition.dart';
import 'core/errors/crash_log.dart';
import 'core/errors/friendly_error.dart' show friendlyErrorHasAccounts;
import 'core/neox_constants.dart' show kNeoxConfiguredApiBase, kNeoxProductionApiBase;
import 'core/network/edge_route.dart';
import 'core/network/neox_user_agent.dart';
import 'core/notifications/local_notifications.dart';
import 'core/startup/frame_jank_probe.dart';
import 'core/notifications/notify_prefs.dart';
import 'core/storage/app_paths.dart';
import 'core/startup/high_refresh_rate.dart';
import 'shared/theme/theme_mode_provider.dart';
import 'package:neox_app/core/i18n/tr.dart';

Future<void> runNeoxApp(NeoxEdition edition) async {
  /* zone 兜底 — 三层崩溃捕获的最外层 (见 crash_log.dart) */
  await runZonedGuarded(() => _boot(edition), (error, stack) {
    CrashLog.record('zone', '$error', stack);
  });
}

Future<void> _boot(NeoxEdition edition) async {
  WidgetsFlutterBinding.ensureInitialized();

  /* 全局异常捕获 + 本地 crash.log — 必须最早装, 后面的启动异常才收得住 */
  await CrashLog.install();

  /* 请求带上 Neox-Android/版本 —— 后台请求日志据此认出手机端 */
  NeoxUserAgent.install();

  /* 错误文案里的「登录过期」只属于有账号体系的发行版 */
  friendlyErrorHasAccounts = edition.hasAccounts;

  /* 接入线路 (Cloudflare / 香港中转): 要在第一个云端请求之前读到上次的结论; 测速在后台, 不挡首帧。
   * 测试环境 (dart-define 换了 NEOX_API_BASE) 不启用。 */
  try {
    await EdgeRoute.instance.start(
      enabled: edition.officialServices && kNeoxConfiguredApiBase == kNeoxProductionApiBase,
    );
  } catch (_) {/* 选线失败照常走 Cloudflare */}

  /* ErrorWidget.builder 必须返回**任意 constraints 都能 layout** 的 widget,
   * 否则一进 Row/Sliver/Flex 没边界 → 又抛 → ErrorWidget 又被调 → 死循环烧 CPU.
   * 历史教训: 用 Container+Column+Text 在水平槽里跑会 unbounded-width 抛, 拉爆 CPU
  * 到 107% 直至 OOM/ANR. 这里只用 LimitedBox + RichText (RichText 无 layout 副作用,
  * 自己处理 maxWidth=infinity 不抛), 双保险用 LimitedBox 兜住 unbounded 约束. */
  ErrorWidget.builder = (FlutterErrorDetails details) {
    if (kDebugMode) {
      debugPrint('[flutter-error-widget] ${details.exceptionAsString()}');
    }
    final msg = tr('页面暂时不可用，请返回后重试');
    return LimitedBox(
      maxWidth: 280,
      maxHeight: 80,
      child: DecoratedBox(
        decoration: const BoxDecoration(color: Color(0x33FF5252)),
        child: Padding(
          padding: const EdgeInsets.all(8),
          child: RichText(
            overflow: TextOverflow.ellipsis,
            maxLines: 4,
            text: TextSpan(
              text: '⚠ ',
              style: const TextStyle(
                color: Color(0xFFFF5252),
                fontSize: 12,
                fontWeight: FontWeight.w700,
              ),
              children: [
                TextSpan(
                  text: msg,
                  style: const TextStyle(
                    color: Color(0xFFFF8A80),
                    fontSize: 12,
                    fontWeight: FontWeight.w400,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  };

  /* 并发预加载 SharedPreferences + 发行版自己的预加载 (商业版: secure storage 里的
   * 登录凭证) —— 2026-09-22.
   *
   * 这行注释一直写着"并发", 代码却是两个 await 串行: 首帧要等两个平台通道**依次**
   * 走完。shared_preferences 很快, 但 flutter_secure_storage 在 Android 上要解
   * keystore, 通常是好几倍的时间 —— 串行就是白等, 而且这段完全发生在 runApp 之前。
   * 发行版的预加载自己负责吞掉失败 (读不到凭证 = 当未登录), 不许阻断启动。 */
  final prefsFuture = SharedPreferences.getInstance();
  /* iOS 要先清钥匙串残留再读凭证, 所以那边串行 (prefs 很快) */
  final iosFreshInstall = defaultTargetPlatform == TargetPlatform.iOS;
  final editionFuture = iosFreshInstall ? null : edition.preload();

  final prefs = await prefsFuture;
  if (iosFreshInstall) {
    await _wipeKeychainLeftovers(prefs);
    /* 渲染存下来的图片路径前要知道当前容器在哪 (见 app_paths.dart) */
    await AppPaths.init();
  }
  final editionOverrides = await (editionFuture ?? edition.preload());
  /* 发通知的地方同步查「这一类还要不要弹」(设置 → 通知) */
  NotifyPrefs.attach(prefs);

  runApp(
    ProviderScope(
      overrides: [
        editionProvider.overrideWithValue(edition),
        sharedPreferencesProvider.overrideWithValue(prefs),
        ...editionOverrides,
      ],
      child: const NeoxApp(),
    ),
  );

  /* 本地通知**只装插件, 不要权限** — 放 runApp 后异步做, 不阻塞首帧.
   *
   * 2026-08-08: 这里以前调的 init() 顺带就把权限要了 (Darwin 三个 request*
   * 全 true + Android requestNotificationsPermission), 于是冷启动第一帧就弹
   * 系统权限框。用户还没看懂这是什么 app 就被要权限, 通过率极低, 而且拒绝之后
   * 不可逆 —— 之后只能去系统设置里手工开。
   * 通知恰恰是这个产品的核心价值 (手机上盯着电脑跑的长任务), 等于在用户理解它
   * 之前就把最重要的能力赌掉了。
   * 权限现在由 LocalNotifications.ensurePermission() 在用户发出第一条消息时要。 */
  unawaited(LocalNotifications.init());

  /* 高刷 —— 放 runApp 之后 (一次平台调用, 不该挡首帧).
   * Android 不申请就永远 60Hz, 哪怕屏幕是 120Hz 的 (见 high_refresh_rate.dart)。 */
  unawaited(applyHighRefreshRate());

  /* 帧耗时探针 —— 只有 profile 包会真的装 (见 frame_jank_probe.dart)。
   * gfxinfo 对 Flutter 一律报 0 帧, 量丝滑只能靠引擎自己的 FrameTiming。 */
  FrameJankProbe.install();

  /* paired_desktops 残留清理已搬去 StartupCoordinator 的 P5
   * (core/startup/startup_coordinator.dart)。
   *
   * 这里原来是 `Future.delayed(500ms, () { final db = AppDatabase(); ... })` ——
   * 在 ProviderScope 之外**第二次**构造 AppDatabase, 同一个 SQLite 文件被两个
   * 独立 executor 打开。drift 每次冷启动都在 logcat 里告警:
   *   "you've created the database class AppDatabase multiple times …
   *    race conditions will occur and might corrupt the database"
   * 而这段跑的是删除/合并 paired_desktops 的写事务, 与主库并发 —— 配对表错乱的
   * 直接嫌疑。搬进 coordinator 后走 provider 的唯一实例, 且排在 auto-connect
   * 之后, 不会清掉正在用的那台。 */
}

/// iOS 卸载 App 不清钥匙串: 删了重装, flutter_secure_storage 里上一个人的登录凭证、
/// 自己的 Key、设备身份原样还在 —— 新装的 App 一打开就是别人的账号 (模拟器实测)。
/// 安卓卸载会连数据一起清, 没有这个问题。prefs 随卸载清掉, 用它标记"这次安装已经清过"。
const _kKeychainWipedKey = 'neox.ios.keychain_wiped_for_install';

Future<void> _wipeKeychainLeftovers(SharedPreferences prefs) async {
  if (prefs.getBool(_kKeychainWipedKey) == true) return;
  try {
    await const FlutterSecureStorage().deleteAll();
  } catch (e) {
    debugPrint('[boot] keychain wipe failed: $e');
  }
  await prefs.setBool(_kKeychainWipedKey, true);
}
