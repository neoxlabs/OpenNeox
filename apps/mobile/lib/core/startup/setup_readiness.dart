/// setup_readiness.dart — 「这台手机现在到底能不能干活」的单一判据.
///
/// 为什么需要它 (2026-08-08):
///   全新用户装上 app → 直接落到聊天空态 → 打字发送。路由链是
///   sessionRouter.createBestSession(auto) → 没配对电脑 → 云端不可用(未登录)
///   → 落 phone-local → modelGateway._effectiveAccessToken() 抛
///   `请先登录账户后使用手机模式` → 顶上一条**没有任何按钮**的 SnackBar。
///
///   而这个产品实际有三条互不依赖的起步路径, 用户一条都看不见:
///     · 登录 Neox 账号        → 用订阅额度里的托管模型
///     · 填自己的 API Key      → 零账号直连厂商 (产品的核心主张之一)
///     · 扫码连自己的电脑      → 完整 Agent, 工具/文件/终端
///
///   所以问题不是"错误文案不好", 是**没人在发送之前告诉用户还缺什么**。
///   这个 provider 就是那个判据: 三条路一条都不通 = 还没准备好, UI 据此
///   在首屏摊开选择、在发送前拦截并给出路, 而不是让人撞进一条死胡同。
///
/// 判据故意宽松 (只看"配置上通不通", 不做网络探活):
///   探活要么慢要么会误判 (电脑没开机 ≠ 没配对), 而这里的用途是决定
///   "要不要给引导", 宁可放过也不要把已经配好的人又拦一道。真连不上的
///   错误由各自链路自己报, 那些错误本来就是可诊断的。
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../edition/edition.dart';
import '../byok/byok_store.dart';
import '../local_llm/local_model_catalog.dart';
import '../models/model_store.dart';
import '../storage/database.dart';
import '../storage/paired_desktop_kind.dart';

/// 三条起步路径各自通不通 + 汇总.
class SetupReadiness {
  const SetupReadiness({
    required this.hasAccount,
    required this.hasOwnKey,
    required this.hasDesktop,
    this.hasLocalModel = false,
  });

  /// 下载了至少一个本机模型 (2026-09-30) —— 不登录、不填 Key、不连电脑也能聊。
  final bool hasLocalModel;

  /// 登录了 NeoxCloud — 能用订阅额度里的托管模型 (走 /n1 网关).
  final bool hasAccount;

  /// 至少一个启用的 BYOK provider 且配了模型 — 零账号直连厂商.
  final bool hasOwnKey;

  /// 至少一台配对过、且不是云端虚拟设备的真电脑.
  final bool hasDesktop;

  /// 任意一条通 = 用户发消息不会撞死胡同.
  bool get isReady => hasAccount || hasOwnKey || hasDesktop || hasLocalModel;

  /// 一条都没有 —— 全新用户的初始状态, 需要首屏引导.
  bool get isBlank => !isReady;

  /// 已通的路径条数 (引导卡上打勾用).
  int get readyCount =>
      (hasAccount ? 1 : 0) + (hasOwnKey ? 1 : 0) + (hasDesktop ? 1 : 0);

  static const blank = SetupReadiness(
    hasAccount: false,
    hasOwnKey: false,
    hasDesktop: false,
  );

  @override
  bool operator ==(Object other) =>
      other is SetupReadiness &&
      other.hasAccount == hasAccount &&
      other.hasOwnKey == hasOwnKey &&
      other.hasDesktop == hasDesktop &&
      other.hasLocalModel == hasLocalModel;

  @override
  int get hashCode => Object.hash(hasAccount, hasOwnKey, hasDesktop, hasLocalModel);
}

/// 配对电脑数 (只数真电脑, 排除 cloud agent 的虚拟 chip).
///
/// 用 watchAll 而不是 watchReachable: 这里判的是"配没配过", 不是"此刻连不连得上"。
/// 电脑关机的人不该被当成全新用户再引导一遍。
final _pairedRealDesktopCountProvider = StreamProvider<int>((ref) {
  return ref
      .watch(appDatabaseProvider)
      .pairedDesktopsDao
      .watchAll()
      .map((list) => list.where(isRealPairedDesktop).length);
});

/// 发送前拦截用: 等配对电脑数的第一帧到了再判。
///
/// 直接 ref.read(setupReadinessProvider) 时, 如果此刻没有别人在 watch 它, stream 还没出第一帧,
/// 电脑数按 0 算 —— 刚配好电脑 (电脑页里显示在线) 发第一句话就被「选一种方式开始」拦下 (2026-10-28 真机)。
Future<SetupReadiness> readSetupReadiness(WidgetRef ref) async {
  await ref.read(_pairedRealDesktopCountProvider.future).catchError((_) => 0);
  return ref.read(setupReadinessProvider);
}

/// 启动时把本机模型的安装状态读一遍 (ModelStore 的状态只在 refresh / 下载后才有)
final _localModelsScanProvider = FutureProvider<void>((ref) async {
  /* 先把自己在线添加的模型读进目录, 下面的扫描和模型选择器都要用 */
  await loadCustomLocalLlms();
  final store = ref.read(modelStoreProvider.notifier);
  for (final m in kLocalLlms) {
    await store.refresh(m.pack);
  }
});

/// 起步状态 — 首屏引导卡与发送前拦截共用同一个判据.
final setupReadinessProvider = Provider<SetupReadiness>((ref) {
  ref.watch(_localModelsScanProvider);
  final modelStates = ref.watch(modelStoreProvider);
  final hasLocalModel = kLocalLlms.any((m) => modelStates[m.pack.key]?.installed == true);
  final loggedIn = ref.watch(accountStatusProvider).signedIn;
  final byokProviders = ref.watch(byokStoreProvider);
  /* stream 首帧未到时按 0 处理 —— 但这只影响"要不要显引导", 且 stream 到达后
   * provider 会重算并重建 UI, 不会卡在错误状态。 */
  final desktopCount =
      ref.watch(_pairedRealDesktopCountProvider).valueOrNull ?? 0;

  return SetupReadiness(
    hasAccount: loggedIn,
    /* 光有 provider 不算 —— 得启用且真配了模型, 否则选模型时依然是空的 */
    hasOwnKey: byokProviders.any((p) => p.enabled && p.models.isNotEmpty),
    hasDesktop: desktopCount > 0,
    hasLocalModel: hasLocalModel,
  );
});
