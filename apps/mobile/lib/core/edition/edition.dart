/// edition.dart — 发行版接缝 (2026-09-22).
///
/// ─── 为什么有它 ─────────────────────────────────────────────────────────────
///   同一份 neox_app 以两种形态发行: 带账号 / 订阅 / 托管服务的商业版, 和去掉这些
///   之后的开源版。开源树是从本仓**按目录删掉商业部分**导出来的 (见
///   scripts/public-export.json), 所以共享代码里不能有一行 import 指向商业目录 ——
///   删掉之后那一行就编译不过。
///
///   共享代码需要商业能力的地方, 一律问这里要: 能力 (登录态 / 远程中继 / 托管网关 /
///   托管出图 / 云端会话 / 在线信号) 和界面插槽 (设置页账户卡 / 抽屉底栏 / 额度条 …)。
///   [NeoxEdition] 的每个成员都带着"没有这项能力"时的默认实现, 那就是开源版的行为。
///
/// ─── 谁来注册 ───────────────────────────────────────────────────────────────
///   入口文件把发行版交给 runNeoxApp (lib/bootstrap.dart), 后者把它装进
///   [editionProvider]。商业版入口是 lib/main.dart (CommercialEdition, 在
///   lib/commercial/ 里); 开源入口是 lib/main_open.dart ([OpenEdition])。
///   整个共享树里只有 lib/main.dart 这一个文件 import 商业目录 —— 闸:
///   scripts/check-mobile-edition.mjs。
///
/// ─── 加新能力时 ─────────────────────────────────────────────────────────────
///   在这里加成员 + 写默认实现 (= 没有这项能力时该怎么表现), 商业版在
///   CommercialEdition 里覆盖。不要在共享文件里 `if (商业版)` —— 那等于把两份产品
///   的差异撒回全树, 这层接缝就白做了。
library;

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../execution/cloud_agent_access.dart';
import '../image/hosted_image_backend.dart';
import '../local_agent/hosted_web_search.dart';
import '../local_agent/model_gateway_client.dart';
import '../network/desktop_presence.dart';
import '../network/remote_link.dart';
import '../pilot/pilot_cloud.dart';
import '../voice/hosted_asr.dart';
import 'account_status.dart';
import 'plan_model.dart';

export 'account_status.dart';
export 'plan_model.dart';

/// 启动时跟本地连接并行跑的一段后台工作 (见 StartupCoordinator)。
class EditionStartupPhase {
  const EditionStartupPhase(this.name, this.body, {required this.budget});
  final String name;
  final Future<void> Function() body;
  final Duration budget;
}

/// 举报一段模型生成的内容 (App Store 审核指南 1.2)。
typedef ContentReporter =
    Future<void> Function(
      BuildContext context,
      WidgetRef ref, {
      required String text,
    });

abstract class NeoxEdition {
  const NeoxEdition();

  /// 诊断用的名字。
  String get id;

  /// 有没有账号体系 —— 决定"登录"类入口要不要出现。
  bool get hasAccounts => false;

  /// 会不会主动连官方服务 (接入线路测速 / 安卓版本检查)。开源版不连:
  /// 没登录也不该有任何请求打到官方服务器。
  bool get officialServices => false;

  /// 界面上的产品名 (关于页 / 许可页)。
  String get productName => 'OpenNeox';

  /// 「意见反馈」打开的地址。开源版去 GitHub issues —— 不带任何设备标识, 也不连官方服务。
  String get feedbackUrl => 'https://github.com/neoxlabs/OpenNeox/issues';

  /// Pilot (会打电话的私人助理) —— 档案 / 任务板 / 电话都靠云端服务, 开源版没有, 入口不出现。
  bool get pilotAvailable => false;

  // ════════════════════════════ 启动 ════════════════════════════

  /// runApp 之前、跟 SharedPreferences **并发**跑; 返回要装进 ProviderScope 的覆盖。
  Future<List<Override>> preload() async => const [];

  /// App 壳每次 build 调一次 —— 让发行版需要常驻的 provider 保持存活。
  void watchAppShell(WidgetRef ref) {}

  /// 冷启动时跟"连电脑"并行起跑的后台阶段 (不 await, 各自有时限)。
  List<EditionStartupPhase> startupPhases(Ref ref) => const [];

  // ════════════════════════════ 路由 ════════════════════════════

  /// 发行版自己的页面。
  List<RouteBase> routes() => const [];

  /// 路由守卫变化时要重新判定 redirect 的信号源 (比如登录态)。
  ProviderListenable<Object?>? get routerRefresh => null;

  /// 路由守卫。[coreRedirect] 是核心判定 (应用锁); 发行版决定在它前后加什么。
  /// [isCorePublic] = 这个核心路由不需要登录也能进。
  String? redirect(
    Ref ref,
    String location, {
    required bool isCorePublic,
    required String? Function() coreRedirect,
  }) => coreRedirect();

  // ════════════════════════════ 能力 ════════════════════════════
  //  下面每一项都由 core 里对应的 provider 转发过来, 共享代码只 watch 那些 provider。

  AccountStatus watchAccount(Ref ref) => AccountStatus.signedOut;

  /// 套餐里的模型 (会员拉到之后)。null = 没有套餐 / 还没拉到 —— 调用方不筛。
  List<PlanModel>? watchPlanModels(Ref ref) => null;
  DesktopPresenceView watchPresence(Ref ref) => const NoDesktopPresence();

  /// 云端任务的入口要不要露出来 (抽屉 / 连接页 / 运行位置选择)。
  bool watchCloudEntriesVisible(Ref ref) => false;

  /// 电脑失联时要不要给「云端接管」。
  bool watchCloudTakeoverVisible(Ref ref) => false;

  /// 账号下的电脑数 (本机一台都没配对时, 设置页拿它说"N 台")。-1 = 同步中。
  int watchAccountDesktopCount(Ref ref) => 0;

  RemoteLink? remoteLink(Ref ref) => null;
  CloudAgentAccess? cloudAgent(Ref ref) => null;
  ModelGatewayClient modelGateway(Ref ref) => const UnavailableModelGateway();
  HostedImageBackend? hostedImages(Ref ref) => null;

  /// 托管联网搜索 (agent 的 web_search 工具)。null = 没有, 工具不出现。
  HostedWebSearch? hostedWebSearch(Ref ref) => null;

  /// 托管语音识别 (订阅附带)。null = 没有, 语音设置里不出这一项。
  HostedAsr? hostedAsr(Ref ref) => null;

  /// Pilot 住在云端时手机连它的线 (core/pilot/pilot_cloud.dart); null = 没有云端, Pilot 走电脑 / 手机本地。
  PilotCloud? pilotCloud(Ref ref) => null;

  // ═══════════════════════════ 界面插槽 ══════════════════════════

  /// 设置页顶部的 sliver (升级卡等), 排在账户 + 状态那张卡后面。在设置页 build 里调用, 可以 watch。
  List<Widget> settingsHeaderSlivers(WidgetRef ref) => const [];

  /// 设置页顶部背景图上的账户块 (头像 + 昵称 + 套餐)。null = 没有账号体系, 顶部只写「我」。
  Widget? settingsAccountTile() => null;

  /// 设置页下拉刷新。null = 不能下拉刷新。
  Future<void> Function()? settingsRefresher(WidgetRef ref) => null;

  /// 设置页三连格最左那格 (会员)。null = 只有「设备」「连接」两格。
  Widget? settingsDockLeadingTile() => null;

  /// 抽屉底栏。null = 共享的「设置」入口。
  Widget? drawerFooter() => null;

  /// 输入框正上方的提示条 (额度用尽等)。
  Widget? composerStrip() => null;

  /// 设备页: 标题栏动作 / 下拉刷新 / 「连接」组追加的行 / 页底追加的组。
  List<Widget> devicesPageActions(BuildContext context, WidgetRef ref) =>
      const [];
  Future<void> refreshDevicesPage(BuildContext context, WidgetRef ref) async {}
  List<Widget> devicesPageConnectRows(BuildContext context, WidgetRef ref) =>
      const [];
  List<Widget> devicesPageGroups() => const [];

  /// 回复底下的「举报」。null = 不显示这个按钮。
  ContentReporter? get contentReporter => null;

  /// 错误药丸报"登录已失效"时点它。
  Future<void> onAuthPillTap(BuildContext context, WidgetRef ref) async {}
}

/// 开源版: 什么都不加 —— 每一项都是上面的默认实现。
class OpenEdition extends NeoxEdition {
  const OpenEdition();

  @override
  String get id => 'open';
}

/// 当前发行版。入口 (runNeoxApp) 覆盖它; 没覆盖时 (测试 / 预览入口) 按开源版。
final editionProvider = Provider<NeoxEdition>((_) => const OpenEdition());

final accountStatusProvider = Provider<AccountStatus>(
  (ref) => ref.watch(editionProvider).watchAccount(ref),
);

final planModelsProvider = Provider<List<PlanModel>?>(
  (ref) => ref.watch(editionProvider).watchPlanModels(ref),
);

final desktopPresenceProvider = Provider<DesktopPresenceView>(
  (ref) => ref.watch(editionProvider).watchPresence(ref),
);

final cloudEntriesVisibleProvider = Provider<bool>(
  (ref) => ref.watch(editionProvider).watchCloudEntriesVisible(ref),
);

final cloudTakeoverVisibleProvider = Provider<bool>(
  (ref) => ref.watch(editionProvider).watchCloudTakeoverVisible(ref),
);

/// autoDispose: 商业实现 watch 的账号概览本身是 autoDispose 的 —— 离开设置页就该释放,
/// 这里常驻会把它一起钉住。
final accountDesktopCountProvider = Provider.autoDispose<int>(
  (ref) => ref.watch(editionProvider).watchAccountDesktopCount(ref),
);
