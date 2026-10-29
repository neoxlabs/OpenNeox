/// connection_strategy.dart — 手机↔电脑选路的**纯决策**, 不碰 socket, 可单测.
///
/// 2026-09-17 从 ws_client_provider.dart 里拆出来。用户原话:
///   "我都是移动网络了，你还去测试同 WiFi 连接，这不是扯淡吗？
///    经常远程连接不上, 连接不够快不够好用"
///
/// 当时的真因不是某个超时值, 而是**选路根本不看手机在什么网络上**:
///   - 严格 LAN 优先, LAN 和远程从不并行: 蜂窝网络下先 TCP 探测 → mDNS →
///     LAN 快速重试 3 轮 → 远程前再等 700ms → 再 mDNS 验一次, 才去拨远程,
///     自动重连要白丢 ≈4.5s;
///   - 远程失败跟 LAN 共用一个快速重试计数, LAN 早把 3 次用光了 → 远程一失败
///     直接掉进 20s 慢速档, 状态栏还写着「同 Wi-Fi 暂时没有找到这台电脑」;
///   - 网络变化事件不分 wifi/蜂窝/断网, 一律把**正在用的远程连接拆掉**重来。
///
/// 这里把"该走哪条路 / 网络变了该干什么 / 失败后隔多久再试 / 状态栏说什么"
/// 做成纯函数, 由 ws_client_provider 执行。测试见
/// test/connection_strategy_test.dart 与 test/reconnect_backoff_test.dart。
library;

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 手机此刻所在网络的**类型** (不是"能不能连上电脑")。
enum NetworkKind {
  /// 还没拿到 / 平台给了看不懂的组合 (只有 vpn / bluetooth / other)。
  /// 看不出底下是不是 Wi-Fi —— 两条路都试, 不做假设。
  unknown,

  /// 没有任何网络接口。
  offline,

  /// 只有蜂窝 (含 "vpn 跑在蜂窝上")。**同 Wi-Fi 直连在物理上不可能**。
  cellularOnly,

  /// 有 Wi-Fi 或有线 —— 电脑可能跟手机在同一个局域网里。
  localCapable,
}

NetworkKind classifyConnectivity(List<ConnectivityResult> results) {
  if (results.isEmpty) return NetworkKind.offline;
  if (results.contains(ConnectivityResult.wifi) ||
      results.contains(ConnectivityResult.ethernet)) {
    return NetworkKind.localCapable;
  }
  if (results.contains(ConnectivityResult.mobile)) {
    return NetworkKind.cellularOnly;
  }
  if (results.every((r) => r == ConnectivityResult.none)) {
    return NetworkKind.offline;
  }
  return NetworkKind.unknown;
}

/// 这一轮连接怎么走。
enum RouteKind {
  /// 手机没网 —— 什么都不拨, 等网络回来 (网络变化事件会再触发)。
  waitForNetwork,

  /// 只拨远程中继 (蜂窝网络 / 这台电脑只有远程密钥)。
  relayOnly,

  /// 只试同 Wi-Fi 直连 (远程不可用, 原因必须写进状态栏)。
  lanOnly,

  /// Wi-Fi 下两条路赛跑: 先起 LAN, [kRelayHeadStart] 内没验证通就同时起远程,
  /// 谁先**验证通过**用谁, 另一条干净关掉。
  raceLanFirst,

  /// 两条路都不可用 (没配对密钥 / 蜂窝下没登录 …), 原因给用户看。
  unavailable,
}

/// LAN 的"先跑一步"。同 Wi-Fi 下 LAN 探测 (TCP 140ms) 一般 <100ms 就有结果,
/// 300ms 还没通说明大概率不在同一个网, 这时再干等就是白丢时间。
const Duration kRelayHeadStart = Duration(milliseconds: 300);

/// 远程中继握手后等电脑回 `session.list` 的时长。
///
/// 原来是 2.8s —— 那是"远程只是 LAN 失败后的兜底, 要快点失败回去试 LAN"时代的
/// 取值。现在远程是蜂窝下唯一的路、Wi-Fi 下跟 LAN 并行, 把一台其实在线、只是
/// 经中继多绕了一跳 (电脑冷启动首个 RPC 要 >1s) 的电脑判死, 只会让用户看到
/// "远程连不上"。5s = LAN 验证的 3s (ws_client.dart `_kPeerVerifyTimeout`)
/// 再加中继两跳 (手机→中继→电脑) 的蜂窝往返余量。
const Duration kRelayPeerVerifyTimeout = Duration(seconds: 5);

/// 连接路径上"顺手刷新 token / 同步设备列表"最多占用的时间。超时就先用手上
/// 的东西连, 后台那一枪照样跑完 (refresh 本身是单飞, 结果会落回 auth 状态)。
const Duration kConnectSideTaskCap = Duration(seconds: 3);

/// 一次远程连接最坏要多久才有定论:
///   token 刷新封顶 3s + WebSocket.connect 超时 6s + 对端验证 5s + 赛跑让先 0.3s。
/// connectToBestAvailableDesktop 每台电脑的等待必须 ≥ 这个值, 否则会把一条
/// 正在验证、马上就通的远程连接当成失败, 转头去连下一台把它顶掉。
const Duration kRelayWorstCaseSettle = Duration(milliseconds: 14300);

/// 「当前电脑」断开后还粘多久 (见 WsClientController.currentDesktopId)。
/// 覆盖出门换网、地铁里断几分钟这类场景; 再久就不该认定用户还在用那台 ——
/// 一台关了机的电脑永远占着"当前"正是 desktop_ranking.dart 顶上那次 P0。
const Duration kCurrentDesktopStickyWindow = Duration(minutes: 30);

class RoutePlan {
  const RoutePlan(this.kind, {this.reason, this.relayUnavailableReason});

  final RouteKind kind;

  /// [RouteKind.unavailable] 时给用户看的原因。
  final String? reason;

  /// [RouteKind.lanOnly] 时"为什么没走远程"—— 降级必须看得见, 不许静默。
  final String? relayUnavailableReason;

  bool get usesLan =>
      kind == RouteKind.lanOnly || kind == RouteKind.raceLanFirst;
  bool get usesRelay =>
      kind == RouteKind.relayOnly || kind == RouteKind.raceLanFirst;

  @override
  String toString() =>
      'RoutePlan(${kind.name}${reason == null ? '' : ', $reason'}'
      '${relayUnavailableReason == null ? '' : ', relay×: $relayUnavailableReason'})';
}

/// 远程为什么不能用 —— null 表示能用。
///
/// [peerRelayOnline] 是**服务端**告诉我们的事实: 那台电脑此刻有没有活着的中继长连接
/// (presence 快照/推送里的 `capabilities.relay_online`)。null = 不知道 (老服务端 /
/// 查询失败), 这时按"能用"处理, 保持原行为。
///
/// 为什么必须有这一条 (2026-09-17 线上定位): 电脑的 presence 心跳跟中继是两条独立
/// 连接。Windows 那台心跳一直在 (state=online), 但中继连接被踢掉后 24 小时没再拨号。
/// 手机只看 online 就去连, 连上中继、发第一个 RPC、被告知对端离线、断开、退避重连 ——
/// 实测每轮只活 0.6 秒, 无限循环。用户判词: "远程连接是废物"。
String? relayUnavailableReason({
  required bool hasRelayKey,
  required bool loggedIn,
  required bool autoFallbackEnabled,
  bool? peerRelayOnline,
}) {
  if (!loggedIn) return tr('登录后才能远程连接');
  if (!hasRelayKey) return tr('这台电脑还没有远程连接密钥，请重新配对');
  if (!autoFallbackEnabled) return tr('远程连接已在设置中关闭');
  if (peerRelayOnline == false) return tr('电脑没接入远程通道');
  return null;
}

RoutePlan planRoute({
  required NetworkKind network,
  required bool hasLanToken,
  required bool hasRelayKey,
  required bool loggedIn,
  required bool autoFallbackEnabled,
  bool? peerRelayOnline,
}) {
  if (network == NetworkKind.offline) {
    return const RoutePlan(RouteKind.waitForNetwork);
  }
  final relayWhyNot = relayUnavailableReason(
    hasRelayKey: hasRelayKey,
    loggedIn: loggedIn,
    autoFallbackEnabled: autoFallbackEnabled,
    peerRelayOnline: peerRelayOnline,
  );
  final relayOk = relayWhyNot == null;

  if (network == NetworkKind.cellularOnly) {
    /* 蜂窝下 LAN 物理上不可能 —— 不探测、不扫 mDNS、不等。 */
    if (relayOk) return const RoutePlan(RouteKind.relayOnly);
    return RoutePlan(
      RouteKind.unavailable,
      reason: tr('当前是移动网络，只能远程连接：$relayWhyNot'),
    );
  }

  /* localCapable / unknown */
  if (hasLanToken && relayOk) return const RoutePlan(RouteKind.raceLanFirst);
  if (hasLanToken) {
    return RoutePlan(RouteKind.lanOnly, relayUnavailableReason: relayWhyNot);
  }
  if (relayOk) return const RoutePlan(RouteKind.relayOnly);
  /* 没有 LAN token 且远程不可用 —— relayWhyNot 此处必非 null */
  return RoutePlan(RouteKind.unavailable, reason: relayWhyNot);
}

/// 当前**已连上**的那条路 (没连上 = none)。
enum ActivePath { none, lan, relay }

enum NetworkChangeAction {
  /// 重复事件, 什么都不做。
  ignore,

  /// 断网: 不拆现有连接 (心跳会说真话), 不拨号, 等网络回来。
  waitOffline,

  /// 保持当前连接, 发一个轻量 RPC 验一下; 验不过才重连。
  verifyCurrent,

  /// 保持远程, 验一下; 同时后台试 LAN, **LAN 验证通过才切**。
  keepRelayTryLan,

  /// 没连着 / 当前那条路随网络一起没了 —— 按新网络重新选路。
  reconnect,
}

NetworkChangeAction decideOnNetworkChange({
  required NetworkKind from,
  required NetworkKind to,
  required ActivePath connectedVia,
}) {
  if (to == NetworkKind.offline) return NetworkChangeAction.waitOffline;
  switch (connectedVia) {
    case ActivePath.none:
      return NetworkChangeAction.reconnect;
    case ActivePath.relay:
      /* 远程连接不依赖手机在哪个网 —— Wi-Fi→蜂窝时它是唯一活着的路, 拆掉它
       * 就是"切个网就断一次"的来源。 */
      if (to == NetworkKind.cellularOnly) {
        return from == NetworkKind.cellularOnly
            ? NetworkChangeAction.ignore
            : NetworkChangeAction.verifyCurrent;
      }
      return NetworkChangeAction.keepRelayTryLan;
    case ActivePath.lan:
      /* 没有 Wi-Fi 了, 局域网连接必死, 不用等心跳超时。 */
      if (to == NetworkKind.cellularOnly) return NetworkChangeAction.reconnect;
      /* 同为 Wi-Fi 也可能换了 SSID / IP —— ping 一下就知道。 */
      return NetworkChangeAction.verifyCurrent;
  }
}

/// 快速档次数 (之后进慢速档)。
const int kReconnectFastAttempts = 3;

/// 慢速档间隔 — 一直连不上就越退越远, 但**永不放弃**.
///
/// 2026-08-11 模拟器实录: 对着一台关机的电脑, 日志打出 `已试 1255 次, 每 20s 重试`。
/// 每一轮是 mDNS 扫描 + LAN 直连 + 云中继三件事, 手机的射频被永久地每 20 秒
/// 拉起来一次 —— 用户看不见, 只看得见耗电。
///
/// 为什么不是"试 N 次就停": 原版试 3 次就永久搁置, 电脑恢复后手机也不回来。
/// 所以这里只拉长间隔, 不引入终止态。真正的"立刻醒过来"由这几件事负责:
///   网络变化 / 回前台 / presence 推送 desktop 上线 / 用户手动点连接。
const Duration _kSlowReconnectInterval = Duration(seconds: 20);
const Duration _kSlowReconnectInterval2 = Duration(seconds: 60);
const Duration _kSlowReconnectInterval3 = Duration(minutes: 5);

/// 进入慢速档后, 第几次开始降到 60s / 5min.
/// 20s×10 ≈ 3.3min, 再 60s×10 ≈ 10min, 之后一律 5 分钟一次。
const int _kSlowTierStep2After = 10;
const int _kSlowTierStep3After = 20;

/// 慢速档的实际间隔 — 越试越远, 且后台一律用最远那档.
///
/// [attempt] 是整轮失败计数 (含快速档那几次), 所以先减掉快速档次数
/// 才是"进慢速档之后的第几轮"。
Duration slowReconnectInterval({
  required int attempt,
  required bool foreground,
}) {
  if (!foreground) return _kSlowReconnectInterval3;
  final slowRound = attempt - kReconnectFastAttempts;
  if (slowRound > _kSlowTierStep3After) return _kSlowReconnectInterval3;
  if (slowRound > _kSlowTierStep2After) return _kSlowReconnectInterval2;
  return _kSlowReconnectInterval;
}

/// 第 [attempt] 轮失败之后隔多久再试。
///
/// 2026-09-17: 远程有**自己的**快速档 1s/2s/4s。原来远程失败跟 LAN 的
/// 120/320/650ms 共用一个计数, 而 LAN 那 3 次在拨远程之前就被 defer 用光了,
/// 于是远程失败一次就直接 20s —— 蜂窝下一次抖动就要干等 20 秒。
///
/// LAN-only (远程不可用) 仍用亚秒级快速档: 刚切网 mDNS 慢半拍, 值得马上再试。
Duration reconnectDelay({
  required int attempt,
  required bool foreground,
  required bool relayInvolved,
}) {
  if (attempt > kReconnectFastAttempts) {
    return slowReconnectInterval(attempt: attempt, foreground: foreground);
  }
  if (relayInvolved) {
    if (attempt <= 1) return const Duration(seconds: 1);
    if (attempt == 2) return const Duration(seconds: 2);
    return const Duration(seconds: 4);
  }
  if (attempt <= 1) return const Duration(milliseconds: 120);
  if (attempt == 2) return const Duration(milliseconds: 320);
  return const Duration(milliseconds: 650);
}

String _retryIn(Duration d) {
  if (d < const Duration(seconds: 1)) return tr('马上重试');
  if (d.inSeconds < 60) return tr('${d.inSeconds} 秒后重试');
  return tr('${d.inMinutes} 分钟后重试');
}

/// 正在连接时状态栏说什么 —— 必须是**此刻真在做的事**, 且一眼读完。
///
/// 2026-09-18: 原来会写"正在连接（同 Wi-Fi 直连和远程同时尝试）"这种。用户原话
/// "链接的提示语 废话太多 解释一堆" —— 走哪条路是我们的实现细节, 用户只需要知道
/// 在连、连上了、还是连不上 (连不上必须给出理由)。
String connectingStatusMessage(RouteKind route, NetworkKind network) {
  switch (route) {
    case RouteKind.relayOnly:
      return tr('正在远程连接');
    case RouteKind.raceLanFirst:
      return tr('正在连接');
    case RouteKind.lanOnly:
      return tr('正在同 Wi-Fi 连接');
    case RouteKind.waitForNetwork:
      return tr('网络已断开');
    case RouteKind.unavailable:
      return tr('无法连接');
  }
}

/// 失败原因短到能跟在一行里吗 —— 长的原因让状态栏换行, 行高就跟着炸.
bool _fitsInline(String? detail) =>
    detail != null && detail.isNotEmpty && detail.runes.length <= 12;

/// 一轮失败后状态栏说什么。[detail] 是底层失败原因 (如「电脑已离线」)。
///
/// [dropped] = 本来连着、半路断了 (不是"这一轮没连上"), 不说"没连上"。
String retryStatusMessage({
  required RoutePlan plan,
  required Duration nextIn,
  String? detail,
  bool dropped = false,
}) {
  final tail = _retryIn(nextIn);
  final d = detail?.trim();
  if (dropped) {
    return d == '连接已断开' || d == tr('连接已断开') || !_fitsInline(d)
        ? tr('已断开 · $tail')
        : tr('已断开（$d） · $tail');
  }
  /* 理由要给, 但只给一条、且短 —— 长的失败原文 (堆栈式的 detail) 放日志, 不放状态栏 */
  final why = _fitsInline(d) ? '（$d）' : '';
  switch (plan.kind) {
    case RouteKind.relayOnly:
      return tr('远程没连上$why · $tail');
    case RouteKind.raceLanFirst:
      return tr('没连上$why · $tail');
    case RouteKind.lanOnly:
      /* 为什么没走远程仍然要说 (用户要理由), 但不再把两条路的原因叠在一行 */
      final relay = plan.relayUnavailableReason;
      return relay == null
          ? tr('同 Wi-Fi 没连上$why · $tail')
          : tr('同 Wi-Fi 没连上 · $relay');
    case RouteKind.waitForNetwork:
      return tr('网络已断开');
    case RouteKind.unavailable:
      return plan.reason ?? tr('无法连接');
  }
}
