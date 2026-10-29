/// ws_client_provider.dart — Riverpod 接通 [WsClient] 到 UI.
///
/// 替换 Phase 1.B 的 stub. Phase 1.C 真实做 Mode A LAN P2P:
///   - 从 drift `paired_desktops` 读 device_token / host / port
///   - 起 [WsClient] 连 ws://{host}:{port}/api/v1/socket
///   - 收到 session.snapshot / session.event 落 drift (session_mirror / session_events)
///   - UI 通过 [wsClientStateProvider] watch 连接状态
///   - UI 通过 [WsClientController.sendInput] 发输入
///
/// Mode B (Cloud Relay) 留 Phase 1.D. 这里只实现 LAN 直连.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io' show Socket;

import 'dart:typed_data';

import 'package:drift/drift.dart' show Value;
import 'package:flutter/foundation.dart' show debugPrint, kDebugMode;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../features/timeline/state/timeline_state.dart';
import '../byok/byok_models.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import '../device/phone_identity.dart';
import '../edition/edition.dart';
import '../execution/cloud_agent_access.dart';
import '../execution/run_target.dart';
import '../execution/run_target_provider.dart';
import '../session_routing/desktop_ranking.dart';
import '../notifications/agent_notifier.dart';
import '../discovery/mdns_scanner.dart';
import '../notifications/local_notifications.dart';
import '../storage/database.dart';
import '../storage/paired_desktop_kind.dart';
import '../../features/home/state/current_session_provider.dart';
import 'auto_fallback_pref.dart';
import 'connection_strategy.dart';
import 'desktop_run_status.dart';
import 'history_load_status.dart';
import 'session_context_provider.dart';
import 'json_rpc.dart';
import 'lan_endpoint.dart';
import 'lan_endpoint_hints_provider.dart';
import 'projector_transport.dart';
import 'relay_channel.dart';
import 'remote_link.dart';
import 'self_hosted_relay.dart';
import 'cli_endpoint_id.dart';
import '../crypto/x25519_hkdf.dart';
import '../attachments/local_attachment_store.dart';
import 'attachment_upload.dart';
import 'keep_alive_service.dart';
import 'stream_buffer_provider.dart';
import 'ws_client.dart';
import 'package:neox_app/core/i18n/tr.dart';
import '../../shared/theme/theme_mode_provider.dart' show sharedPreferencesProvider;
import '../../features/pilot/phone_exec.dart';

/// 协议层 mode
enum WsTransport { none, lan, cloudRelay, cloudAgent }

enum WsConnectionState { disconnected, connecting, connected, error }

/// 谁触发了连接。自动连接要更保守，避免 mDNS 慢半拍时先跳远程再回同 Wi-Fi。
enum DesktopConnectTrigger { user, automatic }

const _kLanRediscoverTimeout = Duration(milliseconds: 450);
const _kLanTcpProbeTimeout = Duration(milliseconds: 140);

/// 网络变化事件合并窗口 —— 切网瞬间平台会连发 wifi→none→mobile 好几条,
/// 按**最后一条**行动。原来是"1.5s 内只认第一条", 第一条往往是中间态 none,
/// 真正的终态反而被丢掉 (2026-09-17)。
const _kConnectivityCoalesce = Duration(milliseconds: 400);

/// 网络切换后验证当前连接的 RPC 超时。蜂窝往返慢, 给宽一点, 别把活连接判死。
const _kVerifyTimeoutLocal = Duration(seconds: 3);
const _kVerifyTimeoutCellular = Duration(seconds: 5);

/// connecting 看门狗 — 卡在"连接中"超过这个时长就翻 error + 再踢一次重连, 避免无限转圈。
const _kConnectingWatchdogTimeout = Duration(seconds: 18);

String _formatDelay(Duration d) =>
    d.inMilliseconds % 1000 == 0 ? '${d.inSeconds}s' : '${d.inMilliseconds}ms';

/// 云端说"在线"、但我们此刻**连不上**的电脑。
///
/// 2026-09-03 加。设备列表原来只显示配对状态, 三台电脑长得一模一样, 用户看不出
/// 哪台能连 —— 真机上手机死磕一台连不上的 Windows, 旁边的 Mac 开着能连, 界面上
/// 两台都写"已配对"。有了这个集合, 那台就显示黄色的「在线 · 连不上」。
///
/// 它只是**呈现**用的; 连不上这件事本身由 connectToBestAvailableDesktop (换一台)
/// 和 _tryRepairPairing (自动重新配对) 去正面解决 —— 标识不是用来掩盖问题的。
final unreachableDesktopsProvider = StateProvider<Set<String>>(
  (ref) => const <String>{},
);

/// 当前连接状态 + 上次活跃 Desktop.
///
/// 注: `snapshotSessions` 字段已删 — 没有 widget 在外面 watch 它 (sessions_page
/// 直接读 drift session_mirror), 留着只是冗余的 state mutation, 还会触发
/// Riverpod listener race condition (defunct ConsumerStatefulElement 被通知 →
/// markNeedsBuild 撞断言). drift 是单一数据源。
class WsClientState {
  const WsClientState({
    required this.connection,
    required this.transport,
    this.activeDesktopDeviceId,
    this.errorMessage,
    this.activeTimelineSessionId,
    this.mirrorEpoch = 0,
  });

  final WsConnectionState connection;
  final WsTransport transport;
  final String? activeDesktopDeviceId;
  final String? errorMessage;

  /// 当前 timeline 页打开的 sessionId, WS 重连后用它自动 re-subscribe.
  /// null 表示不在 timeline 页.
  final String? activeTimelineSessionId;

  /// 镜像策略 cache 变更计数 — UI 顶栏镜像 icon 依赖它刷新.
  final int mirrorEpoch;

  static const initial = WsClientState(
    connection: WsConnectionState.disconnected,
    transport: WsTransport.none,
  );

  WsClientState copyWith({
    WsConnectionState? connection,
    WsTransport? transport,
    String? activeDesktopDeviceId,
    String? errorMessage,
    Object? activeTimelineSessionId = _sentinel,
    int? mirrorEpoch,
  }) {
    return WsClientState(
      connection: connection ?? this.connection,
      transport: transport ?? this.transport,
      activeDesktopDeviceId:
          activeDesktopDeviceId ?? this.activeDesktopDeviceId,
      errorMessage: errorMessage,
      activeTimelineSessionId: identical(activeTimelineSessionId, _sentinel)
          ? this.activeTimelineSessionId
          : activeTimelineSessionId as String?,
      mirrorEpoch: mirrorEpoch ?? this.mirrorEpoch,
    );
  }
}

const _sentinel = Object();

/// 一页历史的结果 —— **失败和"空"必须是两个不同的值**.
///
/// 原来这里返回 `({int written, int minSeqSeen})`, 失败也是 `written: 0`。
/// 于是一次超时和"这个会话真的没有更早的消息"在调用方看来完全一样:
/// 多页回填 break、向上翻页永久关掉、界面写「还没有消息」, 一路无声。
/// 2026-09-18 用户报「历史会话 无法传输加载」的那一类症状就是这么来的。
class HistoryPage {
  const HistoryPage({required this.written, required this.minSeqSeen})
    : failed = false;
  const HistoryPage.failed() : written = 0, minSeqSeen = 0, failed = true;

  /// 本页写进本地库的条数 (幂等覆盖, 所以可能小于回包条数).
  final int written;

  /// 本页见到的最小 seq; 0 = 本页是空的. 往回翻页的游标.
  final int minSeqSeen;

  /// 这一页**没拿到** —— 跟 written == 0 (拿到了但是空的) 不是一回事.
  final bool failed;

  /// 确实到头了: 拿到了, 而且是空的.
  bool get reachedEnd => !failed && (written == 0 || minSeqSeen <= 0);
}

class SnapshotSession {
  const SnapshotSession({
    required this.id,
    this.title,
    this.lastMessageAt,
    this.workspaceName,
    this.mirrorPolicy,
    this.kind = 'chat',
    this.parentSessionId,
  });
  final String id;
  final String? title;
  final int? lastMessageAt;
  final String? workspaceName;

  /// M3 — 当前镜像策略 (always/manual/never). 从 server session.list mirror_policy 字段拿.
  final String? mirrorPolicy;

  /// 'chat' | 'image' — image = 桌面图片工作台会话, mobile 降级提示.
  final String kind;

  /// 非 null = 这是某个父会话派出的 sub-agent 子会话 (桌面 sessions.parent_session_id).
  /// 抽屉里嵌套缩进显示, 不占顶层列表位置.
  final String? parentSessionId;

  static SnapshotSession fromJson(Map<String, dynamic> json) {
    return SnapshotSession(
      id: json['id'] as String? ?? '',
      title: json['title'] as String?,
      lastMessageAt:
          (json['last_message_at'] as int?) ??
          (json['updated_at'] as int?) ??
          (json['created_at'] as int?),
      workspaceName: json['workspace_name'] as String?,
      mirrorPolicy: json['mirror_policy'] as String?,
      kind: (json['kind'] as String?) == 'image' ? 'image' : 'chat',
      parentSessionId: switch (json['parent_session_id'] ??
          json['parentSessionId']) {
        final String v when v.isNotEmpty => v,
        _ => null,
      },
    );
  }
}

/// 单条 session 完整 meta — 进 timeline 后 fetch 用于 status bar.
class SessionInfo {
  const SessionInfo({
    required this.id,
    this.title,
    this.workspaceName,
    this.workspacePath,
    this.modelId,
    this.currentContextTokens = 0,
  });
  final String id;
  final String? title;
  final String? workspaceName;
  final String? workspacePath;
  final String? modelId;

  /// desktop sessionStore.contextUsed 透传 — 进 timeline 时 seed context chip,
  /// 不再等下一轮 metrics 才有数。0 表示从未跑过 turn.
  final int currentContextTokens;

  SessionInfo copyWith({String? modelId}) => SessionInfo(
    id: id,
    title: title,
    workspaceName: workspaceName,
    workspacePath: workspacePath,
    modelId: modelId ?? this.modelId,
    currentContextTokens: currentContextTokens,
  );

  static SessionInfo fromJson(Map<String, dynamic> json) {
    return SessionInfo(
      id: json['id'] as String? ?? '',
      title: json['title'] as String?,
      workspaceName: json['workspace_name'] as String?,
      workspacePath: json['workspace_path'] as String?,
      modelId: json['model_id'] as String?,
      currentContextTokens: (json['current_context_tokens'] is num)
          ? (json['current_context_tokens'] as num).toInt()
          : 0,
    );
  }
}

class WorkspaceInfo {
  const WorkspaceInfo({
    required this.path,
    required this.name,
    this.recentSessionId,
  });
  final String path;
  final String name;

  /// 最近活跃 session — 切换 workspace 时优先跳到这条而不是新建.
  final String? recentSessionId;

  static WorkspaceInfo fromJson(Map<String, dynamic> j) => WorkspaceInfo(
    path: (j['workspace_path'] as String?) ?? '',
    name: (j['workspace_name'] as String?) ?? '',
    recentSessionId: j['recent_session_id'] as String?,
  );
}

/// 电脑上某个目录的子目录清单 —— 手机选工作区用。
class DirEntry {
  const DirEntry({
    required this.name,
    required this.path,
    required this.isRepo,
  });
  final String name;
  final String path;

  /// 是不是 git 仓库 —— 用户找的多半是项目, 有这个标记一眼认得出。
  final bool isRepo;

  static DirEntry fromJson(Map<String, dynamic> j) => DirEntry(
    name: (j['name'] as String?) ?? '',
    path: (j['path'] as String?) ?? '',
    isRepo: j['is_repo'] == true,
  );
}

class DirListing {
  const DirListing({
    required this.path,
    required this.parent,
    required this.home,
    required this.entries,
  });
  final String path;

  /// null = 已经在主目录, 不能再往上 (桌面侧的边界)。
  final String? parent;
  final String home;
  final List<DirEntry> entries;

  static DirListing fromJson(Map<String, dynamic> j) => DirListing(
    path: (j['path'] as String?) ?? '',
    parent: j['parent'] as String?,
    home: (j['home'] as String?) ?? '',
    entries:
        (j['entries'] as List?)
            ?.whereType<Map<String, dynamic>>()
            .map(DirEntry.fromJson)
            .toList() ??
        const [],
  );
}

class ModelInfo {
  const ModelInfo({
    required this.id,
    required this.name,
    this.provider,
    this.providerId,
    this.contextWindow,
    this.supportsVision = false,
    this.supportsThinking = false,
    this.isSubscription = false,
    this.relativeCost,
    this.payAsYouGo = false,
  });
  final String id;
  final String name;

  /// 按量模型 (桌面「按量模型」开关打开时才发): 扣平台余额, 选择器里单独成组
  final bool payAsYouGo;
  final String? provider;
  final String? providerId;
  final int? contextWindow;
  final bool supportsVision;
  final bool supportsThinking;

  /// true = NeoxCloud 订阅 (Neox 计费), false = BYOK (用户自配 key, Desktop 直连)
  final bool isSubscription;

  /// 额度消耗速度 (基准模型 = 1.0, 已含倍率)。旧版本桌面不发这个字段 → null → 不画消耗条。
  final double? relativeCost;

  static ModelInfo fromJson(Map<String, dynamic> json) {
    return ModelInfo(
      id: json['id'] as String? ?? '',
      name: json['name'] as String? ?? '',
      provider: json['provider'] as String?,
      providerId: json['provider_id'] as String?,
      contextWindow: json['context_window'] as int?,
      supportsVision: json['supports_vision'] == true,
      supportsThinking: json['supports_thinking'] == true,
      isSubscription: json['is_subscription'] == true,
      relativeCost: (json['relative_cost'] as num?)?.toDouble(),
      payAsYouGo: json['pay_as_you_go'] == true,
    );
  }
}

/// Desktop `providers.export` 结果 — 已映射为手机 BYOK 形状.
class DesktopProvidersExport {
  const DesktopProvidersExport({
    required this.providers,
    this.skippedCount = 0,
    this.deviceName,
  });

  final List<ByokProviderConfig> providers;
  final int skippedCount;
  final String? deviceName;

  static DesktopProvidersExport fromJson(Map<String, dynamic> json) {
    final raw = json['providers'];
    final list = <ByokProviderConfig>[];
    if (raw is List) {
      for (final item in raw) {
        if (item is! Map) continue;
        final deskId = item['desktop_id'];
        final key = item['api_key'];
        if (deskId is! String ||
            deskId.isEmpty ||
            key is! String ||
            key.isEmpty) {
          continue;
        }
        final models = <String>[
          if (item['models'] is List)
            ...(item['models'] as List).whereType<String>().where(
              (m) => m.isNotEmpty,
            ),
        ];
        final headers = <String, String>{};
        if (item['extra_headers'] is Map) {
          (item['extra_headers'] as Map).forEach((k, v) {
            if (k is String && v is String) headers[k] = v;
          });
        }
        list.add(
          ByokProviderConfig(
            id: 'pending',
            name: (item['name'] as String?) ?? deskId,
            protocol: byokProtocolFromWire(item['protocol'] as String?),
            baseUrl: (item['base_url'] as String?) ?? '',
            apiKey: key,
            models: models,
            extraHeaders: headers,
            desktopSourceId: deskId,
          ),
        );
      }
    }
    final skipped = json['skipped'];
    return DesktopProvidersExport(
      providers: list,
      skippedCount: skipped is List ? skipped.length : 0,
      deviceName: json['device_name'] as String?,
    );
  }
}

class WsClientController extends StateNotifier<WsClientState> {
  WsClientController(this._ref) : super(WsClientState.initial) {
    _initConnectivityListener();
    /* Timeline projector quiet-timeout → same attach path as enter/reconnect */
    bindProjectorAttachOrCatchUp(attachOrCatchUp);
    addListener(_trackCurrentDesktop, fireImmediately: false);
  }

  /* ── 「当前电脑」(2026-09-26: Wi-Fi 切到远程时连去了另一台) ──────────────────
   *
   * 出门那一下 Wi-Fi 断了, 局域网连接跟着断, 状态变成"未连接"。之后回前台 / 打开会话 /
   * 发消息都要补连, 而补连挑目标时只认"此刻真连着"的那台 —— 没有, 于是按服务端心跳
   * 重新排, 另一台电脑心跳更新鲜就排到前面, 手机悄悄连去了那台。刚才还在用的那台
   * 明明就记在 activeDesktopDeviceId 里。
   *
   * 但也不能无限粘: desktop_ranking.dart 顶上记着那次 P0 —— 一台早就关机的老电脑
   * 一直占着"当前", 手机对着它永远重连。所以粘性有窗口: 正连着, 或断开不到
   * [kCurrentDesktopStickyWindow]。过了窗口还没回来, 就按原来的排序。 */
  String? _lostDesktopId;
  DateTime? _lostDesktopAt;
  bool _wasConnected = false;

  void _trackCurrentDesktop(WsClientState s) {
    final connected = s.connection == WsConnectionState.connected &&
        s.transport != WsTransport.cloudAgent &&
        s.activeDesktopDeviceId != null;
    if (connected) {
      _lostDesktopId = s.activeDesktopDeviceId;
      _lostDesktopAt = null;
      /* 记住这台, 下次冷启动先连它 (2026-10-12 用户: 每次进来就应该是上一次的电脑连接和会话) */
      if (_lastUsedDesktopId != s.activeDesktopDeviceId) {
        _lastUsedDesktopId = s.activeDesktopDeviceId;
        unawaited(_ref.read(sharedPreferencesProvider).setString(_kLastDesktopKey, s.activeDesktopDeviceId!));
      }
    } else if (_wasConnected && _lostDesktopId != null) {
      _lostDesktopAt = DateTime.now();
    }
    _wasConnected = connected;
  }

  /// 当前这条链路是 LAN 直连还是云中转 —— 分块大小时要用
  /// (云中转一封包就是原始字节的 16/9 倍, 见 remote_image.dart)。
  WsTransport get transport => state.transport;

  /// 远程且已走 v2 二进制帧: 一块可以要到 1MB, 不再受云中转单帧上限
  bool get relayFramesActive =>
      (transport == WsTransport.cloudRelay || transport == WsTransport.cloudAgent) &&
      (_cloudClient?.framesActive ?? false);

  /// 刚才在用的那台电脑 —— 正连着的, 或断开不到 [kCurrentDesktopStickyWindow] 的。
  /// 自动补连 / 发消息选电脑时它排最前 (压过首选和客观排序): 网络变了不等于用户想换电脑。
  String? get currentDesktopId {
    if (state.connection == WsConnectionState.connected &&
        state.transport != WsTransport.cloudAgent &&
        state.activeDesktopDeviceId != null) {
      return state.activeDesktopDeviceId;
    }
    final id = _lostDesktopId;
    final at = _lostDesktopAt;
    if (id != null && at != null && DateTime.now().difference(at) <= kCurrentDesktopStickyWindow) return id;
    /* 冷启动 / 断开很久: 上次用的那台 —— 只在服务端说它在线 (或在线通道还没通、不知道) 时才排第一,
     * 关了机的老电脑不能一直占着第一个 (desktop_ranking.dart 顶上那次 P0); 连不上也会接着试下一台 */
    final last = _lastUsedDesktopId ??= _ref.read(sharedPreferencesProvider).getString(_kLastDesktopKey);
    if (last == null) return null;
    final presence = _ref.read(desktopPresenceProvider);
    return (!presence.live || presence.isOnline(last)) ? last : null;
  }

  /// 打开一条电脑会话时记下它的电脑 —— 冷启动恢复的是「上次的会话」, 先连的就得是它那台。
  /// 只在连上时才记 (上面) 会和会话对不上: 会话在 Mac 上, 手机最后连过的却是 Windows,
  /// 冷启动连上 Windows → 连接守卫判「已切换电脑」把恢复的会话踢回首页 (2026-10-12 实测)。
  void rememberDesktop(String deviceId) {
    if (deviceId.isEmpty || _lastUsedDesktopId == deviceId) return;
    _lastUsedDesktopId = deviceId;
    unawaited(_ref.read(sharedPreferencesProvider).setString(_kLastDesktopKey, deviceId));
  }

  static const _kLastDesktopKey = 'neox_last_desktop_v1';
  String? _lastUsedDesktopId;

  final Ref _ref;
  WsClient? _client;
  StreamSubscription<WsEvent>? _eventsSub;

  /* 2026-06-24: session.event 入口去重 (LAN+cloud 双 transport 推同事件场景).
   *   key: sessionId|kind|ts|payload-hash[0:8].  value: ts when first routed.
   *   5 秒后自动 evict (在 routing 入口 sweep). */
  final Map<String, int> _eventDedupCache = <String, int>{};

  String? _eventDedupKey(
    String sessionId,
    String kind,
    dynamic ts,
    dynamic payload,
  ) {
    /* 2026-06-24: 不再用入口 dedup 治标. 真治本在 authenticated 时 transport mutex
     *   (LAN 通 → kill cloud, cloud 通 → kill LAN), 同一时刻只一条 transport 推事件.
     *   保留 noop _eventDedupKey 当 safety net (返 null 表示不 dedup, 入口 if 不命中). */
    if (ts is! int) return null;
    /* 兜底: 完全相同 transport 偶发重发, 用 sessionId|kind|ts|payload string 做最严匹配. */
    final raw = payload == null ? '' : payload.toString();
    final h = raw.hashCode.toRadixString(16);
    return '$sessionId|$kind|$ts|${h.length > 8 ? h.substring(0, 8) : h}';
  }

  /// M4 Mode B (Cloud Relay) client — 跟 LAN 的 `_client` 并存, 互斥.
  /// 具体实现由发行版提供 (见 [remoteLinkProvider])。
  RelayChannel? _cloudClient;
  StreamSubscription<WsEvent>? _cloudEventsSub;
  Future<void>? _connectToDesktopInFlight;
  String? _connectToDesktopInFlightDeviceId;
  DesktopConnectTrigger _activeConnectTrigger = DesktopConnectTrigger.user;
  Timer? _smartReconnectTimer;
  String? _smartReconnectDeviceId;
  int _smartReconnectAttempt = 0;

  /// 连接尝试的代号 (2026-09-17)。
  ///
  /// 每开始一轮新的连接 / 网络切换放弃旧一轮 / 用户断开, 都 +1。拨号中的
  /// LAN 或远程客户端在"验证通过、准备接管"那一刻要核对代号 —— 不是当前这轮
  /// 就直接 dispose, 绝不碰 state 和监听器。没有它, 赛跑的输家、切网前发出的
  /// 旧拨号, 都能在几秒后回来把 state 改掉, 或者把赢家顶掉。
  int _connectGeneration = 0;

  /// 最近一轮的选路 —— 决定重试节奏 (远程 1/2/4s vs LAN 亚秒) 和状态栏文案。
  RoutePlan? _lastPlan;

  /// 远程连着时后台试 LAN 的那一枪是否在飞 (网络事件重复来不叠加)。
  bool _lanUpgradeInFlight = false;

  /// P0-2: 网络变化监听 (wifi↔蜂窝 / 换 wifi / DHCP 换 IP)。
  StreamSubscription<List<ConnectivityResult>>? _connectivitySub;
  Timer? _connectivityCoalesceTimer;

  /// 手机当前的网络类型。选路第一件事就看它 —— 蜂窝下不碰 LAN。
  NetworkKind _networkKind = NetworkKind.unknown;
  bool _networkKindFromEvent = false;
  Future<void>? _initialConnectivity;

  /// 上一次**据以行动**的网络类型, 用来判 old→new。
  NetworkKind? _lastActedNetworkKind;

  /// P1-3: connecting 看门狗 — 防止永久卡在"连接中"。
  Timer? _connectingWatchdog;
  String? _connectingWatchdogDeviceId;

  /// P0-2 修: 监听网络切换。Codex 原版全无网络变化处理 → 切网后旧 socket 半开,
  /// 没有任何东西触发重连或重新选传输, 是"有时候连不上"的头号成因。
  ///
  /// 2026-09-17: 启动时先 checkConnectivity 拿到初始网络类型 —— 否则冷启动的第一次
  /// 连接不知道自己在蜂窝上, 又会先去试 LAN。
  void _initConnectivityListener() {
    try {
      final connectivity = Connectivity();
      _initialConnectivity = connectivity
          .checkConnectivity()
          .timeout(const Duration(milliseconds: 800))
          .then((results) {
            if (!mounted || _networkKindFromEvent) return;
            _networkKind = classifyConnectivity(results);
            _lastActedNetworkKind = _networkKind;
            debugPrint('[ws_provider] 初始网络类型: ${_networkKind.name} $results');
            /* 只做"蜂窝下停掉"; Wi-Fi 下扫描器仍按需懒启动, 不在启动时白开 */
            if (_networkKind == NetworkKind.cellularOnly ||
                _networkKind == NetworkKind.offline) {
              _syncMdnsWithNetwork(_networkKind);
            }
          })
          .catchError((Object e) {
            debugPrint('[ws_provider] checkConnectivity failed: $e');
          });
      _connectivitySub = connectivity.onConnectivityChanged.listen(
        _onConnectivityChanged,
      );
    } catch (e) {
      debugPrint('[ws_provider] connectivity listener init failed: $e');
    }
  }

  Future<void> _ensureNetworkKindKnown() async {
    final pending = _initialConnectivity;
    if (pending == null) return;
    try {
      await pending.timeout(const Duration(milliseconds: 900));
    } catch (_) {
      /* 拿不到就按 unknown 走 —— 两条路都试, 不做假设 */
    }
  }

  void _onConnectivityChanged(List<ConnectivityResult> results) {
    /* 类型立刻更新 (选路要用最新的), 行动合并到最后一条事件再做 */
    _networkKind = classifyConnectivity(results);
    _networkKindFromEvent = true;
    debugPrint('[ws_provider] 网络事件 $results → ${_networkKind.name}');
    _connectivityCoalesceTimer?.cancel();
    _connectivityCoalesceTimer = Timer(_kConnectivityCoalesce, () {
      if (!mounted) return;
      _actOnNetworkChange();
    });
  }

  /// 网络变了之后按 old→new 分类行动 (决策表见 connection_strategy.decideOnNetworkChange)。
  ///
  /// 2026-09-17 之前: 不管变成什么, 一律"重启 mDNS + 立刻重连", 而重连是 LAN 优先 ——
  /// 于是 Wi-Fi→蜂窝时把**唯一还活着的远程连接**拆掉, 再去扫一个不可能存在的局域网。
  void _actOnNetworkChange() {
    final to = _networkKind;
    final from = _lastActedNetworkKind ?? NetworkKind.unknown;
    _lastActedNetworkKind = to;
    _syncMdnsWithNetwork(to);

    final deviceId = state.activeDesktopDeviceId;
    if (deviceId == null) return;
    if (state.transport == WsTransport.cloudAgent) return;

    final connected = state.connection == WsConnectionState.connected;
    final via = !connected
        ? ActivePath.none
        : switch (state.transport) {
            WsTransport.lan => ActivePath.lan,
            WsTransport.cloudRelay => ActivePath.relay,
            _ => ActivePath.none,
          };
    final action = decideOnNetworkChange(from: from, to: to, connectedVia: via);
    debugPrint(
      '[ws_provider] 网络 ${from.name}→${to.name} via=${via.name} → ${action.name} ($deviceId)',
    );
    switch (action) {
      case NetworkChangeAction.ignore:
        return;
      case NetworkChangeAction.waitOffline:
        /* 没网就别按退避节奏空转; 已连着的不拆 (切网中间态常闪一下 none, 心跳会说真话) */
        _resetSmartReconnect();
        if (!connected) {
          _abandonConnectAttempts();
          state = state.copyWith(
            connection: WsConnectionState.disconnected,
            errorMessage: connectingStatusMessage(RouteKind.waitForNetwork, to),
          );
        }
        return;
      case NetworkChangeAction.verifyCurrent:
        unawaited(_verifyActiveTransport(deviceId));
        return;
      case NetworkChangeAction.keepRelayTryLan:
        unawaited(_verifyActiveTransport(deviceId));
        unawaited(_tryLanUpgradeInBackground(deviceId));
        return;
      case NetworkChangeAction.reconnect:
        _resetSmartReconnect();
        _abandonConnectAttempts();
        unawaited(() async {
          /* 连着 LAN 却没了 Wi-Fi: 那条 socket 已经死了, 先拆, 别让它迟到的
           * failed 事件把新一轮的"正在远程连接"改成错误。 */
          if (via == ActivePath.lan) await _teardownClient();
          if (!mounted) return;
          await connectToDesktop(
            deviceId,
            trigger: DesktopConnectTrigger.automatic,
          );
        }());
        return;
    }
  }

  /// mDNS 只在可能有局域网时跑。蜂窝 / 断网下 multicast 什么也扫不到, 只耗电。
  void _syncMdnsWithNetwork(NetworkKind kind) {
    final scanner = _ref.read(mdnsScannerProvider);
    unawaited(() async {
      try {
        await scanner.stop();
        if (kind == NetworkKind.cellularOnly || kind == NetworkKind.offline) {
          return;
        }
        /* 旧接口上绑的 multicast socket 会静默失效, 必须 stop→start 重新绑定 */
        await scanner.start();
      } catch (_) {
        /* best-effort */
      }
    }());
  }

  /// 放弃所有在飞的连接尝试: 它们之后回来的结果一律作废 (见 [_connectGeneration])。
  void _abandonConnectAttempts() {
    _connectGeneration += 1;
    _connectToDesktopInFlight = null;
    _connectToDesktopInFlightDeviceId = null;
  }

  /// 网络变了但当前连接可能还活着 —— 发一个轻量 RPC 验一下, 验不过才重连。
  Future<void> _verifyActiveTransport(String deviceId) async {
    final dynamic c = _activeClient;
    if (c == null) return;
    final timeout = _networkKind == NetworkKind.cellularOnly
        ? _kVerifyTimeoutCellular
        : _kVerifyTimeoutLocal;
    try {
      await c.sendRequest('session.list', const {'limit': 1}, timeout);
      debugPrint('[ws_provider] 网络切换后连接仍可用 ($deviceId)');
    } catch (e) {
      if (!mounted) return;
      /* 验证期间已经换了连接 (比如 LAN 升级成功) —— 这次结果不作数 */
      if (!identical(_activeClient, c)) return;
      if (state.activeDesktopDeviceId != deviceId) return;
      debugPrint('[ws_provider] 网络切换后原连接失效 ($e) → 按新网络重新选路');
      if (identical(c, _client)) {
        await _teardownClient();
      } else {
        await _teardownCloudClient();
      }
      if (!mounted) return;
      state = state.copyWith(
        connection: WsConnectionState.connecting,
        errorMessage: tr('网络切换后原连接已失效 · 正在重新连接'),
      );
      _resetSmartReconnect();
      _abandonConnectAttempts();
      unawaited(
        connectToDesktop(deviceId, trigger: DesktopConnectTrigger.automatic),
      );
    }
  }

  /// 远程连着、手机回到了 Wi-Fi: 后台试 LAN, **验证通过才切**, 否则远程原样保留。
  Future<void> _tryLanUpgradeInBackground(String deviceId) async {
    if (_lanUpgradeInFlight) return;
    if (_networkKind == NetworkKind.cellularOnly ||
        _networkKind == NetworkKind.offline) {
      return;
    }
    _lanUpgradeInFlight = true;
    try {
      final paired = await _ref
          .read(appDatabaseProvider)
          .pairedDesktopsDao
          .findByDeviceId(deviceId);
      if (paired == null || !(paired.deviceToken?.isNotEmpty ?? false)) return;
      final gen = _connectGeneration;
      bool stillOnRelay() =>
          mounted &&
          gen == _connectGeneration &&
          state.activeDesktopDeviceId == deviceId &&
          state.transport == WsTransport.cloudRelay &&
          state.connection == WsConnectionState.connected;
      final guard = _DialGuard(stillOnRelay);
      final dial = await _dialLanVerified(deviceId, paired, guard);
      final client = dial.client;
      if (client == null) {
        debugPrint('[ws_provider] 后台 LAN 升级没成, 保持远程 (${dial.failure})');
        return;
      }
      if (!stillOnRelay() ||
          !_adoptLan(deviceId, paired, client, dial.endpoint!)) {
        await client.dispose();
        return;
      }
      debugPrint('[ws_provider] 后台 LAN 已验证 → 从远程切回同 Wi-Fi 直连');
    } catch (e) {
      debugPrint('[ws_provider] 后台 LAN 升级异常: $e');
    } finally {
      _lanUpgradeInFlight = false;
    }
  }

  /// P1-3: 进入 connecting 时武装看门狗; 超时仍未连上就翻 error 并再踢一次重连,
  /// 避免 Codex 那些"设了 connecting 就 return、deferred 路径短路后永久转圈"的死角。
  void _armConnectingWatchdog(String deviceId) {
    _connectingWatchdog?.cancel();
    _connectingWatchdogDeviceId = deviceId;
    _connectingWatchdog = Timer(_kConnectingWatchdogTimeout, () {
      if (!mounted) return;
      if (_connectingWatchdogDeviceId != deviceId) return;
      if (state.activeDesktopDeviceId != deviceId) return;
      if (state.connection != WsConnectionState.connecting) return;
      debugPrint(
        '[ws_provider] connecting 看门狗触发 — 卡 ${_kConnectingWatchdogTimeout.inSeconds}s, 翻 error 并重试 $deviceId',
      );
      state = state.copyWith(
        connection: WsConnectionState.error,
        errorMessage: tr('连接超时,正在重试…'),
      );
      /* 卡住的那一轮必须作废, 否则重试时 connectToDesktop 的单飞会把同一个
       * 卡死的 future 原样还回来, 等于没重试 (2026-09-17)。 */
      _abandonConnectAttempts();
      _scheduleSmartReconnect(deviceId, reason: 'connecting watchdog timeout');
    });
  }

  void _cancelConnectingWatchdog() {
    _connectingWatchdog?.cancel();
    _connectingWatchdog = null;
    _connectingWatchdogDeviceId = null;
  }

  /// 当前 active RPC sender — LAN 或 Cloud, 由 transport 决定. dynamic 是因为两边
  /// 实例类型不同 (WsClient vs CloudRelayClient), 但都暴露 sendRequest(String,[Object?]),
  /// duck-typing 走 dynamic 调用即可. 所有 RPC 方法 (subscribe/createSession/sendInput
  /// 等) 必须经此, 不能直接读 _client / _cloudClient — 否则一切到另一 transport 就 null.
  dynamic get _activeClient => _cloudClient ?? _client;

  /// 告诉电脑这台手机此刻在不在前台 —— 电脑的 Pilot 来电只响「你最近打开的那台」(services/pilotPhoneLink.ts)。
  /// 旧版电脑不认这个方法, 报错忽略。
  void _reportPresence() {
    if (state.connection != WsConnectionState.connected) return;
    try {
      final Future<dynamic> f = _activeClient?.sendRequest('device.presence', {'foreground': _isForeground});
      /* then+onError, 不用 catchError(→null): 运行时类型是 Future<RpcResponse>, 回 null 会在 zone 里再抛一次
       * (crash-log「error handler of Future.catchError must return a value of the future's type」) */
      unawaited(f.then((_) {}, onError: (_) {}));
    } catch (_) {/* 没连着 */}
  }

  /// 前后台切换 → 调整 LAN 连接的心跳节奏 (省电, 见 ws_client._kPingBackground).
  ///
  /// 只作用于 LAN 直连: cloud relay 那条走的是服务端托管的连接, 心跳由对端管。
  void setForeground(bool foreground) {
    final wasBackground = !_isForeground;
    _isForeground = foreground;
    if (!foreground && wasBackground == false) _backgroundedAt = DateTime.now();
    _client?.setForeground(foreground);
    if (foreground != !wasBackground) _reportPresence();
    /* 后台熬了很久回到前台 → 立刻按最快档重连一次, 别让用户干等 5 分钟.
     * (慢速档在后台会退到 5min 一次, 见 _slowReconnectInterval) */
    if (foreground && wasBackground) {
      final deviceId = state.activeDesktopDeviceId;
      if (deviceId != null &&
          state.transport != WsTransport.cloudAgent &&
          state.connection != WsConnectionState.connected) {
        _resetSmartReconnect();
        unawaited(
          connectToDesktop(deviceId, trigger: DesktopConnectTrigger.automatic),
        );
      }
    }
  }

  /// app 是否在前台 — 决定慢速重连档位 (后台一律 5 分钟一次).
  bool _isForeground = true;
  DateTime? _backgroundedAt;

  /// 回到前台: 确认连接真的活着, 再把当前会话的进度补齐 (2026-09-30 用户:
  /// 「切出去回来立马又要重连…回来时进度已经过去好多, 会话没有刷新」)。
  ///
  /// 原来回前台时 state 还是 connected —— 后台心跳 40s 一次, 安卓冻结进程后死连接要
  /// 过两个心跳才被发现。于是"连着就不重连"直接放过, 补同步的 subscribe 发在死连接上
  /// 等满 10s 超时, 之后心跳才发现断了再重连: 用户看到的是先卡住、再重连、进度不刷新。
  ///
  /// 现在: 在后台待过几秒以上就先发一个 2s 超时的探测; 死了立刻按原路重连, 等连上
  /// (最多 12s) 再补同步; 活着就直接补。
  Future<void> resumeAndCatchUp(String? sessionId) async {
    final away = _backgroundedAt == null
        ? Duration.zero
        : DateTime.now().difference(_backgroundedAt!);
    _backgroundedAt = null;
    /* 离开超过 5 秒回来, 从这一刻起就算「在同步」: 下面探活 + 等连接可能要好几秒, 这段时间屏上是
     * 离开前的旧进度, 原来什么都不显示 (2026-09-29)。attachOrCatchUp 的每条出路都会把它落成
     * ok / failed / otherDesktop, 不会一直转。 */
    if (sessionId != null && sessionId.isNotEmpty && away > const Duration(seconds: 5)) {
      _ref.read(historyLoadStatusProvider(sessionId).notifier).set(HistoryLoadPhase.loading);
    }
    final deviceId = state.activeDesktopDeviceId;
    final dynamic c = _activeClient;
    if (deviceId != null &&
        c != null &&
        state.connection == WsConnectionState.connected &&
        state.transport != WsTransport.cloudAgent &&
        away > const Duration(seconds: 5)) {
      /* 超时跟"网络切换后验证"同一档: 远程中转 / 流量下 2s 会把活连接误判成死的, 反而多重连一次 */
      final probeTimeout = (_networkKind == NetworkKind.cellularOnly ||
              state.transport == WsTransport.cloudRelay)
          ? _kVerifyTimeoutCellular
          : _kVerifyTimeoutLocal;
      try {
        await c.sendRequest('session.list', const {'limit': 1}, probeTimeout);
      } catch (e) {
        debugPrint('[ws_provider] 回前台探测失败 ($e, 后台 ${away.inSeconds}s) → 立刻重连');
        if (identical(_activeClient, c) && state.activeDesktopDeviceId == deviceId) {
          if (identical(c, _client)) {
            await _teardownClient();
          } else {
            await _teardownCloudClient();
          }
          if (!mounted) return;
          state = state.copyWith(connection: WsConnectionState.connecting);
          _resetSmartReconnect();
          _abandonConnectAttempts();
          unawaited(connectToDesktop(deviceId, trigger: DesktopConnectTrigger.automatic));
        }
      }
    }
    if (sessionId == null || sessionId.isEmpty) return;
    /* 等连接就绪再补 —— 在断开的连接上补只会得到一个"拉取失败" */
    for (var i = 0; i < 48; i++) {
      if (state.connection == WsConnectionState.connected && _activeClient != null) break;
      await Future<void>.delayed(const Duration(milliseconds: 250));
      if (!mounted) return;
    }
    await attachOrCatchUp(sessionId);
  }

  /// RPC 出错时直接把 chip 翻红 — 不等下一个 ping cycle (8s) 或重连定时器.
  /// TimeoutException 一般意味着 desktop crash / 网断 / 切到错的 transport.
  /// 调用方 catch 完后立即 rethrow 让 UI 显错误 toast.
  void _markTransportFailed(Object err) {
    if (state.connection == WsConnectionState.connected ||
        state.connection == WsConnectionState.connecting) {
      state = state.copyWith(
        connection: WsConnectionState.error,
        errorMessage: _friendlyConnectionError(err),
      );
    }
  }

  /// 由 presence push 触发 — server 告诉我们 desktop offline 了, 比心跳/RPC 超时
  /// 早 10-20s 知道. 提前把 UI 翻红, 用户感知更及时.
  void markTransportFailedFromPresence(String reason) {
    if (state.connection == WsConnectionState.connected ||
        state.connection == WsConnectionState.connecting) {
      state = state.copyWith(
        connection: WsConnectionState.error,
        errorMessage: _friendlyConnectionError(reason),
      );
    }
  }

  /// presence 推送"这台电脑上线了" —— 取消正在等的退避计时器, 立刻连。
  ///
  /// 2026-09-17: 原来 presence 那边只在 state 不是 connecting 时才重连, 而退避
  /// 等待期间 state 常常就是 connecting/error —— 电脑明明刚上线, 手机还在傻等
  /// 20s / 60s / 5min 的慢速档。单飞仍由 connectToDesktop 保证: 真有一轮在拨,
  /// 这里拿到的就是那一轮, 不会并发拨两次。
  void wakeForDesktopOnline(String deviceId) {
    if (!mounted) return;
    if (state.transport == WsTransport.cloudAgent) return;
    if (state.connection == WsConnectionState.connected &&
        state.activeDesktopDeviceId == deviceId) {
      return;
    }
    _resetSmartReconnect();
    unawaited(
      connectToDesktop(deviceId, trigger: DesktopConnectTrigger.automatic),
    );
  }

  /// M3 — sessionId → mirrorPolicy in-memory cache (drift 表暂无 mirrorPolicy 列).
  /// session.list / session.snapshot / session.mirror_changed 都会更新这里.
  final Map<String, String> _mirrorPolicyCache = {};

  String mirrorPolicyOf(String sessionId) =>
      _mirrorPolicyCache[sessionId] ?? 'always';

  void _updateMirrorPolicy(String sessionId, String? policy) {
    if (policy == null) return;
    if (_mirrorPolicyCache[sessionId] == policy) return;
    _mirrorPolicyCache[sessionId] = policy;
    state = state.copyWith(mirrorEpoch: state.mirrorEpoch + 1);
  }

  bool _isSessionNotFoundError(Object e) {
    if (e is RpcError && e.code == RpcErrorCode.sessionNotFound) return true;
    final lower = e.toString().toLowerCase();
    return lower.contains('session not found') ||
        lower.contains('session_not_found') ||
        (lower.contains('session ') && lower.contains(' not found'));
  }

  bool _isAuthoritativeSessionList(
    Map<String, dynamic> envelope,
    int returnedCount,
    int requestedLimit,
  ) {
    final complete = envelope['complete'];
    if (complete is bool) return complete;
    final hasMore = envelope['has_more'] ?? envelope['hasMore'];
    if (hasMore is bool) return !hasMore;
    final total = envelope['total'];
    if (total is num) return returnedCount >= total.toInt();
    return returnedCount < requestedLimit;
  }

  /// 本客户端刚新建的 session → 时间戳。新建后的"宽限期"内, 任何 RPC 的 not-found
  /// 一律当成竞态(订阅/查询跑在 desktop 注册之前、或重连瞬断), 绝不当"已在电脑删除"
  /// 删本地数据 —— 这是"新建会话却提示已删除"的根因修复。
  final Map<String, int> _locallyCreatedAt = {};

  /// 用户正在用的云端任务 (agent device id)。非空时自动重连不改连别处 (见 connectToDesktop)
  String? _cloudPinned;
  static const int _kFreshSessionGraceMs = 60 * 1000;

  void _markLocallyCreated(String sessionId) {
    final now = DateTime.now().millisecondsSinceEpoch;
    _locallyCreatedAt[sessionId] = now;
    _locallyCreatedAt.removeWhere((_, ts) => now - ts > _kFreshSessionGraceMs);
  }

  bool _isFreshlyCreated(String sessionId) {
    final ts = _locallyCreatedAt[sessionId];
    if (ts == null) return false;
    return DateTime.now().millisecondsSinceEpoch - ts < _kFreshSessionGraceMs;
  }

  Future<void> _deleteLocalSessionData(
    String sessionId, {
    String? reason,

    /// true = 删除请求来自某个 RPC 的 not-found(可能是竞态/瞬断), 需经"刚新建宽限期"守卫;
    /// false(默认) = 权威信号(server 广播 session.deleted / 用户主动删 / 列表对账), 直接删。
    bool transient = false,
  }) async {
    final db = _ref.read(appDatabaseProvider);
    if (transient) {
      // 刚新建的会话: 瞬态 not-found 一律当竞态, 不删。
      if (_isFreshlyCreated(sessionId)) {
        debugPrint(
          '[ws_provider] 跳过删除(刚新建宽限期内): $sessionId'
          '${reason == null ? '' : ' ($reason)'} — 视为竞态, 不当作已在电脑删除',
        );
        return;
      }
      // 手机本地会话: desktop 本来就没有它, desktop 的 not-found 对它毫无意义,
      // 绝不能据此删本地数据(根因之一: context chip 误问 desktop)。
      final mirror = await db.sessionMirrorDao.findById(sessionId);
      /* 终端会话 / 客户端会话互问: 当前连着的不是这条会话的主人, 它说「没有」不算数 */
      if (mirror != null &&
          mirror.desktopDeviceId != state.activeDesktopDeviceId &&
          (isCliEndpointId(mirror.desktopDeviceId) ||
              isCliEndpointId(state.activeDesktopDeviceId ?? ''))) {
        debugPrint('[ws_provider] 跳过删除(问错了入口): $sessionId');
        return;
      }
      if (mirror != null && isPhoneLocalDeviceId(mirror.desktopDeviceId)) {
        debugPrint(
          '[ws_provider] 跳过删除(手机本地会话, desktop not-found 不适用): $sessionId'
          '${reason == null ? '' : ' ($reason)'}',
        );
        return;
      }
      /* 会话属于别的机器 (另一台电脑 / 云端任务), 问的却是现在连着的这台: 它说没有, 什么都不说明。
       * 2026-10-11 模拟器: 刚在云端开的任务, 手机还连着 Mac, session.get 问了 Mac → not found
       * → 刚建的云端会话被删, 页面跳回首页。 */
      final owner = mirror?.desktopDeviceId;
      final asked = state.activeDesktopDeviceId;
      if (owner != null && owner.isNotEmpty && asked != null && owner != asked) {
        debugPrint(
          '[ws_provider] 跳过删除(会话属于 $owner, not-found 来自 $asked): $sessionId'
          '${reason == null ? '' : ' ($reason)'}',
        );
        return;
      }
    }
    _mirrorPolicyCache.remove(sessionId);
    _ref.read(streamBufferProvider.notifier).clearSession(sessionId);
    _ref.read(pendingApprovalsProvider.notifier).clearSession(sessionId);
    _ref.read(pendingAskUsersProvider.notifier).clearSession(sessionId);
    /* 正打开着被删的会话 → 回到 greeting 空态, 不留 "暂无消息" 的孤儿页 */
    if (_ref.read(currentSessionProvider) == sessionId) {
      _ref.read(currentSessionProvider.notifier).set(null);
    }
    await db.sessionMirrorDao.deleteById(sessionId);
    await db.sessionEventsDao.deleteBySessionId(sessionId);
    await LocalAttachmentStore.instance.deleteSession(sessionId);
    if (kDebugMode) {
      debugPrint(
        '[ws_provider] local session mirror removed: $sessionId'
        '${reason == null ? '' : ' ($reason)'}',
      );
    }
  }

  Future<void> _ingestDesktopSessionList({
    required String desktopDeviceId,
    required Iterable<dynamic> rawSessions,
    required int requestedLimit,
    required Map<String, dynamic> envelope,
  }) async {
    final db = _ref.read(appDatabaseProvider);
    /* 新电脑在每条上带 run_status (在跑 / 等人), 先记下 —— 电脑页和侧栏靠它, 不用逐条订阅 */
    _ref.read(desktopRunStatusProvider.notifier).ingest(rawSessions.toList());
    final now = DateTime.now().millisecondsSinceEpoch;
    final seen = <String>{};
    for (final raw in rawSessions) {
      final m = _asStringMap(raw);
      if (m == null) continue;
      final s = SnapshotSession.fromJson(m);
      if (s.id.isEmpty) continue;
      seen.add(s.id);
      _updateMirrorPolicy(s.id, s.mirrorPolicy);
      await db.sessionMirrorDao.upsert(
        SessionMirrorCompanion(
          id: Value(s.id),
          desktopDeviceId: Value(desktopDeviceId),
          title: Value(s.title),
          workspaceName: Value(s.workspaceName),
          lastMessageAt: Value(s.lastMessageAt),
          createdAt: Value(now),
          kind: Value(s.kind),
          parentSessionId: Value(s.parentSessionId),
        ),
      );
    }

    final authoritative = _isAuthoritativeSessionList(
      envelope,
      seen.length,
      requestedLimit,
    );
    if (!authoritative) return;

    final local = await db.sessionMirrorDao.getByDesktopDeviceId(
      desktopDeviceId,
    );
    var removed = 0;
    for (final mirror in local) {
      if (seen.contains(mirror.id)) continue;
      await _deleteLocalSessionData(
        mirror.id,
        reason: 'desktop list reconcile',
      );
      removed++;
    }
    if (removed > 0 && kDebugMode) {
      debugPrint(
        '[ws_provider] reconciled $removed stale session mirror(s) '
        'for desktop=$desktopDeviceId',
      );
    }
  }

  /// Cloud session 进 timeline 前必须调一次 — 拿 server 最新 relay_session_key 落 drift,
  /// 然后再 connectToDesktop 才能 envelope 加密成功.
  ///   - sessionId 是 cloud-xxx
  ///   - 若不是 cloud agent session, 直接 no-op
  ///   - 若 server 返 null (key 过期且不在内存): 抛 让 UI 提示用户新建
  Future<bool> cloudResumeIfNeeded(String sessionId) async {
    final db = _ref.read(appDatabaseProvider);
    final mirror = await db.sessionMirrorDao.findById(sessionId);
    if (mirror == null) return false;
    final paired = await db.pairedDesktopsDao.findByDeviceId(
      mirror.desktopDeviceId,
    );
    if (paired == null) return false;
    final isCloud = isCloudAgentPairedDesktop(paired);
    if (!isCloud) return false;
    /* 一识别出 cloud session 立刻翻 transport + connection=connecting + 清旧 errorMessage.
     * 注: copyWith 不传 errorMessage 时默认 null = 清空, 这里显式带 null 等效但意图清晰.
     * 不同时翻 connection 会让 banner 走 disconnected/error 兜底文案 (raw=null →
     * "云端 Agent 不可达 · 稍后重试"); 设 connecting 让 banner 显 "云端 Agent 启动中…". */
    state = state.copyWith(
      transport: WsTransport.cloudAgent,
      activeDesktopDeviceId: paired.deviceId,
      connection: WsConnectionState.connecting,
      errorMessage: null,
    );
    try {
      final cloud = _ref.read(cloudAgentAccessProvider);
      final result = cloud == null
          ? null
          : await cloud.resumeSession(sessionId);
      if (result == null) {
        state = state.copyWith(
          connection: WsConnectionState.error,
          errorMessage: tr('云端任务暂时无法恢复，请稍后重试或新建'),
        );
        return false;
      }
      final keyBytes = base64Decode(result.relaySessionKeyB64);
      await db.pairedDesktopsDao.upsert(
        PairedDesktopsCompanion(
          deviceId: Value(paired.deviceId),
          deviceName: Value(paired.deviceName),
          relaySessionKey: Value(keyBytes),
          deviceToken: const Value(null),
          pairedAt: Value(paired.pairedAt),
        ),
      );
      debugPrint(
        '[ws_provider] cloud resume ok session=$sessionId state=${result.state}',
      );
      return true;
    } catch (e) {
      debugPrint('[ws_provider] cloud resume failed: $e');
      /* 失败必须翻 error 状态, 不然 state 永远卡在 connecting → banner 卡 "启动中…" 不动 */
      state = state.copyWith(
        connection: WsConnectionState.error,
        errorMessage: _shortResumeError(e),
      );
      return false;
    }
  }

  String _shortResumeError(Object e) {
    final raw = e.toString();
    final low = raw.toLowerCase();
    if (low.contains('socketexception') ||
        low.contains('connection refused') ||
        low.contains('failed host lookup')) {
      return tr('网络不可达 — 检查 WiFi / 数据连接');
    }
    if (low.contains('timeout')) return tr('云端响应超时，请重试');
    if (low.contains('401') || low.contains('unauthorized')) {
      return tr('登录已过期，请重新登录');
    }
    if (low.contains('403')) return tr('当前账户暂不能使用云端任务');
    return raw.length > 80 ? '${raw.substring(0, 77)}…' : raw;
  }

  String _friendlyConnectionError(Object? err) {
    final raw = (err ?? '').toString().trim();
    final low = raw.toLowerCase();
    final isCloudTask = state.transport == WsTransport.cloudAgent;
    if (raw.isEmpty) {
      return isCloudTask ? tr('云端任务暂不可用，请稍后重试') : tr('连接暂不可用，请重试');
    }
    if (low.contains('paired desktop') && low.contains('not found')) {
      return tr('未找到这台电脑，请重新连接');
    }
    if (low.contains('paired record missing token')) {
      return tr('这台电脑需要重新连接');
    }
    if (low.contains('missing host/port') || low.contains('mdns')) {
      return tr('正在查找同 Wi-Fi 下的电脑，请确认电脑端 Neox 已打开');
    }
    if (low.contains('socketexception') ||
        low.contains('connection refused') ||
        low.contains('failed host lookup') ||
        low.contains('network is unreachable')) {
      return tr('网络不可达，请检查网络后重试');
    }
    if (low.contains('timed out') || low.contains('timeout')) {
      if (isCloudTask) return tr('云端任务响应超时，请重试');
      if (state.transport == WsTransport.cloudRelay) {
        return tr('远程连接响应超时，请重试');
      }
      return tr('电脑响应超时，请确认电脑端 Neox 已打开');
    }
    if (low.contains('cloud-relay not connected')) {
      return isCloudTask ? tr('云端任务连接已断开，请重试') : tr('远程连接已断开，请重试');
    }
    if (low.contains('connection closed')) {
      return tr('连接已断开，请重新连接');
    }
    if (low.contains('desktop') && low.contains('不响应')) {
      return tr('电脑端暂时没有响应，请确认 Neox 已打开');
    }
    if (low.contains('agent is still working')) {
      return tr('任务正在处理中，请稍等');
    }
    if (low.startsWith('stateerror: ')) {
      return raw.substring('StateError: '.length);
    }
    if (low.startsWith('exception: ')) {
      return raw.substring('Exception: '.length);
    }
    return raw.length > 80 ? '${raw.substring(0, 77)}…' : raw;
  }

  /// 通用入口 — 真实电脑默认先试同 Wi-Fi, 不通再自动远程兜底.
  /// 所有 "tap-to-connect" UI 路径都该用这个, 不要直接调 connectLan/connectCloudRelay.
  ///
  /// **cloud_agent 检测**: paired_desktops row 若名字带 ☁ 前缀,
  /// 视为 cloud agent — 强制走 cloud relay (不存在 LAN 路径).
  /// 连上**任何一台能连的**电脑, 而不是死磕排名第一的那台。
  ///
  /// 2026-09-03 真机实录: 手机锁定 85ad2469 (一台配对已失效的 Windows) 反复重试,
  /// 而同一个 Wi-Fi 下另一台 Mac 正开着、能连、**一次都没被尝试过**。用户看到的是
  /// "连不上", 事实是"我们没去连那台能连的"。
  ///
  /// 排序仍然按 rankDesktopsForRouting (连着的 > 服务端说还活着的 > 最近连过的) ——
  /// 那是"最该用哪台"的判断, 没错; 错的是把它当成**唯一**一台。这里让它退化成
  /// 尝试顺序: 第一台不行就下一台, 有一台成了就停。
  ///
  /// [trigger] 透传; automatic 触发时单台的等待更短, 整体不会因为多试几台就拖很久。
  Future<void> connectToBestAvailableDesktop({
    DesktopConnectTrigger trigger = DesktopConnectTrigger.automatic,
  }) async {
    final db = _ref.read(appDatabaseProvider);
    final all = (await db.pairedDesktopsDao.getAll())
        .where((d) => isRealPairedDesktop(d) && canConnectPairedDesktop(d))
        .toList();
    if (all.isEmpty) return;

    final live = state.connection == WsConnectionState.connected
        ? state.activeDesktopDeviceId
        : null;
    var ordered = rankDesktopsForRouting<PairedDesktop>(
      all,
      deviceId: (d) => d.deviceId,
      lastConnectedAt: (d) => d.lastConnectedAt,
      pairedAt: (d) => d.pairedAt,
      lastAnnounceAt: (d) => d.lastAnnounceAt,
      liveDeviceId: live,
    );

    /* 用户显式设过「首选电脑」就必须先试它。
     *
     * rankDesktopsForRouting 排的是"客观上最可能连得上哪台"(连着的 > 服务端说还活着的 >
     * 最近连过的), 它压根不知道用户的选择 —— 于是刚加的"逐台尝试"会按客观顺序连上另一台,
     * 用户设的首选形同虚设。实测就撞上了: 首选是 Mac, 结果连去了旁边那台 Windows。
     * 首选是**用户的意图**, 客观排序只该决定"首选不通时先试谁"。
     *
     * 2026-09-22: 原来这里是手写的一段 removeAt/insert, 跟 session_router 和
     * startup_coordinator 各写一遍 —— 而 startup_coordinator 那份就漏了 (首选 Mac
     * 却每次冷启动都连 Windows)。收成 hoistPreferred 一个纯函数, 三处共用。 */
    ordered = orderByUserIntent(
      ordered,
      preferredDeviceId: _ref.read(preferredDesktopProvider),
      currentDeviceId: currentDesktopId,
      deviceId: (d) => d.deviceId,
    );

    /* ⚠️ 每一台都用 user 触发, 不用传进来的 automatic。
     *
     * 真机第一次验证就撞上: automatic 触发时 connectToDesktop 内部会
     * `_deferAutomaticLanReconnect` —— 排一次 smart reconnect 然后**立刻返回**,
     * 于是这个循环看到的永远是 connecting, 一台都没真试过就走完了, 日志里只剩
     * 一台在慢速重试 (实测卡在 DESKTOP-07LLJV4, 而同网段的 Mac 从没被拨过)。
     *
     * "把每一台都真正试到底" 本来就是用户点了一次连接的语义, 所以这里用 user;
     * 全部试完仍不通时, 最后一台的 _afterAllRoutesFailed 会把重试排上,
     * 自动重连的节奏不会因此丢掉。
     * (2026-09-17: `_deferAutomaticLanReconnect` 已随 LAN 优先串行一起删掉, 但
     *  "每台真正试到底"的语义不变, 仍用 user。) */
    for (final d in ordered) {
      /* 这一轮跑着的时候用户进了云端任务: 停下, 别把它顶掉 (这里每台都用 user 触发, connectToDesktop 那道闸拦不住) */
      if (_cloudPinned != null) {
        debugPrint('[ws_provider] 择优连接中止: 正在用云端任务 $_cloudPinned');
        return;
      }
      try {
        await connectToDesktop(d.deviceId, trigger: DesktopConnectTrigger.user);
        /* connectToDesktop 返回 ≠ 连接已定局: WS 认证是异步事件, state 要等
         * `[ws] authenticated` 回来才翻成 connected。真机实测这一步导致
         * "authenticated" 和 "Mac 没连上, 试下一台" 前后脚出现 —— 明明连上了却
         * 被判失败, 然后又去连下一台, 把刚建好的连接顶掉。
         *
         * 2026-09-17: 等待上限按这一轮走不走远程定。原来固定 6s, 比一次远程连接
         * 最坏耗时 (≈14.3s, 见 kRelayWorstCaseSettle) 短 —— 远程还在验证就被判
         * "没连上", 转头去连下一台, 把那条马上就通的远程顶掉。 */
        final usesRelay = _lastPlan?.usesRelay ?? true;
        await _waitConnectionSettled(
          d.deviceId,
          timeout: usesRelay
              ? kRelayWorstCaseSettle + const Duration(milliseconds: 700)
              : const Duration(seconds: 6),
        );
        if (state.connection == WsConnectionState.connected) {
          debugPrint('[ws_provider] 择优连接成功: ${d.deviceName ?? d.deviceId}');
          _markReachable(d.deviceId);
          return;
        }
        debugPrint('[ws_provider] ${d.deviceName ?? d.deviceId} 没连上, 试下一台');
        _markUnreachable(d.deviceId);
      } catch (e) {
        debugPrint(
          '[ws_provider] ${d.deviceName ?? d.deviceId} 连不上 ($e), 试下一台',
        );
        _markUnreachable(d.deviceId);
      }
    }
    debugPrint('[ws_provider] ${ordered.length} 台电脑都没连上, 交给慢速重试');
  }

  Future<void> connectToDesktop(
    String desktopDeviceId, {
    DesktopConnectTrigger trigger = DesktopConnectTrigger.user,
  }) {
    /* 用户正在用云端任务: 自动重连 (网络变化 / 回前台 / 退避重试 / 启动时择优) 不能把唯一那条连接换回电脑。
     * 2026-10-11 模拟器: 刚开的云端任务还在启动, 第一次连失败, 网络事件随即把连接拉回 Mac,
     * 消息没送到云端, 会话还被当成「电脑上没有」删掉。只有用户自己点的才换。 */
    final pinned = _cloudPinned;
    if (pinned != null && desktopDeviceId != pinned && trigger == DesktopConnectTrigger.automatic) {
      debugPrint('[ws_provider] 正在用云端任务 $pinned, 不自动改连 $desktopDeviceId');
      return Future.value();
    }
    if (trigger == DesktopConnectTrigger.user) {
      _cancelSmartReconnect();
    } else {
      _smartReconnectTimer?.cancel();
      _smartReconnectTimer = null;
    }
    final inFlight = _connectToDesktopInFlight;
    if (inFlight != null &&
        _connectToDesktopInFlightDeviceId == desktopDeviceId) {
      return inFlight;
    }
    /* 新一轮开始 = 之前任何一轮 (包括别的电脑的) 迟到的结果都作废 */
    _connectGeneration += 1;
    final gen = _connectGeneration;
    late final Future<void> next;
    next = _connectToDesktopInternal(desktopDeviceId, trigger, gen)
        .whenComplete(() {
          if (identical(_connectToDesktopInFlight, next)) {
            _connectToDesktopInFlight = null;
            _connectToDesktopInFlightDeviceId = null;
          }
        });
    _connectToDesktopInFlight = next;
    _connectToDesktopInFlightDeviceId = desktopDeviceId;
    _armConnectingWatchdog(desktopDeviceId);
    return next;
  }

  Future<void> _connectToDesktopInternal(
    String desktopDeviceId,
    DesktopConnectTrigger trigger,
    int gen,
  ) async {
    /* 电脑上的 CLI 终端 (<电脑 id>#cli:<id>): 只能走远程中转 (局域网那条是客户端的), 不做选路 */
    if (isCliEndpointId(desktopDeviceId)) {
      /* 跟云端任务一样钉住: 网络变化 / 回前台 / 退避重试这些自动重连不许把连接拉回客户端那条
       * (模拟器实测: 终端刚连上, 自动择优就把它换回 Mac, 会话被踢回首页)。用户点别的会话 / 电脑时松开 */
      _cloudPinned = desktopDeviceId;
      state = state.copyWith(
        transport: WsTransport.cloudRelay,
        activeDesktopDeviceId: desktopDeviceId,
        connection: WsConnectionState.connecting,
        errorMessage: null,
      );
      await connectCloudRelay(desktopDeviceId: desktopDeviceId);
      return;
    }
    /* 提前查 paired 决定是不是 cloud agent */
    final db = _ref.read(appDatabaseProvider);
    final paired = await db.pairedDesktopsDao.findByDeviceId(desktopDeviceId);
    final isCloudAgent = paired != null && isCloudAgentPairedDesktop(paired);
    /* 连云端任务 = 钉住它; 用户点了某台电脑 = 松开 (自动重连只认钉住的那个, 见 connectToDesktop) */
    if (isCloudAgent) {
      _cloudPinned = desktopDeviceId;
    } else if (trigger == DesktopConnectTrigger.user) {
      _cloudPinned = null;
    }
    if (isCloudAgent) {
      /* 进 cloud agent 分支 — 先翻 transport + connection=connecting, 任何 early-return
       * error 都能让 ConnectionBanner 显云端文案. 同时翻 connecting 避免残留 error
       * 走 humanizeError(null) 兜底显成 "云端 Agent 不可达 · 稍后重试". */
      state = state.copyWith(
        transport: WsTransport.cloudAgent,
        activeDesktopDeviceId: desktopDeviceId,
        connection: WsConnectionState.connecting,
        errorMessage: null,
      );
      /* 单 transport 纪律 (电脑那条路在选路开头做, 云端这条以前漏了): 先拆旧连接。
       * 不拆的话「现在连的是云端任务」, 请求却还走着 Mac 那条 socket —— session.get 问到 Mac,
       * Mac 说没有, 刚建的云端会话就被删了 (2026-10-11 模拟器)。 */
      await _teardownClient();
      await _teardownCloudClient();
      final remote = _ref.read(remoteLinkProvider);
      if (remote == null || !remote.signedIn) {
        state = state.copyWith(
          connection: WsConnectionState.error,
          errorMessage: tr('请先登录账户后再使用云端任务'),
        );
        return;
      }
      /* 关键: 连 cloud agent 前先 resume — 验 pod 还活着 + 拿 fresh key
       * 不这么做会卡在 connectCloudRelay 等死服务器, 因为 session 可能 suspended/terminated.
       * resume 会自动 re-allocate pod 如果需要, 失败立刻返错而不是 hang. */
      final mirrors = await db.sessionMirrorDao.getAll();
      final mySessions = mirrors
          .where((m) => m.desktopDeviceId == desktopDeviceId)
          .toList();
      if (mySessions.isEmpty) {
        state = state.copyWith(
          connection: WsConnectionState.error,
          errorMessage: tr('该云端会话已不存在, 请新建一个'),
        );
        return;
      }
      /* 用最近 lastMessageAt 的那条 session 做 resume */
      mySessions.sort(
        (a, b) => (b.lastMessageAt ?? 0).compareTo(a.lastMessageAt ?? 0),
      );
      final sessionId = mySessions.first.id;
      state = state.copyWith(
        connection: WsConnectionState.connecting,
        errorMessage: null,
      );
      final ok = await cloudResumeIfNeeded(sessionId);
      if (!ok) {
        /* cloudResumeIfNeeded 已经 set errorMessage, 这里不再覆盖 */
        if (state.connection != WsConnectionState.error) {
          state = state.copyWith(
            connection: WsConnectionState.error,
            errorMessage: tr('云端任务恢复失败，请重试或新建'),
          );
        }
        return;
      }
      await connectCloudRelay(
        desktopDeviceId: desktopDeviceId,
        isCloudAgent: true,
      );
      return;
    }
    if (paired == null) {
      if (!_isCurrentAttempt(gen)) return;
      state = state.copyWith(
        activeDesktopDeviceId: desktopDeviceId,
        connection: WsConnectionState.error,
        errorMessage: tr('未找到这台电脑，请重新连接'),
      );
      return;
    }

    await _ensureNetworkKindKnown();
    if (!_isCurrentAttempt(gen)) return;

    var target = paired;
    /* 远程能力 (中继 + 账号身份) 由发行版提供; 没有时 signedIn=false,
     * 下面的选路自然只剩同 Wi-Fi 一条。 */
    final remote = _ref.read(remoteLinkProvider);
    final signedIn = remote?.signedIn ?? false;

    /* 账号自动配对的真实电脑可能只有 relay key、没有 LAN token —— 先同步一次
     * 设备列表, 看能不能拿到 LAN token。
     *
     * 2026-09-17: 这一步原来 await 在连接单飞里 (4s 请求 + 可能的 token 刷新),
     * 蜂窝下更是纯浪费 —— LAN token 拿到了也用不上。现在:
     *   蜂窝 → 放后台跑, 直接走远程;
     *   其它 → 最多等 kConnectSideTaskCap, 超时就先用手上的记录连, 同步照样在后台跑完。 */
    final hasLanTokenNow = target.deviceToken?.isNotEmpty ?? false;
    final hasRelayKeyNow = target.relaySessionKey?.isNotEmpty ?? false;
    if (!hasLanTokenNow && hasRelayKeyNow && signedIn) {
      if (_networkKind == NetworkKind.cellularOnly) {
        unawaited(_upgradeAccountDesktopToken(desktopDeviceId));
      } else {
        target = await _upgradeAccountDesktopToken(desktopDeviceId) ?? target;
        if (!_isCurrentAttempt(gen)) return;
      }
    }

    /* 服务端说的"这台电脑有没有接入中继"。null = 没说 (老服务端), 按能连处理。
     *
     * 电脑在线但中继没接上 —— 这是"电脑开着却连不上"的真身 (电脑的中继 WS 断了
     * 以前没人管)。不是放弃, 而是让服务端从电脑那条活着的心跳连接上叫它重拨,
     * 等它接回来再拨号; 等不到才如实说。详见 connection_strategy 里的注释。 */
    var peerRelayOnline = _ref
        .read(desktopPresenceProvider)
        .relayOnline(desktopDeviceId);
    if (peerRelayOnline == false && remote != null) {
      debugPrint('[ws_provider] $desktopDeviceId 中继未接入 → 唤醒电脑');
      state = state.copyWith(
        activeDesktopDeviceId: desktopDeviceId,
        connection: WsConnectionState.connecting,
        errorMessage: tr('正在唤醒电脑'),
      );
      final woke = await remote.wakeRelayAndWait(desktopDeviceId);
      if (!_isCurrentAttempt(gen)) return;
      peerRelayOnline = woke ? true : false;
      debugPrint('[ws_provider] 唤醒结果 $desktopDeviceId relay=$peerRelayOnline');
    }

    final plan = planRoute(
      network: _networkKind,
      hasLanToken: target.deviceToken?.isNotEmpty ?? false,
      hasRelayKey: target.relaySessionKey?.isNotEmpty ?? false,
      loggedIn: signedIn,
      autoFallbackEnabled: _ref.read(autoFallbackProvider),
      peerRelayOnline: peerRelayOnline,
    );
    _lastPlan = plan;
    _activeConnectTrigger = trigger;
    debugPrint(
      '[ws_provider] 选路 $desktopDeviceId network=${_networkKind.name} → $plan',
    );

    switch (plan.kind) {
      case RouteKind.waitForNetwork:
        state = state.copyWith(
          activeDesktopDeviceId: desktopDeviceId,
          transport: WsTransport.none,
          connection: WsConnectionState.disconnected,
          errorMessage: connectingStatusMessage(plan.kind, _networkKind),
        );
        return;
      case RouteKind.unavailable:
        /* 不排重试: 没登录 / 没密钥 / 远程被关, 再试多少次结果都一样。
         * 网络变化、登录后启动流程、用户点连接会重新进来。 */
        state = state.copyWith(
          activeDesktopDeviceId: desktopDeviceId,
          transport: _networkKind == NetworkKind.cellularOnly
              ? WsTransport.cloudRelay
              : WsTransport.none,
          connection: WsConnectionState.error,
          errorMessage: plan.reason,
        );
        /* 唤醒没等到 —— 这一条**要**重试: 电脑那边可能正在重拨 (跨境握手比我们
         * 等的 8 秒慢), 或者刚从休眠里醒过来。慢速档接着试, 别让用户自己去点。 */
        if (peerRelayOnline == false) {
          _scheduleSmartReconnect(desktopDeviceId, reason: 'peer relay down');
        }
        return;
      case RouteKind.relayOnly:
      case RouteKind.lanOnly:
      case RouteKind.raceLanFirst:
        await _runRoute(desktopDeviceId, target, plan, trigger, gen);
        return;
    }
  }

  bool _isCurrentAttempt(int gen) => mounted && gen == _connectGeneration;

  Future<PairedDesktop?> _upgradeAccountDesktopToken(
    String desktopDeviceId,
  ) async {
    try {
      final remote = _ref.read(remoteLinkProvider);
      if (remote == null) return null;
      final changed = await remote.syncDesktops().timeout(kConnectSideTaskCap);
      if (changed > 0) {
        debugPrint(
          '[ws_provider] account desktop upgraded before connect: $desktopDeviceId',
        );
      }
    } on TimeoutException {
      debugPrint(
        '[ws_provider] 设备同步超过 ${kConnectSideTaskCap.inSeconds}s, 先按现有配对记录连 (同步在后台继续)',
      );
    } catch (e) {
      debugPrint('[ws_provider] account desktop upgrade skipped: $e');
    }
    if (!mounted) return null;
    return _ref
        .read(appDatabaseProvider)
        .pairedDesktopsDao
        .findByDeviceId(desktopDeviceId);
  }

  /// 按选好的路执行一轮连接: 拨号 → 验证 → 接管; 全失败就排重试。
  Future<void> _runRoute(
    String desktopDeviceId,
    PairedDesktop paired,
    RoutePlan plan,
    DesktopConnectTrigger trigger,
    int gen,
  ) async {
    /* 单 transport 纪律: 新一轮开始先拆掉旧连接, 旧连接迟到的事件不能再改 state。 */
    await _teardownClient();
    await _teardownCloudClient();
    if (!_isCurrentAttempt(gen)) return;

    state = state.copyWith(
      connection: WsConnectionState.connecting,
      transport: switch (plan.kind) {
        RouteKind.relayOnly => WsTransport.cloudRelay,
        RouteKind.lanOnly => WsTransport.lan,
        _ => WsTransport.none,
      },
      activeDesktopDeviceId: desktopDeviceId,
      errorMessage: connectingStatusMessage(plan.kind, _networkKind),
    );

    final sw = Stopwatch()..start();
    bool alive() => _isCurrentAttempt(gen);
    WsPairingRejected? rejected;
    String? detail;
    var won = false;

    switch (plan.kind) {
      case RouteKind.lanOnly:
        final r = await _dialLanVerified(
          desktopDeviceId,
          paired,
          _DialGuard(alive),
        );
        final c = r.client;
        if (c != null) {
          won = alive() && _adoptLan(desktopDeviceId, paired, c, r.endpoint!);
          if (!won) await c.dispose();
        }
        rejected = r.rejected;
        detail = r.rejected?.message;
      case RouteKind.relayOnly:
        final r = await _dialRelayVerified(
          desktopDeviceId,
          paired,
          _DialGuard(alive),
        );
        final c = r.client;
        if (c != null) {
          won = alive() && _adoptRelay(desktopDeviceId, paired, c);
          if (!won) await c.dispose();
        }
        detail = r.failure;
      case RouteKind.raceLanFirst:
        final r = await _raceLanAndRelay(desktopDeviceId, paired, alive);
        won = r.won;
        rejected = r.rejected;
        detail = r.detail;
      case RouteKind.waitForNetwork:
      case RouteKind.unavailable:
        return;
    }
    debugPrint(
      '[ws_provider] 选路 ${plan.kind.name} ${won ? '成功' : '失败'} '
      '${sw.elapsedMilliseconds}ms $desktopDeviceId${detail == null ? '' : ' ($detail)'}',
    );
    if (won || !_isCurrentAttempt(gen)) return;

    /* 配对失效 (桌面活着但 401 拒升级)。
     *
     * 【2026-09-03 改】原来到这里就停下, 把 "请到「我的设备」重新配对" 甩给用户。
     * 真机上的样子是: 两端登录着同一个账号、云端两边的 pubkey 都在、旁边还有另一台
     * 电脑正连得上, 而用户被要求去理解"配对失效"并手动扫码。用户原话:
     * "不认识连不上这种体验对用户来说致命, 正常来说我们什么时候都应该可以连的上"。
     *
     * 而自动重新配对的能力**一直都有** (AutoPairService: 取双方 pubkey → ECDH → HKDF
     * 派生新的 relay key), 只是从来没有在这个失败点上被调用过。
     *
     * 现在: 先自愈一次, 成功就当场重连; 自愈不了再交给调用方换下一台电脑
     * (见 connectToBestAvailableDesktop) —— 让用户手动扫码是最后手段, 不是第一反应。 */
    if (rejected != null) {
      final repaired = await _tryRepairPairing(desktopDeviceId);
      if (!_isCurrentAttempt(gen)) return;
      if (repaired) {
        debugPrint('[ws_provider] 配对已自动修复, 重连 $desktopDeviceId');
        /* 不能直接 connectToDesktop: 此刻还在本轮单飞里, 同一台会拿回本轮自己的
         * future 什么都不做 (原实现就是这样静默没重连)。排到下一个事件循环。 */
        Timer.run(() {
          if (!mounted) return;
          unawaited(connectToDesktop(desktopDeviceId, trigger: trigger));
        });
        return;
      }
      state = state.copyWith(
        connection: WsConnectionState.error,
        errorMessage: rejected.message,
      );
      throw rejected; // 让上层知道"这台不行", 好去试下一台
    }

    _afterAllRoutesFailed(desktopDeviceId, plan: plan, detail: detail);
  }

  /// 同 Wi-Fi 下两条路赛跑 (happy eyeballs)。
  ///
  /// LAN 先起; [kRelayHeadStart] 内 LAN 没验证通 (或 LAN 提前失败) 就同时起远程。
  /// **先验证通过**的接管, 另一条经 [_DialGuard.cancel] 立刻 dispose —— 输家从没
  /// 挂过 _handleEvent 监听, 也没写过 _client/_cloudClient, 碰不到 state。
  Future<({bool won, WsPairingRejected? rejected, String? detail})>
  _raceLanAndRelay(
    String desktopDeviceId,
    PairedDesktop paired,
    bool Function() alive,
  ) async {
    final lanGuard = _DialGuard(alive);
    final relayGuard = _DialGuard(alive);
    final done = Completer<void>();
    var won = false;
    var lanFinished = false;
    var relayStarted = false;
    var relayFinished = false;
    _LanDial? lanResult;
    _RelayDial? relayResult;
    Timer? headStart;

    void settleIfAllFailed() {
      if (won || done.isCompleted) return;
      if (lanFinished && relayStarted && relayFinished) done.complete();
    }

    Future<void> startRelay() async {
      if (relayStarted || won) return;
      relayStarted = true;
      headStart?.cancel();
      debugPrint('[ws_provider] 赛跑: 起远程 $desktopDeviceId');
      _RelayDial r;
      try {
        r = await _dialRelayVerified(desktopDeviceId, paired, relayGuard);
      } catch (e) {
        /* 任何一路抛异常都必须"跑完", 否则 done 永远不完成, 整个连接单飞卡死 */
        debugPrint('[ws_provider] 赛跑: 远程拨号异常 $e');
        r = _RelayDial(failure: tr('远程连接暂不可用，请稍后重试'));
      }
      relayFinished = true;
      relayResult = r;
      final c = r.client;
      if (c != null) {
        if (!won && alive() && _adoptRelay(desktopDeviceId, paired, c)) {
          won = true;
          debugPrint('[ws_provider] 赛跑: 远程先通, 关掉 LAN 那一路');
          lanGuard.cancel();
          if (!done.isCompleted) done.complete();
          return;
        }
        await c.dispose();
      }
      settleIfAllFailed();
    }

    headStart = Timer(kRelayHeadStart, () => unawaited(startRelay()));
    unawaited(() async {
      _LanDial r;
      try {
        r = await _dialLanVerified(desktopDeviceId, paired, lanGuard);
      } catch (e) {
        debugPrint('[ws_provider] 赛跑: LAN 拨号异常 $e');
        r = _LanDial(failure: 'LAN dial threw: $e');
      }
      lanFinished = true;
      lanResult = r;
      final c = r.client;
      if (c != null) {
        if (!won &&
            alive() &&
            _adoptLan(desktopDeviceId, paired, c, r.endpoint!)) {
          won = true;
          headStart?.cancel();
          if (relayStarted) {
            debugPrint('[ws_provider] 赛跑: LAN 先通, 关掉远程那一路');
          }
          relayGuard.cancel();
          if (!done.isCompleted) done.complete();
          return;
        }
        await c.dispose();
      }
      /* LAN 早早就失败了 (没候选 / 探测不通) —— 别等满让先时间 */
      if (!relayStarted && !won) {
        unawaited(startRelay());
        return;
      }
      settleIfAllFailed();
    }());

    await done.future;
    headStart.cancel();
    /* 失败原因优先用远程的 (「电脑已离线」「登录已过期」比"LAN 探测不通"有信息量) */
    return (
      won: won,
      rejected: won ? null : lanResult?.rejected,
      detail: won
          ? null
          : (relayResult?.failure ?? lanResult?.rejected?.message),
    );
  }

  /// 接管一条**已验证**的 LAN 连接。全同步: 检查、换字段、挂监听、翻 state 在同一拍
  /// 完成, 中间没有 await —— 不会出现"旧的拆了、新的还没挂上"的窗口。
  bool _adoptLan(
    String desktopDeviceId,
    PairedDesktop paired,
    WsClient client,
    LanEndpoint endpoint,
  ) {
    if (!mounted || client.state != WsState.authenticated) return false;
    final oldLan = _client;
    final oldLanSub = _eventsSub;
    final oldRelay = _cloudClient;
    final oldRelaySub = _cloudEventsSub;
    _subscribedSessions.clear();
    _cloudClient = null;
    _cloudEventsSub = null;
    _client = client;
    _eventsSub = client.events.listen((evt) {
      if (!identical(_client, client)) return;
      _handleEvent(evt, paired);
    });
    client.setForeground(_isForeground);
    unawaited(_disposeDetached(oldLanSub, oldLan));
    unawaited(_disposeDetached(oldRelaySub, oldRelay));
    state = state.copyWith(
      transport: WsTransport.lan,
      activeDesktopDeviceId: desktopDeviceId,
    );
    _onTransportAuthenticated(paired);
    unawaited(_syncSelfHostedRelay(client));
    if (paired.lastSeenLanIp != endpoint.host ||
        paired.lastSeenLanPort != endpoint.port) {
      unawaited(
        _ref
            .read(appDatabaseProvider)
            .pairedDesktopsDao
            .updateLanEndpoint(desktopDeviceId, endpoint.host, endpoint.port),
      );
    }
    return true;
  }

  /// 同 Wi-Fi 连上时问电脑要自托管中继 (电脑那边可能刚配好 / 改了地址)。
  /// 老电脑不认这个方法 —— 报错就当没配, 不影响连接。没配的电脑不清别人给的。
  Future<void> _syncSelfHostedRelay(WsClient client) async {
    try {
      final resp = await client.sendRequest(
        'relay.config',
        const {},
        const Duration(seconds: 5),
      );
      final result = resp.result;
      final relay = result is Map ? SelfHostedRelay.fromJson(result['relay']) : null;
      if (relay != null && mounted) {
        await _ref.read(selfHostedRelayProvider.notifier).apply(relay);
      }
    } catch (e) {
      debugPrint('[ws_provider] relay.config 不可用: $e');
    }
  }

  /// 接管一条**已验证**的远程连接 (同 [_adoptLan], 全同步)。
  bool _adoptRelay(
    String desktopDeviceId,
    PairedDesktop paired,
    RelayChannel client,
  ) {
    if (!mounted || client.state != WsState.authenticated) return false;
    final oldLan = _client;
    final oldLanSub = _eventsSub;
    final oldRelay = _cloudClient;
    final oldRelaySub = _cloudEventsSub;
    _subscribedSessions.clear();
    _client = null;
    _eventsSub = null;
    _cloudClient = client;
    _cloudEventsSub = client.events.listen((evt) {
      if (!identical(_cloudClient, client)) return;
      _handleEvent(evt, paired);
    });
    unawaited(_disposeDetached(oldLanSub, oldLan));
    unawaited(_disposeDetached(oldRelaySub, oldRelay));
    state = state.copyWith(
      transport: WsTransport.cloudRelay,
      activeDesktopDeviceId: desktopDeviceId,
    );
    _onTransportAuthenticated(paired);
    return true;
  }

  Future<void> _disposeDetached(
    StreamSubscription<WsEvent>? sub,
    dynamic client,
  ) async {
    try {
      await sub?.cancel();
    } catch (_) {}
    try {
      if (client != null) await client.dispose();
    } catch (_) {}
  }

  /// 拨一条 LAN 连接并验证, **不碰 state / 监听器 / _client**。成功返回未接管的客户端。
  Future<_LanDial> _dialLanVerified(
    String desktopDeviceId,
    PairedDesktop paired,
    _DialGuard guard,
  ) async {
    final token = paired.deviceToken;
    if (token == null || token.isEmpty) {
      return _LanDial(failure: tr('这台电脑需要重新连接'));
    }
    if (_networkKind == NetworkKind.cellularOnly ||
        _networkKind == NetworkKind.offline) {
      return _LanDial(failure: tr('手机不在 Wi-Fi 上'));
    }

    final networkProfile = await LocalNetworkProfile.capture();
    /* 手机自己一个局域网地址都没有 (只有蜂窝接口) —— LAN 不可能通, 别探测也别扫 mDNS。
     * 平台报 unknown (比如只报了 vpn) 时靠这一条兜住。 */
    if (!networkProfile.hasLocalLanAddress) {
      return _LanDial(failure: tr('手机当前没有局域网地址'));
    }
    if (!guard.alive) return const _LanDial(failure: 'abandoned');

    var candidates = _collectLanEndpointCandidates(
      desktopDeviceId,
      paired,
      networkProfile,
    );
    if (candidates.isEmpty) {
      final fresh = await _rediscoverLanEndpoint(
        desktopDeviceId,
        currentHost: paired.lastSeenLanIp,
        currentPort: paired.lastSeenLanPort,
      );
      if (fresh != null) {
        final (newHost, newPort) = fresh;
        candidates = rankLanEndpoints([
          LanEndpoint(
            host: newHost,
            port: newPort,
            source: LanEndpointSource.mdns,
          ),
        ], networkProfile);
      }
    }
    if (candidates.isEmpty) {
      return _LanDial(failure: tr('mDNS 找不到同 Wi-Fi endpoint'));
    }
    if (!guard.alive) return const _LanDial(failure: 'abandoned');

    debugPrint(
      '[ws_provider] LAN candidates $desktopDeviceId: '
      '${_describeLanCandidates(candidates, networkProfile)}',
    );
    var probe = await _orderLanCandidatesByProbe(candidates);
    candidates = probe.ordered;
    if (!probe.hasReachable && guard.alive) {
      /* 缓存 endpoint 全部探测失败 — 典型场景: 手机/电脑换了 Wi-Fi 网段,
       * drift 里的旧 IP 已失效。此时必须 mDNS rediscover 拿新 IP, 否则
       * 永远在死循环重试旧地址 (真机实锤: 10.x → 225.x 网段迁移). */
      final fresh = await _rediscoverLanEndpoint(
        desktopDeviceId,
        currentHost: paired.lastSeenLanIp,
        currentPort: paired.lastSeenLanPort,
      );
      if (fresh != null) {
        final (newHost, newPort) = fresh;
        final alreadyTried = candidates.any(
          (c) => c.host == newHost && c.port == newPort,
        );
        if (!alreadyTried) {
          debugPrint(
            '[ws_provider] stale LAN cache, mdns fresh endpoint: '
            '$desktopDeviceId @ $newHost:$newPort',
          );
          final reRanked = rankLanEndpoints([
            ...candidates,
            LanEndpoint(
              host: newHost,
              port: newPort,
              source: LanEndpointSource.mdns,
            ),
          ], networkProfile);
          probe = await _orderLanCandidatesByProbe(reRanked);
          candidates = probe.ordered;
        }
      }
    }
    if (!probe.hasReachable) {
      return const _LanDial(failure: 'no reachable exact LAN endpoint');
    }

    /* WS handshake header x-neox-device-id 必须是 *Phone 自己* 的 device_id —
     * Desktop server 按 token 反查 paired_mobiles 后跟 header device_id 比对,
     * 不一致直接 401. 之前误用了 paired.deviceId (Desktop 的) → handshake 永远炸. */
    final phoneIdent = await _ref.read(phoneIdentityProvider.future);

    for (var i = 0; i < candidates.length; i++) {
      if (!guard.alive) return const _LanDial(failure: 'abandoned');
      final endpoint = candidates[i];
      debugPrint(
        '[ws_provider] LAN try ${i + 1}/${candidates.length}: '
        '$desktopDeviceId @ ${endpoint.host}:${endpoint.port} (${endpoint.sourceLabel})',
      );
      final client = WsClient(
        WsClientConfig(
          host: endpoint.host,
          port: endpoint.port,
          deviceId: phoneIdent.deviceId,
          deviceToken: token,
          relaySessionKey: paired.relaySessionKey,
          reconnect: false,
        ),
      );
      guard.onCancel(client.dispose);
      try {
        await client.connect();
      } catch (e) {
        debugPrint('[ws_provider] LAN dial threw: $e');
      }
      guard.release(client.dispose);
      if (client.state == WsState.authenticated && guard.alive) {
        return _LanDial(client: client, endpoint: endpoint);
      }
      final err = client.lastConnectError;
      await client.dispose();
      if (err is WsPairingRejected) {
        return _LanDial(rejected: err, failure: err.message);
      }
    }
    return const _LanDial(failure: 'LAN endpoints failed');
  }

  /// 拨一条远程中继连接并验证 (对端 session.list 回包), **不碰 state / 监听器**。
  Future<_RelayDial> _dialRelayVerified(
    String desktopDeviceId,
    PairedDesktop paired,
    _DialGuard guard,
  ) async {
    if (!guard.alive) return const _RelayDial(failure: null);
    final relayKey = paired.relaySessionKey;
    if (relayKey == null || relayKey.isEmpty) {
      return _RelayDial(failure: tr('这台电脑需要重新连接'));
    }
    final remote = _ref.read(remoteLinkProvider);
    if (remote == null) {
      /* 没有远程能力的发行版: planRoute(loggedIn:false) 本来就不会选到远程,
       * 走到这里只可能是别处调用 —— 如实说连不了, 不假装在试。 */
      return _RelayDial(failure: tr('手机不在同一 Wi-Fi，暂时连不上这台电脑'));
    }
    final token = await _relayBearerToken(remote);
    final jwt = token.jwt;
    if (jwt == null) return _RelayDial(failure: token.error);
    if (!guard.alive) return const _RelayDial(failure: null);

    final phoneIdent = await _ref.read(phoneIdentityProvider.future);
    final client = remote.openRelay(
      RelayDialConfig(
        bearerJwt: jwt,
        phoneDeviceId: phoneIdent.deviceId,
        desktopDeviceId: desktopDeviceId,
        relaySessionKey: Uint8List.fromList(relayKey),
        reconnect: false,
        maxReconnectAttempts: 1,
        peerVerifyTimeout: kRelayPeerVerifyTimeout,
      ),
    );
    guard.onCancel(client.dispose);
    try {
      await client.connect();
    } catch (e) {
      debugPrint('[ws_provider] relay dial threw: $e');
    }
    guard.release(client.dispose);
    if (client.state == WsState.authenticated && guard.alive) {
      return _RelayDial(client: client);
    }
    final failure = client.lastFailureReason;
    await client.dispose();
    return _RelayDial(failure: failure);
  }

  /// 远程连接用的 access token —— 临期刷新 / 过期不发的口径在发行版的
  /// [RemoteLink.bearerToken] 里 (商业版: 刷新最多等 kConnectSideTaskCap, 过期又没
  /// 刷新成就不发, 把登录状态原样告诉用户)。
  Future<({String? jwt, String? error})> _relayBearerToken(RemoteLink remote) =>
      remote.bearerToken(alive: () => mounted);

  /// Neox Cloud agent 专用的远程连接 (真实电脑走 [_runRoute] 的拨号 + 接管)。
  ///
  /// 需要: 远程身份凭证 (见 [RemoteLink.bearerToken]) + relaySessionKey (配对时算好的
  /// X25519+HKDF 衍生 key, 已存 paired_desktops.relaySessionKey).
  Future<void> connectCloudRelay({
    required String desktopDeviceId,
    bool isCloudAgent = false,
  }) async {
    final remote = _ref.read(remoteLinkProvider);
    if (remote == null) {
      state = state.copyWith(
        connection: WsConnectionState.error,
        errorMessage: tr('请先登录账户后再远程连接'),
      );
      return;
    }
    /* JWT 临期/过期检测 — 同 [_relayBearerToken]: 刷新最多等 kConnectSideTaskCap,
     * 过期又没刷新成就不发, 把登录状态告诉用户 (2026-09-17, 原来照样发旧 token)。 */
    final token = await _relayBearerToken(remote);
    final effectiveJwt = token.jwt;
    if (effectiveJwt == null) {
      if (!mounted) return;
      state = state.copyWith(
        connection: WsConnectionState.error,
        errorMessage: token.error ?? tr('请先登录账户后再远程连接'),
      );
      return;
    }
    final db = _ref.read(appDatabaseProvider);
    /* 终端会话: 用那台电脑的配对行, 密钥换成派生给 CLI 的子密钥 */
    final cliRef = parseCliEndpointId(desktopDeviceId);
    final paired = await db.pairedDesktopsDao
        .findByDeviceId(cliRef?.desktopDeviceId ?? desktopDeviceId);
    if (paired == null) {
      state = state.copyWith(
        connection: WsConnectionState.error,
        errorMessage: tr('未找到这台电脑，请重新连接'),
      );
      return;
    }
    final pairingKey = paired.relaySessionKey;
    final relayKey = (cliRef != null && pairingKey != null && pairingKey.length == 32)
        ? await X25519Hkdf.instance.deriveCliEndpointKey(pairingKey)
        : pairingKey;
    if (relayKey == null || relayKey.isEmpty) {
      state = state.copyWith(
        connection: WsConnectionState.error,
        errorMessage: tr('这台电脑需要重新连接'),
      );
      return;
    }
    await _teardownClient();
    await _teardownCloudClient();

    state = state.copyWith(
      connection: WsConnectionState.connecting,
      transport: isCloudAgent ? WsTransport.cloudAgent : WsTransport.cloudRelay,
      activeDesktopDeviceId: desktopDeviceId,
      errorMessage: null,
    );

    final phoneIdent = await _ref.read(phoneIdentityProvider.future);
    final client = remote.openRelay(
      RelayDialConfig(
        bearerJwt: effectiveJwt,
        phoneDeviceId: phoneIdent.deviceId,
        desktopDeviceId: cliRef?.desktopDeviceId ?? desktopDeviceId,
        relaySessionKey: Uint8List.fromList(relayKey),
        targetEndpoint: cliRef?.endpoint,
        /* 掉线重连**不在这一层**: 真实电脑断线由上面的 _scheduleSmartReconnect 接管
         * (它会按当前网络重新选路: 同 Wi-Fi / 远程, 1/2/4s → 20s → 60s → 5min, 永不放弃)。
         * 客户端自己再重连一次等于两套机制同时拨号。 */
        reconnect: isCloudAgent,
        maxReconnectAttempts: isCloudAgent ? 3 : 1,
        /* 对端探测要跨 手机→relay→电脑→relay→手机 四段 (源站实测 210ms/段),
         * 再加电脑那头处理时间; 5s 在跨境链路上太紧, 给 8s。云端沙箱要冷启动, 仍是 15s。 */
        peerVerifyTimeout: isCloudAgent
            ? const Duration(seconds: 15)
            : const Duration(seconds: 8),
      ),
    );
    _cloudClient = client;
    _cloudEventsSub = client.events.listen((evt) => _handleEvent(evt, paired));
    await client.connect();
  }

  Future<void> _teardownCloudClient() async {
    /* 订阅是**连接级**的 — 连接没了, 之前订阅过什么就全部作废。
     * 不清的话重连后 ensureSubscribed 以为还订着, 直接放行发送, 又回到
     * "先发后订、丢开头那段事件" 的老问题上。 */
    _subscribedSessions.clear();
    final sub = _cloudEventsSub;
    final c = _cloudClient;
    _cloudEventsSub = null;
    _cloudClient = null;
    await sub?.cancel();
    await c?.dispose();
  }

  void _cancelSmartReconnect() {
    _smartReconnectTimer?.cancel();
    _smartReconnectTimer = null;
    _smartReconnectDeviceId = null;
    _smartReconnectAttempt = 0;
  }

  /// 等这台电脑的连接结果定局 (connected / error), 或者超时。
  ///
  /// 为什么需要它: `connectToDesktop` 返回时 WS 可能刚 dial 上, 认证还在路上 ——
  /// state 那一刻仍是 connecting。不等就判断, 会把"其实连上了"当成失败, 接着去连
  /// 下一台, 反而把刚建好的连接顶掉 (真机实测: "authenticated" 与 "没连上, 试下一台"
  /// 前后脚打印)。
  Future<void> _waitConnectionSettled(
    String desktopDeviceId, {
    Duration timeout = const Duration(seconds: 6),
  }) async {
    final deadline = DateTime.now().add(timeout);
    while (mounted && DateTime.now().isBefore(deadline)) {
      final s = state;
      if (s.activeDesktopDeviceId == desktopDeviceId) {
        if (s.connection == WsConnectionState.connected ||
            s.connection == WsConnectionState.error) {
          return;
        }
      } else if (s.connection == WsConnectionState.connected) {
        /* 已经连在别的机器上了 (比如 presence 推送触发的重连抢先成功) —— 也算定局 */
        return;
      }
      await Future<void>.delayed(const Duration(milliseconds: 120));
    }
  }

  /// 标记"这台此刻连不上" —— 设备列表据此显示黄色的「在线 · 连不上」。
  void _markUnreachable(String deviceId) {
    final cur = _ref.read(unreachableDesktopsProvider);
    if (cur.contains(deviceId)) return;
    _ref.read(unreachableDesktopsProvider.notifier).state = {...cur, deviceId};
  }

  /// 连上了就把黄标摘掉 —— 状态必须跟着事实走, 留着比不显示更误导。
  void _markReachable(String deviceId) {
    final cur = _ref.read(unreachableDesktopsProvider);
    if (!cur.contains(deviceId)) return;
    _ref.read(unreachableDesktopsProvider.notifier).state = {...cur}
      ..remove(deviceId);
  }

  /// 配对失效时自我修复一次。
  ///
  /// 依据: 两端登录同一个账号时, 云端有双方的 X25519 pubkey (各自 announce 上去的),
  /// 手机拿自己的私钥 × 电脑的公钥就能重新 ECDH 出 relay_session_key —— 这正是
  /// AutoPairService 平时干的事。所以"配对失效"在**已登录**的前提下根本不需要用户参与。
  ///
  /// 返回是否修好了 (以 relaySessionKey 真的变了为准, 不以"接口调用成功"为准 ——
  /// 后者在电脑那边还没 announce 新 pubkey 时会假成功, 然后重连再失败一次)。
  Future<bool> _tryRepairPairing(String desktopDeviceId) async {
    try {
      final remote = _ref.read(remoteLinkProvider);
      if (remote == null || !remote.signedIn) return false;
      final db = _ref.read(appDatabaseProvider);
      final before = (await db.pairedDesktopsDao.findByDeviceId(
        desktopDeviceId,
      ))?.relaySessionKey;
      await remote.initialPair();
      final after = (await db.pairedDesktopsDao.findByDeviceId(
        desktopDeviceId,
      ))?.relaySessionKey;
      if (after == null) return false;
      final changed =
          before == null ||
          before.length != after.length ||
          !_bytesEqual(before, after);
      return changed;
    } catch (e) {
      debugPrint('[ws_provider] 自动重新配对失败: $e');
      return false;
    }
  }

  static bool _bytesEqual(List<int> a, List<int> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }

  /// 两条路（同 Wi-Fi + 远程）都没走通之后的收尾。
  ///
  /// 关键是**不能就这么停住**：`_deferAutomaticLanReconnect` 现在试满快速档就放行去远程，
  /// 而远程可能因为没登录 / 没配对密钥 / 电脑没连中继而起不来。以前那种情况下 defer 会
  /// 顺手排下一次重试，现在放行了就没人排了 —— 不补这一手，用户回到家、电脑重新上线，
  /// 手机也不会自己回来，得手动点一下，等于把修好的问题换个形式又犯一遍。
  ///
  /// 2026-09-17: 用户触发的失败也排重试 (原来只有 automatic 才排, 于是用户在蜂窝下
  /// 点一次连接、远程抖一下, 就停在错误上不动了)。
  void _afterAllRoutesFailed(
    String desktopDeviceId, {
    required RoutePlan plan,
    String? detail,
  }) {
    if (!mounted) return;
    _scheduleSmartReconnect(
      desktopDeviceId,
      reason: detail ?? '${plan.kind.name} failed',
      plan: plan,
      detail: detail,
    );
  }

  void _resetSmartReconnect() {
    _smartReconnectTimer?.cancel();
    _smartReconnectTimer = null;
    _smartReconnectDeviceId = null;
    _smartReconnectAttempt = 0;
  }

  /// 一轮失败后排下一次。间隔见 connection_strategy.reconnectDelay:
  /// 走远程的 1/2/4s、只走 LAN 的 120/320/650ms, 之后 20s → 60s → 5min, 永不放弃。
  ///
  /// P0-1 修 (保留): 不再永久放弃。Codex 原版试 3 次就 stop, 健康连接遇一次稍长
  /// 抖动就被永久搁置, 桌面/网络恢复后也要手动点才回来。
  ///
  /// 2026-09-17: 状态栏文案按**这一轮实际走的路**写 (retryStatusMessage)。原来慢速档
  /// 一律写「同 Wi-Fi 暂时没有找到这台电脑」并把 transport 翻回 lan —— 用户在蜂窝上
  /// 远程连不上, 看到的却是在找 Wi-Fi。
  void _scheduleSmartReconnect(
    String desktopDeviceId, {
    String? reason,
    RoutePlan? plan,
    String? detail,
    bool dropped = false,
  }) {
    if (!mounted) return;
    if (state.activeDesktopDeviceId != desktopDeviceId) return;
    if (state.transport == WsTransport.cloudAgent) return;

    if (_smartReconnectDeviceId == desktopDeviceId) {
      _smartReconnectAttempt += 1;
    } else {
      _smartReconnectDeviceId = desktopDeviceId;
      _smartReconnectAttempt = 1;
    }
    final effectivePlan =
        plan ?? _lastPlan ?? const RoutePlan(RouteKind.raceLanFirst);
    final delay = reconnectDelay(
      attempt: _smartReconnectAttempt,
      foreground: _isForeground,
      relayInvolved: effectivePlan.usesRelay,
    );
    final slow = _smartReconnectAttempt > kReconnectFastAttempts;
    _smartReconnectTimer?.cancel();
    debugPrint(
      '[ws_provider] smart reconnect in ${_formatDelay(delay)} '
      'attempt=$_smartReconnectAttempt route=${effectivePlan.kind.name} '
      '${slow ? '(慢速档, foreground=$_isForeground) ' : ''}'
      'device=$desktopDeviceId${reason == null ? '' : ' ($reason)'}',
    );
    /* 快速档: error —— 横幅可见, 用户知道刚失败了、几秒后再试;
     * 慢速档 + 自动触发: disconnected —— 不在首页常驻报错 (设置页仍显示原因)。 */
    state = state.copyWith(
      connection:
          slow && _activeConnectTrigger == DesktopConnectTrigger.automatic
          ? WsConnectionState.disconnected
          : WsConnectionState.error,
      activeDesktopDeviceId: desktopDeviceId,
      errorMessage: retryStatusMessage(
        plan: effectivePlan,
        nextIn: delay,
        detail: detail,
        dropped: dropped,
      ),
    );
    _smartReconnectTimer = Timer(delay, () {
      if (!mounted) return;
      if (_smartReconnectDeviceId != desktopDeviceId) return;
      if (state.activeDesktopDeviceId != desktopDeviceId) return;
      if (state.connection == WsConnectionState.connected) return;
      unawaited(
        connectToDesktop(
          desktopDeviceId,
          trigger: DesktopConnectTrigger.automatic,
        ),
      );
    });
  }

  List<LanEndpoint> _collectLanEndpointCandidates(
    String desktopDeviceId,
    PairedDesktop paired,
    LocalNetworkProfile profile,
  ) {
    final candidates = <LanEndpoint>[];

    candidates.addAll(
      _ref.read(lanEndpointHintsProvider).forDevice(desktopDeviceId),
    );

    final scanner = _ref.read(mdnsScannerProvider);
    for (final beacon in scanner.current) {
      if (beacon.deviceId != desktopDeviceId) continue;
      candidates.add(
        LanEndpoint(
          host: beacon.host,
          port: beacon.port,
          source: LanEndpointSource.mdns,
        ),
      );
    }

    final cachedHost = paired.lastSeenLanIp;
    final cachedPort = paired.lastSeenLanPort;
    if (cachedHost != null && cachedPort != null) {
      candidates.add(
        LanEndpoint(
          host: cachedHost,
          port: cachedPort,
          source: LanEndpointSource.cache,
        ),
      );
    }

    return rankLanEndpoints(candidates, profile);
  }

  String _describeLanCandidates(
    List<LanEndpoint> candidates,
    LocalNetworkProfile profile,
  ) {
    return candidates
        .map(
          (e) =>
              '${e.host}:${e.port}/${e.sourceLabel}/affinity=${profile.affinity(e.host)}',
        )
        .join(', ');
  }

  Future<({List<LanEndpoint> ordered, bool hasReachable})>
  _orderLanCandidatesByProbe(List<LanEndpoint> candidates) async {
    if (candidates.isEmpty) {
      return (ordered: candidates, hasReachable: false);
    }
    final probed = await Future.wait(
      candidates.map((endpoint) async {
        final elapsedMs = await _probeLanEndpoint(endpoint);
        return (endpoint: endpoint, elapsedMs: elapsedMs);
      }),
    );
    final reachable = probed.where((p) => p.elapsedMs != null).toList()
      ..sort((a, b) => a.elapsedMs!.compareTo(b.elapsedMs!));
    if (reachable.isEmpty) {
      debugPrint('[ws_provider] LAN probe: no reachable exact endpoint');
      return (ordered: candidates, hasReachable: false);
    }

    final reachableKeys = reachable.map((p) => p.endpoint.key).toSet();
    final ordered = <LanEndpoint>[
      ...reachable.map((p) => p.endpoint),
      ...candidates.where((c) => !reachableKeys.contains(c.key)),
    ];
    debugPrint(
      '[ws_provider] LAN probe order: '
      '${reachable.map((p) => '${p.endpoint.host}:${p.endpoint.port}=${p.elapsedMs}ms').join(', ')}',
    );
    return (ordered: ordered, hasReachable: true);
  }

  Future<int?> _probeLanEndpoint(LanEndpoint endpoint) async {
    Socket? socket;
    final sw = Stopwatch()..start();
    try {
      socket = await Socket.connect(
        endpoint.host,
        endpoint.port,
        timeout: _kLanTcpProbeTimeout,
      );
      return sw.elapsedMilliseconds;
    } catch (_) {
      return null;
    } finally {
      sw.stop();
      socket?.destroy();
    }
  }

  /// mDNS rediscover — 启动 mDNS scanner (若没启动), 等 ≤1s 找匹配 deviceId 的 beacon.
  /// 找到 → 返 (host, port); 找不到 → 返 null (caller 用 drift 旧值兜底).
  /// 已有 currentHost 跟 mDNS 一致时立即返回, 不阻塞 connect 路径.
  Future<(String, int)?> _rediscoverLanEndpoint(
    String desktopDeviceId, {
    String? currentHost,
    int? currentPort,
    Duration timeout = _kLanRediscoverTimeout,
  }) async {
    final scanner = _ref.read(mdnsScannerProvider);
    try {
      await scanner.start(); // 重复 start 内部 no-op
    } catch (e) {
      debugPrint('[ws_provider] mdns start failed: $e');
      return null;
    }
    /* 先看 cache, 已有匹配且跟 currentHost 一致直接返 */
    for (final b in scanner.current) {
      if (b.deviceId == desktopDeviceId) {
        if (b.host == currentHost && b.port == currentPort) {
          return (b.host, b.port);
        }
        debugPrint(
          '[ws_provider] mdns cache hit: $desktopDeviceId @ ${b.host}:${b.port}',
        );
        return (b.host, b.port);
      }
    }
    /* cache 没有 → 最多等 1s 内。发现服务只负责优化, 不能成为主连接路径。 */
    final completer = Completer<(String, int)?>();
    late StreamSubscription<List<DesktopBeacon>> sub;
    final timer = Timer(timeout, () {
      if (!completer.isCompleted) {
        debugPrint(
          '[ws_provider] mdns timeout, no beacon for $desktopDeviceId',
        );
        completer.complete(null);
      }
    });
    sub = scanner.beacons.listen((beacons) {
      for (final b in beacons) {
        if (b.deviceId == desktopDeviceId) {
          if (!completer.isCompleted) {
            debugPrint(
              '[ws_provider] mdns rediscover: $desktopDeviceId @ ${b.host}:${b.port}',
            );
            completer.complete((b.host, b.port));
          }
          break;
        }
      }
    });
    final result = await completer.future;
    timer.cancel();
    await sub.cancel();
    return result;
  }

  /// 一条连接验证通过、刚被接管 (或 cloud agent 的连接认证成功) 之后的统一收尾。
  void _onTransportAuthenticated(PairedDesktop paired) {
    _cancelConnectingWatchdog();
    _resetSmartReconnect();
    _markReachable(paired.deviceId);
    state = state.copyWith(
      connection: WsConnectionState.connected,
      errorMessage: null,
    );
    // 更新 lastConnectedAt
    unawaited(
      _ref
          .read(appDatabaseProvider)
          .pairedDesktopsDao
          .updateLastConnected(
            paired.deviceId,
            DateTime.now().millisecondsSinceEpoch,
          ),
    );
    /* 关键: 连接成功后立刻拉全量 session 列表 (跨 workspace).
     * 之前 requestSessionList 被定义了但没人调, 导致 mobile 永远拉不到 desktop 的旧 session.
     * 现在每次连接都同步一遍, 用户换项目也立刻能看到所有 workspace 的会话. */
    unawaited(requestSessionList(limit: 1000));
    _reportPresence();
    /* WS 重连后自动 re-subscribe 当前 timeline 页的 session — 不做的话
     *  Desktop server 重连看到 0 subscriptions, 之后 SessionContext.onAppend
     *  都因为"无 subscriber" skip, 手机永远收不到事件. */
    final tid = state.activeTimelineSessionId;
    if (tid != null) {
      unawaited(_resubscribeAfterReconnect(tid));
    }
  }

  /// 只处理**当前接管着**的连接的事件 (接管时挂的监听已经核对过 identical)。
  ///
  /// 🔥 2026-06-24 transport mutex (保留): 任何时刻只有一条 active transport,
  /// 否则 server 同事件经两条 transport 各推一份 → UI 重复显示。
  /// 2026-09-17 起互斥在"接管"那一步完成 ([_adoptLan]/[_adoptRelay]), 这里不再
  /// 凭 state.transport 猜事件是哪条连接发来的 —— 赛跑时两条同时在拨, 猜必错。
  void _handleEvent(WsEvent evt, PairedDesktop paired) {
    if (evt is WsEventStateChanged) {
      /* 终端连接断了 (终端关了) 不按「电脑掉线」去重连那台电脑 —— 那是客户端的连接, 不是它 */
      final isRealDesktop = !isCloudAgentPairedDesktop(paired) &&
          !isCliEndpointId(state.activeDesktopDeviceId ?? '');
      switch (evt.state) {
        case WsState.disconnected:
        case WsState.failed:
          final friendly = evt.state == WsState.failed
              ? _friendlyConnectionError(evt.errorMessage)
              : tr('连接已断开');
          if (!isRealDesktop) {
            state = state.copyWith(
              connection: evt.state == WsState.failed
                  ? WsConnectionState.error
                  : WsConnectionState.disconnected,
              errorMessage: evt.state == WsState.failed ? friendly : null,
            );
            break;
          }
          /* 真实电脑: 这条连接已死 —— 先拆 (之后它再发什么都不会进来, 避免
           * failed + disconnected 连发把重试计数加两次), 再按当前网络重新选路。 */
          final wasLan = state.transport == WsTransport.lan;
          unawaited(wasLan ? _teardownClient() : _teardownCloudClient());
          debugPrint(
            '[ws_provider] ${wasLan ? 'LAN' : '远程'} 连接断了 '
            '(${evt.state.name}: ${evt.errorMessage}) → 排重连',
          );
          _scheduleSmartReconnect(
            paired.deviceId,
            reason: evt.errorMessage ?? 'transport ${evt.state.name}',
            detail: friendly,
            dropped: true,
          );
          break;
        case WsState.connecting:
        case WsState.reconnecting:
          state = state.copyWith(
            connection: WsConnectionState.connecting,
            errorMessage: evt.errorMessage,
          );
          break;
        case WsState.authenticated:
          _onTransportAuthenticated(paired);
          break;
      }
      return;
    }
    if (evt is WsEventMessage) {
      _handleMessage(evt.message, paired);
    }
  }

  void _handleMessage(RpcMessage msg, PairedDesktop paired) {
    final db = _ref.read(appDatabaseProvider);
    switch (msg.method) {
      case 'session.snapshot':
        final params = msg.params;
        if (params is Map<String, dynamic>) {
          final raw = params['sessions'];
          if (raw is List) {
            unawaited(
              _ingestDesktopSessionList(
                desktopDeviceId: paired.deviceId,
                rawSessions: raw,
                requestedLimit: (params['limit'] as int?) ?? 100,
                envelope: params,
              ),
            );
          }
        }
        break;
      case 'session.run_status':
        {
          /* 电脑上某条会话开跑 / 停下 / 等人 —— 没订阅它也要知道 (电脑页、侧栏) */
          final params = msg.params;
          if (params is Map<String, dynamic>) {
            final sid = params['session_id'] as String?;
            if (sid != null && sid.isNotEmpty) {
              _ref.read(desktopRunStatusProvider.notifier).set(sid, params['status'] as String?);
            }
          }
          break;
        }
      case 'session.mirror_changed':
        {
          final params = msg.params;
          if (params is Map<String, dynamic>) {
            final sid = params['session_id'] as String?;
            final policy = params['policy'] as String?;
            if (sid != null) _updateMirrorPolicy(sid, policy);
          }
          break;
        }
      case 'session.created':
        {
          /* Desktop 端新建 session → 推给所有已连 phone. drift 一处更新即可,
         *   sessions_page watch sessionMirrorDao 自然刷出新条目。 */
          final params = msg.params;
          if (params is Map<String, dynamic>) {
            final s = params['session'];
            if (s is Map<String, dynamic>) {
              final snap = SnapshotSession.fromJson(s);
              _updateMirrorPolicy(snap.id, snap.mirrorPolicy);
              unawaited(
                db.sessionMirrorDao.upsert(
                  SessionMirrorCompanion(
                    id: Value(snap.id),
                    desktopDeviceId: Value(paired.deviceId),
                    title: Value(snap.title),
                    workspaceName: Value(snap.workspaceName),
                    lastMessageAt: Value(snap.lastMessageAt),
                    createdAt: Value(DateTime.now().millisecondsSinceEpoch),
                    kind: Value(snap.kind),
                  ),
                ),
              );
            }
          }
          break;
        }
      case 'session.renamed':
        {
          final params = msg.params;
          if (params is Map<String, dynamic>) {
            final sid = params['session_id'] as String?;
            final title = params['title'] as String?;
            if (sid != null && sid.isNotEmpty && title != null) {
              unawaited(_applyLocalTitle(sid, title));
            }
          }
          break;
        }
      case 'session.deleted':
        {
          final params = msg.params;
          if (params is Map<String, dynamic>) {
            final sid = params['session_id'] as String?;
            if (sid != null && sid.isNotEmpty) {
              unawaited(
                _deleteLocalSessionData(sid, reason: 'desktop deleted'),
              );
            }
          }
          break;
        }
      case 'session.event':
        _routeSessionEvent(msg.params, paired, db);
        break;
      case 'life.reminder_fired':
        {
          /* 桌面 reminder 到点 (reminderJobRunner 第四通道) — 弹本地通知.
           * 事件名里的 life 是历史 wire 名, 提醒本身跟模式无关, 还在用. */
          final params = msg.params;
          if (params is Map<String, dynamic>) {
            final title = params['title'] as String?;
            if (title != null && title.isNotEmpty) {
              unawaited(
                LocalNotifications.showReminder(
                  title: title,
                  body: params['context'] as String?,
                ),
              );
            }
          }
          break;
        }
      /* 电脑上的 agent 让这台手机办事: 定闹钟 / 打电话 / 发短信 / 定位… (features/pilot/phone_exec.dart) */
      case 'phone.exec':
        if (msg.params is Map) {
          /* 写动作要验批准令牌: 配对通道的密钥就是 paired.relaySessionKey */
          unawaited(handlePhoneExec(
            Map<String, dynamic>.from(msg.params as Map),
            callDesktop,
            key: paired.relaySessionKey,
          ));
        }
        break;
      // system.ping 已在 WsClient 自动 pong
    }
  }

  /// session.event 总路由 — 拆出来防 _handleMessage 太长。
  ///
  /// 设计 (架构重构 2026-05-19): 所有 session.event 都喂给 timelineStateProvider,
  /// 它内部按 kind 分流: drift kind 直接写 drift (Stream 自动 apply);
  /// streaming kind 走 applyStreaming 写内存. TimelineState 是 ONE in-memory
  /// list per session, 跟 Desktop timelineEvents 同款架构。
  void _routeSessionEvent(
    dynamic params,
    PairedDesktop paired,
    AppDatabase db,
  ) {
    if (params is! Map<String, dynamic>) return;
    final sessionId = params['session_id'] as String?;
    final seq = params['seq'];
    final ts = params['ts'];
    final kind = params['kind'] as String?;
    final payload = params['payload'];
    if (sessionId == null || kind == null) return;

    /* 🔥 2026-06-24 真因 fix: LAN ws + cloud relay 同时 active 时,
     *   server 把同一条 session.event 通过两条 transport 各推一份, mobile 收 2 次
     *   → insertEvent 入不同 seq → DB 双写 → UI 显 2 条 (user 报"消息重复").
     *   修法: 入口按 (sessionId, kind, ts, content-hash) 去重, 5 秒窗口.
     *   两条 transport 推同事件几乎同瞬到达 (RTT 差 < 1s),5s 窗口安全合并. */
    final dedupKey = _eventDedupKey(sessionId, kind, ts, payload);
    if (dedupKey != null) {
      final now = DateTime.now().millisecondsSinceEpoch;
      _eventDedupCache.removeWhere((_, t) => now - t > 5000);
      if (_eventDedupCache.containsKey(dedupKey)) {
        return; /* 已 routing 过, 这次是 dup transport echo */
      }
      _eventDedupCache[dedupKey] = now;
    }

    final p = payload is Map<String, dynamic>
        ? payload
        : const <String, dynamic>{};

    /* 1. approval / ask_user 走独立 provider — 不进 TimelineState */
    if (kind == 'approval_needed') {
      final reqId = (p['request_id'] as String?) ?? '';
      if (reqId.isEmpty) return;
      final toolName = (p['tool_name'] as String?) ?? 'tool';
      _ref
          .read(pendingApprovalsProvider.notifier)
          .add(
            sessionId,
            PendingApproval(
              requestId: reqId,
              toolName: toolName,
              args: (p['args'] is Map<String, dynamic>)
                  ? p['args'] as Map<String, dynamic>
                  : <String, dynamic>{},
              reason: (p['reason'] as String?) ?? '',
              allowRemember: p['allow_remember'] == true,
            ),
          );
      /* 后台时弹本地通知 — agent 卡审批不批就停着, 这是最高价值提醒 */
      _ref.read(agentNotifierProvider).approvalNeeded(sessionId, toolName);
      return;
    }
    if (kind == 'approval_cancelled') {
      final reqId = (p['request_id'] as String?) ?? '';
      if (reqId.isNotEmpty) {
        _ref.read(pendingApprovalsProvider.notifier).remove(sessionId, reqId);
      }
      return;
    }
    if (kind == 'ask_user_needed') {
      final reqId = _stringValue(p['request_id'] ?? p['requestId']).trim();
      if (reqId.isEmpty) return;
      final questions = _parseAskUserQuestions(p['questions']);
      if (questions.isEmpty) return;
      _ref
          .read(pendingAskUsersProvider.notifier)
          .add(
            sessionId,
            PendingAskUser(
              requestId: reqId,
              questions: questions,
              turnId: _optionalString(p['turn_id'] ?? p['turnId']),
            ),
          );
      _ref
          .read(agentNotifierProvider)
          .askUserNeeded(sessionId, questions.first.question);
      return;
    }
    /* ask_user 超时 — desktop PermissionManager 过期后推, 手机把对应卡撤掉
     * (2026-07-20 kind 面核对补漏: 之前 default 落 drift 变垃圾行且卡片永挂) */
    if (kind == 'ask_user_expired') {
      final reqId = _stringValue(p['request_id'] ?? p['requestId']).trim();
      if (reqId.isNotEmpty) {
        _ref.read(pendingAskUsersProvider.notifier).remove(sessionId, reqId);
      }
      return;
    }
    /* 电脑终端里先答了 — 卡片翻成「已答」并显示答案, 而不是等到 tool_done 才消失
     * (2026-10-18 终端 Ink 选择框撤销的配套事件) */
    if (kind == 'ask_user_answered') {
      final reqId = _stringValue(p['request_id'] ?? p['requestId']).trim();
      if (reqId.isNotEmpty) {
        _ref
            .read(pendingAskUsersProvider.notifier)
            .answered(sessionId, reqId, _parseAskUserAnswers(p['answers']));
      }
      return;
    }
    /* ask_user 工具出结果 = 问题已经答了 (不管在哪答的)。老版本电脑不发 ask_user_expired,
     * 靠这条把卡撤掉 (2026-09-30 「确认已生效, 卡片还在」)。不 return: 事件照常往下走。 */
    if ((kind == 'tool_done' || kind == 'tool_result') &&
        _stringValue(p['tool_name'] ?? p['toolName']) == 'ask_user') {
      _ref.read(pendingAskUsersProvider.notifier).clearSession(sessionId);
    }

    /* M2 接力 — run_state_changed 是 server 推的状态机变化, 走专用 channel */
    if (kind == 'run_state_changed') {
      _ref
          .read(timelineStateProvider(sessionId).notifier)
          .applyRunStateChange(p);
      return;
    }
    /* context_usage — desktop token_usage 透传, 更新 sessionContextProvider 的实时占用 */
    if (kind == 'context_usage') {
      final tokens = (p['context_tokens'] is num)
          ? (p['context_tokens'] as num).toInt()
          : 0;
      _ref
          .read(sessionContextProvider(sessionId).notifier)
          .onContextUsage(tokens);
      return;
    }
    if (kind == 'metrics') {
      final tokens = (p['context_used'] is num)
          ? (p['context_used'] as num).toInt()
          : (p['context_tokens'] is num)
          ? (p['context_tokens'] as num).toInt()
          : 0;
      _ref
          .read(sessionContextProvider(sessionId).notifier)
          .onContextUsage(tokens);
      return;
    }
    if (kind == 'shell_output_stream' ||
        kind == 'edit_file_stream' ||
        kind == 'write_file_stream' ||
        kind == 'file_stream') {
      final toolId = _stringValue(
        p['tool_call_id'] ?? p['tool_id'] ?? p['toolId'],
      ).trim();
      final chunk = _stringValue(
        p['output_delta'] ??
            p['output'] ??
            p['content'] ??
            p['new_string_partial'] ??
            p['new_string'],
      );
      if (toolId.isNotEmpty && chunk.isNotEmpty) {
        _ref
            .read(timelineStateProvider(sessionId).notifier)
            .applyStreaming('tool_progress', {
              'tool_call_id': toolId,
              'chunk': chunk,
              'turn_id':
                  _optionalString(p['turn_id'] ?? p['turnId']) ?? 'default',
            });
      }
      return;
    }
    /* session_title_changed — side-agent 生成标题后 desktop bus.publish 透传过来,
     * 更新 sessionMirror.title + timeline_page header 立即跟着改, 不靠 fetchSessionInfo 轮询. */
    if (kind == 'session_title_changed') {
      final title = (p['title'] as String?) ?? '';
      if (title.isNotEmpty) {
        unawaited(
          db.sessionMirrorDao.upsert(
            SessionMirrorCompanion(
              id: Value(sessionId),
              desktopDeviceId: Value(paired.deviceId),
              title: Value(title),
              createdAt: Value(DateTime.now().millisecondsSinceEpoch),
            ),
          ),
        );
      }
      return;
    }

    /* 2. streaming kinds — 不入 drift, 直接 applyStreaming 到 TimelineState */
    const streamingKinds = {
      'agent_text_delta',
      'agent_text_done',
      'agent_thinking_delta',
      'agent_thinking_done',
      'tool_running',
      'tool_done',
      'tool_progress',
      'agent_turn_done',
      'session_interrupted',
      /* v1.1 timeline 对齐桌面 — plan/子代理/压缩/checkpoint/重试 */
      'plan_update',
      'subagent_started',
      'subagent_done',
      'subagent_progress',
      'context_compaction',
      'checkpoint',
      'stream_retry',
      'stream_recovered',
    };
    if (streamingKinds.contains(kind)) {
      /* turn 收尾通知 — 只在这轮真跑过 (agentRunning) 才提醒, 防 subscribe
       * 补发的历史 turn_done 在后台轰炸 */
      if (kind == 'agent_turn_done' &&
          _ref.read(timelineStateProvider(sessionId)).agentRunning) {
        unawaited(_notifyTurnDone(sessionId, db));
        /* 后台保活只为"任务在跑"; 跑完就撤, 通知栏别一直挂着 */
        if (!_isForeground) unawaited(KeepAliveService.stop());
      }
      _ref
          .read(timelineStateProvider(sessionId).notifier)
          .applyStreaming(kind, p);
      /* sub-agent 起来/跑完 → 桌面那边刚新建/更新了一条子会话, 拉一次列表让抽屉
       * 的嵌套子节点跟上。debounce 过, 一轮派 5 个 agent 也只拉一次。 */
      if (kind == 'subagent_started' || kind == 'subagent_done') {
        _scheduleSessionListRefresh();
      }
      if (kind == 'session_interrupted') {
        _ref.read(pendingApprovalsProvider.notifier).clearSession(sessionId);
        _ref.read(pendingAskUsersProvider.notifier).clearSession(sessionId);
      }
      return;
    }

    /* 3. drift kinds — 写 drift. TimelineStateController 内部 watch 自动 apply。
     *   user_message / agent_text / agent_thinking / tool_call / tool_result / ... */
    if (seq is! int || ts is! int) return;
    /* seq 空洞自愈 —— 收到的 seq 比预期跳了号, 说明中间那段没到手.
     *
     * "先订阅后发送" 堵住了已知的那条竞态, 但丢事件的窗口不止一个 (传输切换、
     * 半开连接恢复、桌面那边补发边界算错都可能跳号), 而空洞是**不会自愈**的:
     * 事件按 seq 幂等入库, 洞留在那儿, UI 上就是缺一段, 而且完全无声。
     * 这里一发现跳号就回补, 让"完整"变成能自我维持的性质, 而不是靠每条路径
     * 都不出错。 */
    _detectAndFillSeqGap(sessionId, seq);
    final insertFut = db.sessionEventsDao.insertEvent(
      SessionEventsCompanion(
        sessionId: Value(sessionId),
        seq: Value(seq),
        ts: Value(ts),
        kind: Value(kind),
        payload: Value(jsonEncode(payload)),
      ),
    );
    if (kind == 'user_message') {
      /* 占位**必须等持久那份真的落库之后**再清.
       *
       * 原来是 unawaited 入库 + 立刻清占位, 两件事没有先后保证。实测的后果:
       * 用户发出去的气泡显示 70ms 就消失了 —— 清占位跑了, 入库那个 future 却
       * 没成 (unawaited, 异常被吞), 于是唯一可见的那份没了, 持久的那份也没有,
       * 你发的话在屏幕上凭空蒸发, 全程零报错。
       *
       * 现在顺序反过来: 先确认 drift 里有了, 再撤掉占位。入库失败就**保留**
       * 占位 —— 宁可短暂多显示一条 (timeline 本来就按 message_id / 文本+5s
       * 窗口去重), 也不能让用户看着自己说的话消失。 */
      unawaited(
        insertFut
            .then((_) {
              _ref
                  .read(streamBufferProvider.notifier)
                  .clearPendingUserText(sessionId);
            })
            .catchError((Object e) {
              debugPrint('[ws_provider] user_message 入库失败, 保留占位: $e');
            }),
      );
    } else {
      unawaited(insertFut);
    }
    if (kind == 'session_error') {
      final reason = _stringValue(p['message'] ?? p['error'] ?? p['text']);
      _ref.read(agentNotifierProvider).sessionError(sessionId, reason);
    }
    unawaited(db.sessionMirrorDao.updateLastSeq(sessionId, seq, ts));
  }

  Future<void> _notifyTurnDone(String sessionId, AppDatabase db) async {
    try {
      final mirror = await db.sessionMirrorDao.findById(sessionId);
      _ref
          .read(agentNotifierProvider)
          .turnDone(sessionId, sessionTitle: mirror?.title);
    } catch (_) {
      _ref.read(agentNotifierProvider).turnDone(sessionId);
    }
  }

  /// 电脑端答复的 ask_user 答案: {问题: 选项/文本} — 只留非空项
  Map<String, String> _parseAskUserAnswers(dynamic raw) {
    final m = _asStringMap(raw);
    if (m == null) return const {};
    final answers = <String, String>{};
    m.forEach((question, answer) {
      final q = question.trim();
      final a = _stringValue(answer).trim();
      if (q.isNotEmpty && a.isNotEmpty) answers[q] = a;
    });
    return answers;
  }

  List<PendingAskUserQuestion> _parseAskUserQuestions(dynamic raw) {
    if (raw is! List) return const [];
    final questions = <PendingAskUserQuestion>[];
    for (final item in raw) {
      final q = _parseAskUserQuestion(item);
      if (q != null) questions.add(q);
    }
    return questions;
  }

  PendingAskUserQuestion? _parseAskUserQuestion(dynamic raw) {
    if (raw is String) {
      final question = raw.trim();
      if (question.isEmpty) return null;
      return PendingAskUserQuestion(
        question: question,
        options: const [],
        multiSelect: false,
      );
    }
    final m = _asStringMap(raw);
    if (m == null) return null;
    final question = _stringValue(
      m['question'] ?? m['text'] ?? m['label'] ?? m['title'],
    ).trim();
    if (question.isEmpty) return null;
    return PendingAskUserQuestion(
      question: question,
      options: _parseAskUserOptions(m['options']),
      multiSelect:
          m['multiSelect'] == true ||
          m['multi_select'] == true ||
          m['multiple'] == true,
    );
  }

  List<PendingAskUserOption> _parseAskUserOptions(dynamic raw) {
    if (raw is! List) return const [];
    final seen = <String>{};
    final options = <PendingAskUserOption>[];
    for (final item in raw) {
      String label = '';
      String? description;
      if (item is String) {
        label = item.trim();
      } else {
        final m = _asStringMap(item);
        if (m == null) continue;
        label = _stringValue(
          m['label'] ?? m['value'] ?? m['title'] ?? m['text'],
        ).trim();
        final desc = _stringValue(m['description'] ?? m['desc']).trim();
        if (desc.isNotEmpty) description = desc;
      }
      if (label.isEmpty || !seen.add(label)) continue;
      options.add(PendingAskUserOption(label: label, description: description));
    }
    return options;
  }

  Map<String, dynamic>? _asStringMap(dynamic raw) {
    if (raw is Map<String, dynamic>) return raw;
    if (raw is Map) {
      return raw.map((key, value) => MapEntry('$key', value));
    }
    return null;
  }

  String _stringValue(dynamic raw) {
    if (raw == null) return '';
    if (raw is String) return raw;
    return '$raw';
  }

  String? _optionalString(dynamic raw) {
    final v = _stringValue(raw).trim();
    return v.isEmpty ? null : v;
  }

  /// 订阅某 session 实时事件 — 薄封装, 完整投影附着请用 [attachOrCatchUp].
  Future<void> subscribeSession(String sessionId, {int sinceSeq = 0}) async {
    await attachOrCatchUp(sessionId, sinceSeq: sinceSeq);
  }

  /// 进行中的 attach — 同一 session 并发调用复用同一个 future.
  ///
  /// 发消息前要等订阅真正就位 (见 [ensureSubscribed]), 而进页也在 attach,
  /// 两边撞上时不能各订阅一次, 更不能各等各的。
  final Map<String, Future<void>> _attachInFlight = <String, Future<void>>{};

  /// 每条 session 最近应用到的 seq — 用来发现 live 事件跳号.
  final Map<String, int> _lastLiveSeq = <String, int>{};
  final Set<String> _gapFillInFlight = <String>{};

  /// 发现 seq 空洞就回补一页 history.
  ///
  /// 只在**已有基准**时判断: 一条 session 的第一条 live 事件没有前序可比,
  /// 那种情况归 attachOrCatchUp 的 latest_seq 补发管。
  void _detectAndFillSeqGap(String sessionId, int seq) {
    final prev = _lastLiveSeq[sessionId];
    if (prev == null || seq > prev) _lastLiveSeq[sessionId] = seq;
    if (prev == null || seq <= prev + 1) return;
    if (!_gapFillInFlight.add(sessionId)) return;
    debugPrint('[ws_provider] seq 跳号 $prev → $seq, 回补 history');
    unawaited(
      fetchSessionHistory(sessionId, beforeSeq: seq)
          .catchError((Object e) {
            debugPrint('[ws_provider] 空洞回补失败: $e');
            /* 回补失败不影响这条事件本身入库 —— 下次跳号还会再试 */
            return const HistoryPage.failed();
          })
          .whenComplete(() {
            _gapFillInFlight.remove(sessionId);
          }),
    );
  }

  /// 当前连接上已经订阅过的 session — 断线/换传输时清空.
  ///
  /// 桌面对**重复**的 session.subscribe 不回复, 再订阅一次就是一个永远不 complete
  /// 的 future; 发送前若去等它, 整个发送就无声地挂死 (按钮一直转圈)。
  final Set<String> _subscribedSessions = <String>{};

  /// 等订阅就位的上限. 超时就照发不误 —— 丢一段事件有 seq 空洞自愈兜底,
  /// 而卡住发送是用户当场就能感觉到的坏体验, 两害相权取轻。
  static const Duration _kEnsureSubscribedBudget = Duration(seconds: 3);

  /// 确保这条 session 的订阅**已经就位**再返回.
  ///
  /// 发消息前必须过这一道。桌面收到 session.input 会立刻开始吐事件, 如果订阅
  /// 还没登记上, 那段事件就永远收不到了 —— 而这恰恰是最要紧的一段 (用户自己
  /// 那条 user_message 回显 + agent 开头的输出)。
  Future<void> ensureSubscribed(String sessionId) async {
    if (_subscribedSessions.contains(sessionId)) return;
    final fut = _attachInFlight[sessionId] ?? attachOrCatchUp(sessionId);
    try {
      await fut.timeout(_kEnsureSubscribedBudget);
    } on TimeoutException {
      debugPrint('[ws_provider] ensureSubscribed 超时, 照发不误 ($sessionId)');
      _retrySubscribeInBackground(sessionId, tr('订阅超时'));
    } catch (e) {
      debugPrint('[ws_provider] ensureSubscribed 失败, 照发不误: $e');
      _retrySubscribeInBackground(sessionId, tr('订阅失败: $e'));
    }
  }

  /// 订阅没成时在后台接着补 —— "照发不误"只解决了发出去，没解决**收得回来**。
  ///
  /// 真机实录 (2026-09-03): 手机上新建会话后发第一条消息，日志是
  ///   `ensureSubscribed 超时, 照发不误` → `session.input ok`
  /// 消息确实到了桌面，但订阅从此再没重试过。而桌面推事件走的是
  /// `sendToSessionSubscribers` —— **只发给订阅者**，没订上就等于没人接。
  /// 用户看到的是"我发的消息被吞掉了，界面上什么都没有"。
  ///
  /// 所以超时之后必须继续订，订上再补一次 history 把这期间错过的事件拉回来。
  /// 退避重试而不是死循环: 桌面真没起来时不该每秒打一发。
  void _retrySubscribeInBackground(String sessionId, String reason) {
    if (_subscribeRetryInFlight.contains(sessionId)) return;
    _subscribeRetryInFlight.add(sessionId);
    unawaited(() async {
      try {
        for (var attempt = 1; attempt <= 5; attempt++) {
          await Future<void>.delayed(Duration(milliseconds: 400 * attempt));
          if (!mounted) return;
          if (_subscribedSessions.contains(sessionId)) return;
          if (state.connection != WsConnectionState.connected) continue;
          debugPrint('[ws_provider] 后台补订阅 $sessionId (第 $attempt 次, $reason)');
          try {
            await attachOrCatchUp(
              sessionId,
            ).timeout(const Duration(seconds: 8));
          } catch (_) {
            /* 下一轮再试 */
          }
          if (_subscribedSessions.contains(sessionId)) {
            debugPrint('[ws_provider] 补订阅成功 $sessionId, 已补拉历史');
            return;
          }
        }
        debugPrint('[ws_provider] 补订阅 5 次仍未成功 $sessionId');
      } finally {
        _subscribeRetryInFlight.remove(sessionId);
      }
    }());
  }

  final Set<String> _subscribeRetryInFlight = <String>{};

  /// Projector attach / catch-up / live — 进页、重连、回前台、传输静默共用.
  ///
  /// 1. session.subscribe → ExecutionState + latest_seq + pending/ui 快照
  /// 2. 若 latest_seq > localMax → session.history 补 EntryLog 缺口
  /// 3. 继续收 live fan-out
  /// 终端会话跟客户端会话在同一台电脑上、但走不同连接 (2026-10-17): 用户**打开**或**发话**的那条会话,
  /// 当前连着的不是它的主人就先换过去。只管跟终端有关的切换 —— 多台电脑之间的老逻辑不动。
  /// 不放进 attachOrCatchUp: 重连后的后台补订阅也走那里, 会把刚换到终端的连接又拉回上一条会话的主人 (模拟器实测)。
  Future<void> ensureConnectedToSessionOwner(String sessionId) async {
    final mirror = await _ref.read(appDatabaseProvider).sessionMirrorDao.findById(sessionId);
    if (mirror == null || isPhoneLocalDeviceId(mirror.desktopDeviceId)) return;
    final owner = mirror.desktopDeviceId;
    final active = state.activeDesktopDeviceId ?? '';
    if (owner == active && state.connection == WsConnectionState.connected) return;
    if (!isCliEndpointId(owner) && !isCliEndpointId(active)) return;
    await connectToDesktop(owner);
    await _waitConnectionSettled(owner, timeout: const Duration(seconds: 12));
  }

  Future<void> attachOrCatchUp(String sessionId, {int? sinceSeq}) {
    final existing = _attachInFlight[sessionId];
    if (existing != null) return existing;
    final fut = _attachOrCatchUpInner(
      sessionId,
      sinceSeq: sinceSeq,
    /* 块体 {}: 写成 `=> _attachInFlight.remove(id)` 会把 fut 自己当返回值, whenComplete 等它 =
     * 等自己, fut 永远完不成、也永远不从表里删 —— 这个会话之后每次 attach 都拿到这个死掉的 fut */
    ).whenComplete(() {
      _attachInFlight.remove(sessionId);
    });
    _attachInFlight[sessionId] = fut;
    return fut;
  }

  /// 同一会话同一时刻只补一次历史 —— attach 可能被连着调好几次 (进页/回前台/重连).
  final Set<String> _catchUpInFlight = <String>{};

  /// 逐页往回补 EntryLog 缺口. 不阻塞 attach, 失败只记日志 (live 事件照常进来).
  Future<void> _catchUpHistoryInBackground(
    String sessionId,
    int localMax,
    int? latest,
  ) async {
    if (!_catchUpInFlight.add(sessionId)) return;
    debugPrint(
      '[ws_provider] EntryLog catch-up (后台) localMax=$localMax '
      'latest_seq=$latest → history',
    );
    final status = _ref.read(historyLoadStatusProvider(sessionId).notifier);
    status.set(HistoryLoadPhase.loading);
    var failed = false;
    try {
      var cursor = 0x7fffffff;
      for (var page = 0; page < _kCatchUpMaxPages; page++) {
        var r = await fetchSessionHistory(sessionId, beforeSeq: cursor);
        /* 一页失败先别放弃 (2026-10-12 用户: 长会话「突然加载不了」—— 那一刻电脑在给 48 万 token 的
         * 上下文做压缩, 主进程忙, 这一页超时, 原来就整个停下)。同一页缩小再试两次, 中间等一等。 */
        for (final (i, smaller) in const [60, 20].indexed) {
          if (!r.failed || !mounted) break;
          await Future<void>.delayed(Duration(seconds: 2 + i * 3));
          if (state.connection != WsConnectionState.connected) break;
          debugPrint('[ws_provider] history page retry ${i + 1} (limit=$smaller) $sessionId');
          r = await fetchSessionHistory(sessionId, beforeSeq: cursor, limit: smaller);
        }
        /* 拉失败**不能**当成"没更多了" —— 那是这一类"历史加载不出来"的根源:
         * 界面拿不到任何信号, 显示的是「还没有消息」。 */
        if (r.failed) {
          failed = true;
          break;
        }
        if (r.reachedEnd) break; // 真的没更多了
        if (r.minSeqSeen <= localMax + 1) break; // 接上本地了
        cursor = r.minSeqSeen;
        if (page == _kCatchUpMaxPages - 1) {
          debugPrint(
            '[ws_provider] catch-up page cap hit, gap '
            '$localMax..${r.minSeqSeen} left for scroll-up paging',
          );
        }
      }
    } catch (e) {
      debugPrint('[ws_provider] catch-up history failed: $e');
      failed = true;
    } finally {
      _catchUpInFlight.remove(sessionId);
      status.set(failed ? HistoryLoadPhase.failed : HistoryLoadPhase.ok);
    }
  }

  Future<void> _attachOrCatchUpInner(String sessionId, {int? sinceSeq}) async {
    state = state.copyWith(activeTimelineSessionId: sessionId);
    final status = _ref.read(historyLoadStatusProvider(sessionId).notifier);
    final dynamic c = _activeClient;
    if (c == null) {
      debugPrint('[ws_provider] attachOrCatchUp: no active client');
      status.set(HistoryLoadPhase.failed);
      return;
    }
    final db = _ref.read(appDatabaseProvider);
    /* 这条会话是不是**这台**电脑的?
     *
     * 手机的会话列表来自云端索引, 里面有那些当前没连着的电脑的会话
     * (session_index_sync 按 desktopDeviceId 存)。打开这样一条会话时, 我们照样
     * 去问当前连着的那台 —— 它不认识这个 id, 于是 subscribe 回 latest_seq:0、
     * history 回空数组 (都不报错, 见桌面 getSessionHistory), 手机把它当成
     * "空会话", 界面写「还没有消息」。用户的判词就是"历史会话无法加载"。
     *
     * 现在先比一下属主: 不是同一台就别问了, 直接说清楚它在哪台机器上。 */
    final mirror = await db.sessionMirrorDao.findById(sessionId);
    final owner = mirror?.desktopDeviceId;
    /* 手机本地会话不归任何电脑管: 问电脑只会拿回一个「idle / 空历史」, 把正在跑的那轮盖掉 */
    if (isPhoneLocalDeviceId(owner)) {
      status.set(HistoryLoadPhase.idle);
      return;
    }
    final activeDesktop = state.activeDesktopDeviceId;
    if (owner != null &&
        owner.isNotEmpty &&
        !isPhoneLocalDeviceId(owner) &&
        activeDesktop != null &&
        activeDesktop.isNotEmpty &&
        owner != activeDesktop &&
        state.transport != WsTransport.cloudAgent) {
      final name = (await db.pairedDesktopsDao.findByDeviceId(owner))
          ?.deviceName
          ?.trim();
      debugPrint(
        '[ws_provider] session $sessionId 属于 $owner, 当前连的是 $activeDesktop '
        '→ 不问这台要历史',
      );
      status.set(
        HistoryLoadPhase.otherDesktop,
        desktopName: (name != null && name.isNotEmpty) ? name : null,
      );
      return;
    }
    final localMax = await db.sessionEventsDao.getMaxSeq(sessionId) ?? 0;
    /* 给跳号检测一个基准 —— 有了它, attach 之后的第一条 live 事件就能判断
     * 中间是不是漏了, 而不用等第二条才有得比。 */
    if (localMax > 0) _lastLiveSeq[sessionId] = localMax;
    final seqHint = sinceSeq ?? (localMax + 1);
    try {
      final resp = await c.sendRequest('session.subscribe', {
        'session_id': sessionId,
        'since_seq': seqHint,
      });
      debugPrint('[ws_provider] attachOrCatchUp subscribe ok: ${resp.result}');
      _subscribedSessions.add(sessionId);
      _applyRunStateFromSubscribe(sessionId, resp.result);
      _applyPendingActionsFromSubscribe(sessionId, resp.result);
      _applyUiStateFromSubscribe(sessionId, resp.result);
      _applyStreamingStateFromSubscribe(sessionId, resp.result);
      /* EntryLog gap-fill — subscribe 不重放 seq, 靠 latest_seq 契约补 history.
       * 多页回填: 差量 > 单页 limit 时 (桌面跑了一晚), 单页只含最新一段,
       * localMax..页首之间会留永久空洞 (幂等按 seq 入库, 洞不会自愈).
       * 从最新往回逐页拉直到接上 localMax, 封顶 _kCatchUpMaxPages 页. */
      final resultMap = _asStringMap(resp.result);
      final latestRaw = resultMap?['latest_seq'] ?? resultMap?['latestSeq'];
      final latest = latestRaw is int
          ? latestRaw
          : latestRaw is num
          ? latestRaw.toInt()
          : null;
      /* localMax == 0 时**无条件**拉一页 history.
       *
       * seq 从 0 起算, 而 0 同时被拿来表示"我本地什么都没有" —— 这两个含义撞在
       * 一起, 于是 `latest > localMax` 在最要紧的那一刻恰好不成立:
       *   桌面 injectUserMessage 给用户消息分的就是 seq=0, 而 subscribe 那一刻
       *   last_committed_seq 还是 null, latest_seq 报 0。手机 localMax 也是 0,
       *   0 > 0 为假 → 补发不触发; subscribe 本身又不重放 (契约如此)。
       *   结果: **用户自己发的那条消息永远取不回来**, 而且完全无声。
       *   真机实录: 会话里只剩一条 seq=3 的 agent_text, 用户在手机上看不到自己
       *   刚说了什么, agent 开头那段输出也一起没了。
       *
       * 本地为空时我们根本没有能力区分"这会话真是空的"和"我落后了", 而空会话
       * 拉一页 history 的代价可以忽略。用一次廉价的请求换掉一整类静默丢数据。 */
      /* history 补洞**不挡**这次 attach 完成 (2026-09-17 用户: 远程连接速度上不去)。
       *
       * 订阅一旦回来, "能收到事件"这件事就成立了 —— 而发消息只需要订阅成立
       * (见 ensureSubscribed)。补历史是另一件事: 每页一个来回, 远程一个来回 0.4~0.8s
       * (relay 在境外, 本机实测到源站 210ms), 最多 5 页就是好几秒, 而这几秒**全压在
       * 用户按下发送之后**。同 Wi-Fi 时一页十几毫秒, 所以只有远程才显得慢。
       * 现在补历史在后台跑, 补到的事件照常进库、照常渲染。 */
      if (localMax == 0 || (latest != null && latest > localMax)) {
        unawaited(_catchUpHistoryInBackground(sessionId, localMax, latest));
      } else {
        /* 不需要补 = 本地已经是全的, 这也是一个明确的"成功" */
        status.set(HistoryLoadPhase.ok);
      }
    } catch (e) {
      debugPrint('[ws_provider] attachOrCatchUp failed: $e');
      if (_isSessionNotFoundError(e)) {
        await _deleteLocalSessionData(
          sessionId,
          reason: 'subscribe not found',
          transient: true,
        );
        status.set(HistoryLoadPhase.failed);
        return;
      }
      if (e is TimeoutException || e is StateError) _markTransportFailed(e);
      status.set(HistoryLoadPhase.failed);
    }
  }

  /// session.subscribe attach 快照里的 ExecutionState — 权威忙闲.
  /// live run_state_changed / agent_turn_done 是 best-effort; 本快照闭合失联.
  void _applyRunStateFromSubscribe(String sessionId, dynamic result) {
    final resultMap = _asStringMap(result);
    if (resultMap == null) return;
    final rs = _asStringMap(resultMap['run_state']);
    if (rs == null) return;
    _ref.read(timelineStateProvider(sessionId).notifier).applyExecution(rs);
  }

  /// session.subscribe 的 ui_state 快照 (v1.1) — plan + 活跃子代理.
  /// streaming plan_update / subagent_started 是 best-effort, 断线期间丢的
  /// 靠这条一次性恢复.
  void _applyUiStateFromSubscribe(String sessionId, dynamic result) {
    final resultMap = _asStringMap(result);
    if (resultMap == null) return;
    final uiState = _asStringMap(resultMap['ui_state']);
    if (uiState == null) return;
    _ref
        .read(timelineStateProvider(sessionId).notifier)
        .applyUiStateSnapshot(uiState);
  }

  /// session.subscribe 的 streaming_state 快照 (v1.3) — mid-stream attach.
  /// 一轮进行中才订阅/重连时, 本轮已流出的半成品正文/思考/在跑工具在这里
  /// 一次性 REPLACE 进 timeline, 不再"状态条说在跑、正文却空白"。
  void _applyStreamingStateFromSubscribe(String sessionId, dynamic result) {
    final resultMap = _asStringMap(result);
    if (resultMap == null) return;
    final snap = _asStringMap(resultMap['streaming_state']);
    if (snap == null) return;
    _ref
        .read(timelineStateProvider(sessionId).notifier)
        .applyStreamingSnapshot(snap);
  }

  /// session.subscribe 同步待处理交互 — approval / ask_user 是阻塞状态,
  /// 不是 drift 消息; 离开 timeline 或重连后必须靠 subscribe 快照恢复卡片.
  void _applyPendingActionsFromSubscribe(String sessionId, dynamic result) {
    final resultMap = _asStringMap(result);
    if (resultMap == null) return;
    final raw = resultMap['pending_actions'] ?? resultMap['pendingActions'];
    if (raw == null) return;
    final pending = _asStringMap(raw);
    if (pending == null) return;

    final approvalsCtrl = _ref.read(pendingApprovalsProvider.notifier);
    final askUsersCtrl = _ref.read(pendingAskUsersProvider.notifier);
    approvalsCtrl.clearSession(sessionId);
    askUsersCtrl.clearSession(sessionId);

    final approvals = pending['approvals'];
    if (approvals is List) {
      for (final item in approvals) {
        final m = _asStringMap(item);
        if (m == null) continue;
        final reqId = _stringValue(m['request_id'] ?? m['requestId']).trim();
        if (reqId.isEmpty) continue;
        approvalsCtrl.add(
          sessionId,
          PendingApproval(
            requestId: reqId,
            toolName: _stringValue(m['tool_name'] ?? m['toolName'] ?? 'tool'),
            args: _asStringMap(m['args']) ?? <String, dynamic>{},
            reason: _stringValue(m['reason']),
            allowRemember:
                m['allow_remember'] == true || m['allowRemember'] == true,
          ),
        );
      }
    }

    final askUsers =
        pending['ask_user'] ?? pending['askUser'] ?? pending['ask_users'];
    if (askUsers is List) {
      for (final item in askUsers) {
        final m = _asStringMap(item);
        if (m == null) continue;
        final reqId = _stringValue(m['request_id'] ?? m['requestId']).trim();
        if (reqId.isEmpty) continue;
        final questions = _parseAskUserQuestions(m['questions']);
        if (questions.isEmpty) continue;
        askUsersCtrl.add(
          sessionId,
          PendingAskUser(
            requestId: reqId,
            questions: questions,
            turnId: _optionalString(m['turn_id'] ?? m['turnId']),
          ),
        );
      }
    }
  }

  /// 进入 timeline 后先登记当前 session，连接稍后成功时也能自动 re-subscribe。
  void setActiveTimeline(String sessionId) {
    state = state.copyWith(activeTimelineSessionId: sessionId);
  }

  /// 退 timeline 页时调, 清掉 active session — WS 重连不再 re-subscribe.
  void clearActiveTimeline() {
    state = state.copyWith(activeTimelineSessionId: null);
  }

  /// WS 重连后 — 同一条 projector attach (Execution 快照 + EntryLog gap-fill).
  Future<void> _resubscribeAfterReconnect(String sessionId) async {
    await attachOrCatchUp(sessionId);
  }

  /// catch-up 多页回填的页数封顶 (200/页 × 5 = 1000 条); 更早的留给向上翻页.
  static const _kCatchUpMaxPages = 5;

  /// 拉历史消息 — 进 timeline 页时调 (session.subscribe 只订阅未来 ≥ sinceSeq,
  /// 历史得手动拉一批落 drift). 拉 [beforeSeq] 之前的最多 [limit] 条.
  /// 返回本页写入条数与最小 seq — attach 多页回填 / 向上翻页判断"还有没有更早"用.
  Future<HistoryPage> fetchSessionHistory(
    String sessionId, {
    int beforeSeq = 0x7fffffff,
    int limit = 200,
  }) async {
    final dynamic c = _activeClient;
    if (c == null) {
      debugPrint('[ws_provider] fetchSessionHistory: no active client');
      /* 没有连接**是失败**, 不是"没有更多了" —— 报成后者的话, 翻页会就此
       * 永久关掉, 而且界面显示的是「还没有消息」。 */
      return const HistoryPage.failed();
    }
    /* 2026-09-18 删掉的那道守卫:
     *
     *   final paired = await ...findByDeviceId(state.activeDesktopDeviceId ?? '');
     *   if (paired == null) return (written: 0, minSeqSeen: 0);
     *
     * `paired` 读出来一次都没用过, 它纯粹是个前置条件 —— 而且是个会**静默
     * 杀掉每一页历史**的前置条件: activeDesktopDeviceId 为空 (云端会话 /
     * 正在切换)、或者那台电脑重新配对换了 deviceId、或者本地 paired 行被清过,
     * 都会让它成立。成立时不发请求、不打日志、返回 0, 上层读成"没更多了",
     * 界面写「还没有消息」。用户看到的就是"历史会话无法加载"。
     *
     * 能不能拉历史由**连接**决定 (上面的 _activeClient), 不由本地那张配对表
     * 决定。真要是对端不认识这个会话, 它会回空/报错, 那时候我们能说得出话。 */
    try {
      final resp = await c.sendRequest('session.history', {
        'session_id': sessionId,
        'before_seq': beforeSeq,
        'limit': limit,
      });
      final result = resp.result;
      /* 回包长得不对也是失败 (协议变了 / 对端版本老), 不是"没有更多" */
      if (result is! Map<String, dynamic>) {
        debugPrint('[ws_provider] session.history: 回包不是对象');
        return const HistoryPage.failed();
      }
      final raw = result['messages'];
      if (raw is! List) {
        debugPrint('[ws_provider] session.history: messages 不是数组');
        return const HistoryPage.failed();
      }
      final db = _ref.read(appDatabaseProvider);
      final buffer = _ref.read(streamBufferProvider.notifier);
      final rows = <SessionEventsCompanion>[];
      var maxSeqSeen = 0;
      var minSeqSeen = 0;
      for (final m in raw.whereType<Map<String, dynamic>>()) {
        final seq = m['seq'];
        final ts = m['ts'];
        final kind = m['kind'] as String?;
        final payload = m['payload'];
        if (seq is! int || ts is! int || kind == null) continue;
        rows.add(
          SessionEventsCompanion(
            sessionId: Value(sessionId),
            seq: Value(seq),
            ts: Value(ts),
            kind: Value(kind),
            payload: Value(jsonEncode(payload)),
          ),
        );
        if (seq > maxSeqSeen) maxSeqSeen = seq;
        if (minSeqSeen == 0 || seq < minSeqSeen) minSeqSeen = seq;
      }
      /* 单事务批量入库 — 逐条 await insert 在 200 条页上是几十次盘往返 */
      await db.sessionEventsDao.insertBatch(rows);
      if (maxSeqSeen > 0) buffer.updateLatestDriftSeq(sessionId, maxSeqSeen);
      debugPrint('[ws_provider] session.history loaded ${rows.length} events');
      return HistoryPage(written: rows.length, minSeqSeen: minSeqSeen);
    } catch (e) {
      debugPrint('[ws_provider] session.history failed: $e');
      if (_isSessionNotFoundError(e)) {
        await _deleteLocalSessionData(
          sessionId,
          reason: 'history not found',
          transient: true,
        );
      }
      return const HistoryPage.failed();
    }
  }

  /// 子会话增删后拉一次 session.list — 3s 内多次触发只拉一次.
  Timer? _sessionListRefreshTimer;

  void _scheduleSessionListRefresh() {
    _sessionListRefreshTimer?.cancel();
    _sessionListRefreshTimer = Timer(const Duration(seconds: 3), () {
      _sessionListRefreshTimer = null;
      unawaited(requestSessionList());
    });
  }

  /// 子 agent 会话历史 — **不落 drift**, 直接返内存事件列表.
  ///
  /// 桌面把每个 sub-agent 落成一条 `parent_session_id=父` 的真实子会话
  /// (`agentId` 即子 sessionId), 所以这里复用 `session.history` 就能拿到子 agent
  /// 的完整 timeline。子会话事件量可能很大且用完即弃, 进主 drift 表会污染主会话
  /// 镜像 + 撑爆本地库 —— 悬浮窗关掉就该全部释放 (性能红线)。
  Future<List<SessionEvent>> fetchSubagentHistory(
    String childSessionId, {
    int limit = 200,
  }) async {
    final dynamic c = _activeClient;
    if (c == null) return const [];
    try {
      final resp = await c.sendRequest('session.history', {
        'session_id': childSessionId,
        'before_seq': 0x7fffffff,
        'limit': limit,
      });
      final result = resp.result;
      if (result is! Map<String, dynamic>) return const [];
      final raw = result['messages'];
      if (raw is! List) return const [];
      final out = <SessionEvent>[];
      for (final m in raw.whereType<Map<String, dynamic>>()) {
        final seq = m['seq'];
        final ts = m['ts'];
        final kind = m['kind'] as String?;
        if (seq is! int || ts is! int || kind == null) continue;
        out.add(
          SessionEvent(
            sessionId: childSessionId,
            seq: seq,
            ts: ts,
            kind: kind,
            payload: jsonEncode(m['payload']),
          ),
        );
      }
      out.sort((a, b) => a.seq.compareTo(b.seq));
      return out;
    } catch (e) {
      debugPrint('[ws_provider] subagent history failed: $e');
      return const [];
    }
  }

  /// 强制重同步 — 清掉本会话的本地 drift 缓存并从桌面整段重拉.
  ///
  /// 用途: 本地镜像被历史 bug 污染时 (如 2026-07-21 的 seq 冲突覆盖, tool 行被
  /// thinking 顶掉) 恢复到与桌面一致。桌面 messages 表是真相源, 重拉后
  /// insertOnConflictUpdate 覆写坏行, 重复行渲染层自动合并.
  Future<void> resyncSession(String sessionId) async {
    final db = _ref.read(appDatabaseProvider);
    await db.sessionEventsDao.deleteBySessionId(sessionId);
    /* 增量游标归零 — 下次 catch-up 视作全新会话从头拉 */
    await db.sessionMirrorDao.updateLastSeq(
      sessionId,
      0,
      DateTime.now().millisecondsSinceEpoch,
    );
    /* 丢掉内存投影 (_appliedDriftSeqs / 排序状态), 重建走干净 hydrate */
    _ref.invalidate(timelineStateProvider(sessionId));
    await attachOrCatchUp(sessionId);
  }

  /// 向上翻页 — 拉比本地最旧 seq 更早的一页. 返回本页条数 (0 = 没有更早的了).
  /// timeline 滚到顶时调; drift watch 会自动把新页并入渲染.
  Future<HistoryPage> loadOlderHistory(
    String sessionId, {
    int limit = 200,
  }) async {
    final db = _ref.read(appDatabaseProvider);
    final localMin = await db.sessionEventsDao.getMinSeq(sessionId);
    /* seq 从 **0** 起算 (桌面 nextSeq = maxRow + 1, 空会话给 0), 所以
     * `localMin <= 1` 会把"本地最旧是 1, 还差 seq 0"判成"到头了" ——
     * 会话的第一条用户消息永远翻不出来。判 <= 0 才对。 */
    if (localMin == null || localMin <= 0) {
      return const HistoryPage(written: 0, minSeqSeen: 0);
    }
    return fetchSessionHistory(sessionId, beforeSeq: localMin, limit: limit);
  }

  /// 拉单 session 完整 meta — UI 进 timeline 后调, status bar 用.
  Future<SessionInfo?> fetchSessionInfo(String sessionId) async {
    final dynamic c = _activeClient;
    if (c == null) return null;
    /* 会话不在现在连着的这台机器上 (云端任务 / 另一台电脑): 不问它 —— 问了只会得到 not found */
    final owner = (await _ref.read(appDatabaseProvider).sessionMirrorDao.findById(sessionId))?.desktopDeviceId;
    final active = state.activeDesktopDeviceId;
    if (owner != null && owner.isNotEmpty && !isPhoneLocalDeviceId(owner) && active != null && owner != active) {
      return null;
    }
    try {
      final resp = await c.sendRequest('session.get', {
        'session_id': sessionId,
      });
      final result = resp.result;
      if (result is Map<String, dynamic>) {
        return SessionInfo.fromJson(result);
      }
    } catch (e) {
      debugPrint('[ws_provider] fetchSessionInfo failed: $e');
      if (_isSessionNotFoundError(e)) {
        await _deleteLocalSessionData(
          sessionId,
          reason: 'session.get not found',
          transient: true,
        );
      }
    }
    return null;
  }

  /// 拉 Desktop 可用 model 列表 — model picker 用.
  /// 拉一块产物字节 — 对应桌面 `file.fetch`.
  ///
  /// 只传 artifact_id, **不传路径**: 桌面那侧也只认 id (见 artifactRegistry),
  /// 手机压根没有能力去点名读电脑上的任意文件。
  ///
  /// 返回 null = 这条 transport 现在用不了 (没连上/超时), 调用方翻成人话。
  Future<Map<String, dynamic>?> fetchArtifactChunk({
    required String artifactId,
    required int offset,
    required int length,
  }) async {
    final dynamic c = _activeClient;
    if (c == null) return null;
    try {
      /* v2 下一块能到几百 KB, 慢网 10 秒默认超时不够 */
      final resp = await c.sendRequest('file.fetch', {
        'artifact_id': artifactId,
        'offset': offset,
        'length': length,
        /* v2 下字节直接挂在明文尾巴上, 不进 base64; 老电脑不认这个参数照旧给 base64 */
        if (relayFramesActive) 'binary': true,
      }, const Duration(seconds: 30));
      final result = resp.result;
      if (result is Map<String, dynamic>) return result;
    } catch (e) {
      debugPrint('[ws_provider] file.fetch failed: $e');
    }
    return null;
  }

  /// 上一次 model.list 的结果 —— 模型面板先拿它弹出来, 再后台刷新 (见 openModelSheet)。
  /// 每次都等一轮 WS 往返才弹面板, 走云中继时点下去要好几秒没反应 (2026-10-06 用户: 「点击非常慢才弹出」)。
  List<ModelInfo> cachedAvailableModels = const [];

  Future<List<ModelInfo>> fetchAvailableModels() async {
    final dynamic c = _activeClient;
    if (c == null) return const [];
    try {
      final resp = await c.sendRequest('model.list', {});
      final result = resp.result;
      if (result is Map<String, dynamic>) {
        final raw = result['models'];
        if (raw is List) {
          final list = raw
              .whereType<Map<String, dynamic>>()
              .map(ModelInfo.fromJson)
              .toList();
          if (list.isNotEmpty) cachedAvailableModels = list;
          return list;
        }
      }
    } catch (e) {
      debugPrint('[ws_provider] fetchAvailableModels failed: $e');
    }
    return const [];
  }

  /// 从已配对电脑导入 BYOK providers (含 API Key).
  /// 仅 LAN transport — 云中继会被桌面拒绝.
  Future<DesktopProvidersExport> exportDesktopProviders() async {
    if (state.transport != WsTransport.lan ||
        state.connection != WsConnectionState.connected) {
      throw StateError(tr('需要同 Wi-Fi 已连接电脑才能导入 Provider'));
    }
    final dynamic c = _activeClient;
    if (c == null) {
      throw StateError(tr('未连接到电脑'));
    }
    final resp = await c.sendRequest('providers.export', {
      'include_keys': true,
    });
    final result = resp.result;
    if (result is! Map) {
      throw StateError(tr('电脑返回格式异常'));
    }
    return DesktopProvidersExport.fromJson(Map<String, dynamic>.from(result));
  }

  /// 列历史用过但当前未打开的 workspace — 给 mobile "最近用过" 区列表.
  Future<List<WorkspaceInfo>> fetchRecentWorkspaces() async {
    final dynamic c = _activeClient;
    if (c == null) return const [];
    try {
      final resp = await c.sendRequest('workspace.list_recent', const {});
      final result = resp.result;
      if (result is Map<String, dynamic>) {
        final raw = result['workspaces'];
        if (raw is List) {
          return raw
              .whereType<Map<String, dynamic>>()
              .map(WorkspaceInfo.fromJson)
              .toList();
        }
      }
    } catch (e) {
      debugPrint('[ws_provider] fetchRecentWorkspaces failed: $e');
    }
    return const [];
  }

  /// 让 desktop 打开一个 workspace (闭眼前曾经用过的). 返成功后再 jump.
  Future<bool> openWorkspaceOnDesktop(String workspacePath) async {
    final dynamic c = _activeClient;
    if (c == null) return false;
    try {
      final resp = await c.sendRequest('workspace.open', {
        'workspace_path': workspacePath,
      });
      final result = resp.result;
      return result is Map<String, dynamic> && result['ok'] == true;
    } catch (e) {
      debugPrint('[ws_provider] openWorkspaceOnDesktop failed: $e');
      return false;
    }
  }

  /// 列 Desktop 当前打开的所有 workspace, 给 timeline 工作区 chip 切换用.
  Future<List<WorkspaceInfo>> fetchWorkspaces() async {
    final dynamic c = _activeClient;
    if (c == null) return const [];
    try {
      final resp = await c.sendRequest('workspace.list', const {});
      final result = resp.result;
      if (result is Map<String, dynamic>) {
        final raw = result['workspaces'];
        if (raw is List) {
          return raw
              .whereType<Map<String, dynamic>>()
              .map(WorkspaceInfo.fromJson)
              .toList();
        }
      }
    } catch (e) {
      debugPrint('[ws_provider] fetchWorkspaces failed: $e');
    }
    return const [];
  }

  /// 浏览电脑上的文件夹（只列目录，限用户主目录之下）。
  ///
  /// 手机上原来只能从「已打开 / 最近」里挑工作区，想拿电脑上任意一个文件夹当项目
  /// 根本做不到 —— 用户原话："我想打开电脑上某个文件夹新建工作区…都很难"。
  /// [path] 为空 = 从主目录开始。
  Future<DirListing?> browseDesktopDirs({String? path}) async {
    final dynamic c = _activeClient;
    if (c == null) return null;
    try {
      final resp = await c.sendRequest('workspace.browse', {
        if (path != null && path.isNotEmpty) 'path': path,
      });
      final r = resp.result;
      if (r is Map<String, dynamic>) return DirListing.fromJson(r);
    } catch (e) {
      debugPrint('[ws_provider] browseDesktopDirs failed: $e');
    }
    return null;
  }

  /// 在指定 workspace 起一条新 session, 返新 session id.
  ///
  /// 2026-09-22: 带上模式和模型 (跟 session.create 同语义), 电脑那头拒绝时**抛出它的原因**
  /// 而不是返 null —— 原来一律返 null, 调用方只能写「新建失败，请确认电脑在线」,
  /// 真正的原因 (没配模型 / 目录不在主目录下 …) 被吞掉, 失败和"没连上"成了同一个值。
  /// 没有活跃连接时仍返 null (那才是"没连上")。
  Future<String?> createSessionInWorkspace({
    required String workspacePath,
    String? title,
    String? agentMode,
    String? modelId,
  }) async {
    final dynamic c = _activeClient;
    if (c == null) return null;
    try {
      final resp = await c.sendRequest('session.create_in_workspace', {
        'workspace_path': workspacePath,
        if (title != null && title.isNotEmpty) 'title': title,
        if (agentMode != null && agentMode.isNotEmpty) 'agent_mode': agentMode,
        if (modelId != null && modelId.isNotEmpty && modelId != 'auto')
          'model_id': modelId,
      });
      final result = resp.result;
      if (result is Map<String, dynamic>) {
        final id = result['id'] as String?;
        if (id != null && id.isNotEmpty) {
          _markLocallyCreated(id); // 宽限期, 防订阅/查询竞态误判"已删除"
          final desktopId = state.activeDesktopDeviceId;
          if (desktopId != null) {
            await _ref
                .read(appDatabaseProvider)
                .sessionMirrorDao
                .upsert(
                  SessionMirrorCompanion(
                    id: Value(id),
                    desktopDeviceId: Value(desktopId),
                    title: Value(result['title'] as String? ?? title ?? tr('新会话')),
                    workspaceName: Value(result['workspace_name'] as String?),
                    createdAt: Value(
                      result['created_at'] as int? ??
                          DateTime.now().millisecondsSinceEpoch,
                    ),
                  ),
                );
          }
          return id;
        }
      }
    } catch (e) {
      debugPrint('[ws_provider] createSessionInWorkspace failed: $e');
      if (e is TimeoutException || e is StateError) _markTransportFailed(e);
      rethrow;
    }
    throw StateError(tr('电脑没有返回可用任务，请升级电脑端 Neox 后重试'));
  }

  /// 删 session — desktop 侧调 sessionStore.deleteSession (永久删除存档).
  /// server 广播 session.deleted, 各端 drift mirror 自动清。
  /// 本地也立即删一次, 避免等服务端 round-trip 才更新 UI。
  /// 改会话标题 — 对应桌面 `session.rename`.
  ///
  /// 必须走桌面而不是只改本地: session.list 同步会把桌面的标题覆盖回来,
  /// "改完自己变回去"比不能改更糟 (session_actions.dart 里记着这条)。
  Future<bool> renameSession(String sessionId, String title) async {
    final dynamic c = _activeClient;
    if (c == null) return false;
    try {
      final resp = await c.sendRequest('session.rename', {
        'session_id': sessionId,
        'title': title,
      });
      final result = resp.result;
      final ok = result is Map<String, dynamic> && result['ok'] == true;
      if (ok) await _applyLocalTitle(sessionId, title);
      return ok;
    } catch (e) {
      debugPrint('[ws_provider] renameSession failed: $e');
      return false;
    }
  }

  /// 只更新本地镜像的标题 — 手机本地会话 / 收到 session.renamed 广播时用.
  Future<void> _applyLocalTitle(String sessionId, String title) async {
    try {
      final db = _ref.read(appDatabaseProvider);
      final mirror = await db.sessionMirrorDao.findById(sessionId);
      if (mirror == null) return;
      await db.sessionMirrorDao.upsert(
        SessionMirrorCompanion(
          id: Value(sessionId),
          desktopDeviceId: Value(mirror.desktopDeviceId),
          title: Value(title),
          createdAt: Value(mirror.createdAt),
        ),
      );
    } catch (e) {
      debugPrint('[ws_provider] applyLocalTitle failed: $e');
    }
  }

  Future<bool> deleteSession(String sessionId) async {
    final dynamic c = _activeClient;
    if (c == null) {
      debugPrint('[ws_provider] deleteSession: no active client');
      return false;
    }
    try {
      final resp = await c.sendRequest('session.delete', {
        'session_id': sessionId,
      });
      final result = resp.result;
      final ok = result is Map<String, dynamic> && result['ok'] == true;
      if (ok) {
        /* 不等 server 广播, 立即清本地 — 减少 UI 闪烁 */
        await _deleteLocalSessionData(sessionId, reason: 'mobile deleted');
      }
      return ok;
    } catch (e) {
      debugPrint('[ws_provider] deleteSession failed: $e');
      if (_isSessionNotFoundError(e)) {
        await _deleteLocalSessionData(sessionId, reason: 'delete not found');
        return true;
      }
      return false;
    }
  }

  /// 本地隐藏 session — 只删 drift mirror/events, 不动 desktop sessionStore.
  /// 适用于: cloud session 销毁后清残骸, 或用户想从手机视图里隐藏某条但不删 desktop 存档。
  Future<void> deleteLocalMirror(String sessionId) async {
    await _deleteLocalSessionData(sessionId, reason: 'local hide');
  }

  /// M3 — 切某 session mirrorPolicy.
  /// policy: 'always' / 'manual' / 'never'. 'never' 后 desktop 还会推删除通知,
  /// drift sessionMirror 那条会被 deleted, sessions 列表里那条消失。
  Future<void> setSessionMirror(String sessionId, String policy) async {
    final dynamic c = _activeClient;
    if (c == null) throw StateError(tr('当前任务未连接，请重新进入任务'));
    final resp = await c.sendRequest('session.set_mirror', {
      'session_id': sessionId,
      'policy': policy,
    });
    _updateMirrorPolicy(sessionId, policy);
    debugPrint('[ws_provider] session.set_mirror ok: ${resp.result}');
  }

  /// 切换某 session 的 model.
  Future<bool> updateSessionModel(String sessionId, String modelId) async {
    final dynamic c = _activeClient;
    if (c == null) return false;
    try {
      final resp = await c.sendRequest('session.update-model', {
        'session_id': sessionId,
        'model_id': modelId,
      });
      final result = resp.result;
      if (result is Map<String, dynamic> && result['ok'] == true) {
        return true;
      }
    } catch (e) {
      debugPrint('[ws_provider] updateSessionModel failed: $e');
      if (_isSessionNotFoundError(e)) {
        await _deleteLocalSessionData(
          sessionId,
          reason: 'update model not found',
          transient: true,
        );
      }
    }
    return false;
  }

  /// 新建 session — Desktop 用 focused workspace + 默认 model 创建.
  /// 返新 session 的 id (落 drift mirror), UI 拿到立即 go /timeline/`id`.
  /// [agentMode] = 'assistant'|'work'|'code' (协议 v1.1, 旧桌面忽略未知参数).
  /// 在电脑上建会话. [modelId] 是手机这边选的模型 —— 不传的话电脑会**继承同工作区
  /// 最近一条会话的模型**, 用户在手机上选的就被悄悄换掉了 (2026-09-18 实录: 选 deepseek
  /// 发完变 kimi-k3)。老版本电脑不认这个参数, 调用方建完会再 set 一次。
  Future<String?> createSession({
    String? name,
    String? agentMode,
    String? modelId,
  }) async {
    final dynamic c = _activeClient;
    if (c == null) {
      debugPrint('[ws_provider] createSession: no active client');
      throw StateError(tr('请先连接电脑或直接开始云端任务'));
    }
    try {
      final resp = await c.sendRequest('session.create', {
        if (name != null && name.isNotEmpty) 'name': name,
        if (agentMode != null && agentMode.isNotEmpty) 'agent_mode': agentMode,
        /* 'auto' 不下发 —— 那是"让系统挑", 不是真实 model id */
        if (modelId != null && modelId.isNotEmpty && modelId != 'auto')
          'model_id': modelId,
      });
      final result = resp.result;
      if (result is! Map<String, dynamic>) {
        throw StateError(tr('电脑没有返回可用任务，请升级电脑端 Neox 后重试'));
      }
      final id = result['id'] as String?;
      if (id == null || id.isEmpty) {
        throw StateError(tr('电脑没有返回可用任务，请升级电脑端 Neox 后重试'));
      }
      _markLocallyCreated(id); // 进宽限期, 防 timeline 订阅/查询竞态误判"已删除"
      /* 落 drift mirror — 让首页列表立即看到新 session */
      final desktopId = state.activeDesktopDeviceId;
      if (desktopId != null) {
        await _ref
            .read(appDatabaseProvider)
            .sessionMirrorDao
            .upsert(
              SessionMirrorCompanion(
                id: Value(id),
                desktopDeviceId: Value(desktopId),
                title: Value(result['title'] as String?),
                workspaceName: Value(result['workspace_name'] as String?),
                createdAt: Value(
                  result['created_at'] as int? ??
                      DateTime.now().millisecondsSinceEpoch,
                ),
              ),
            );
      }
      return id;
    } catch (e) {
      debugPrint('[ws_provider] createSession failed: $e');
      if (e is TimeoutException || e is StateError) _markTransportFailed(e);
      rethrow;
    }
  }

  /// 发用户输入 (text / control:*) 并返回 Desktop RPC result.
  Future<dynamic> sendInputForResult({
    required String sessionId,
    required String kind,
    required Map<String, Object?> payload,
  }) async {
    final dynamic c = _activeClient;
    if (c == null) {
      debugPrint('[ws_provider] sendInput: no active client');
      throw StateError(tr('当前任务未连接，请重新进入任务'));
    }
    try {
      /* 大附件先分片传上去, session.input 只带 upload_id —— 整包塞进去过不了中转 256KB,
       * 连接直接被断、没有任何报错 (见 attachment_upload.dart) */
      final rawAttachments = payload['attachments'];
      var wirePayload = payload;
      if (kind == 'user_message' && rawAttachments is List && rawAttachments.isNotEmpty) {
        final uploaded = await uploadLargeAttachments(
          rawAttachments.whereType<Map<String, Object?>>().toList(),
          (method, params) async =>
              (await c.sendRequest(method, params, const Duration(seconds: 30))).result,
        );
        wirePayload = {...payload, 'attachments': uploaded};
      }
      final resp = await c.sendRequest('session.input', {
        'session_id': sessionId,
        'kind': kind,
        'payload': wirePayload,
      }, const Duration(seconds: 60));
      debugPrint(
        '[ws_provider] session.input ok: kind=$kind result=${resp.result}',
      );
      return resp.result;
    } catch (e) {
      debugPrint('[ws_provider] session.input failed: kind=$kind err=$e');
      if (_isSessionNotFoundError(e)) {
        await _deleteLocalSessionData(
          sessionId,
          reason: 'input not found',
          transient: true,
        );
      }
      if (e is TimeoutException || e is StateError) _markTransportFailed(e);
      rethrow;
    }
  }

  /// 发用户输入 (text / control:*)
  Future<void> sendInput({
    required String sessionId,
    required String kind,
    required Map<String, Object?> payload,
  }) async {
    await sendInputForResult(
      sessionId: sessionId,
      kind: kind,
      payload: payload,
    );
  }

  /// 回滚到 checkpoint (协议 v1.1 session.rollback).
  /// 成功后清本地事件镜像重拉 history — 回滚后的 timeline 跟桌面强一致.
  Future<void> rollbackToCheckpoint(
    String sessionId,
    String checkpointId,
  ) async {
    final dynamic c = _activeClient;
    if (c == null) throw StateError(tr('当前任务未连接，请重新进入任务'));
    final resp = await c.sendRequest('session.rollback', {
      'session_id': sessionId,
      'checkpoint_id': checkpointId,
    });
    final result = resp.result;
    if (result is! Map<String, dynamic> || result['ok'] != true) {
      throw StateError(tr('电脑端回滚失败'));
    }
    /* 本地镜像已过时 — 清掉重拉 (timelineState 靠 drift watch 自动重建) */
    final db = _ref.read(appDatabaseProvider);
    await db.sessionEventsDao.deleteBySessionId(sessionId);
    await fetchSessionHistory(sessionId);
  }

  /// 调电脑上一个方法, 拿它的返回 (Pilot 来电回报 pilot.call_event 等)。没连着就抛 StateError。
  Future<dynamic> callDesktop(String method, Map<String, Object?> params) async {
    final dynamic c = _activeClient;
    if (c == null) throw StateError(tr('没有连上电脑'));
    final resp = await c.sendRequest(method, params);
    return resp.result;
  }

  /// 拉 session 列表 (snapshot 之外的主动查询) — 直接落 drift, sessions_page watch.
  Future<void> requestSessionList({int limit = 1000}) async {
    final dynamic c = _activeClient;
    if (c == null) return;
    final desktopId = state.activeDesktopDeviceId;
    if (desktopId == null) return;
    try {
      final resp = await c.sendRequest('session.list', {'limit': limit});
      final result = resp.result;
      if (result is Map<String, dynamic>) {
        final raw = result['sessions'];
        if (raw is List) {
          await _ingestDesktopSessionList(
            desktopDeviceId: desktopId,
            rawSessions: raw,
            requestedLimit: (result['limit'] as int?) ?? limit,
            envelope: result,
          );
        }
      }
    } catch (e) {
      debugPrint('[ws_provider] session.list failed: $e');
    }
  }

  Future<void> disconnect() async {
    _cancelSmartReconnect();
    /* 用户主动断开: 在飞的拨号回来也不许再接管 (2026-09-17 之前会"断开了又自己连上") */
    _abandonConnectAttempts();
    await _teardownClient();
    await _teardownCloudClient();
    state = WsClientState.initial;
  }

  Future<void> _teardownClient() async {
    /* 订阅是**连接级**的 — 连接没了, 之前订阅过什么就全部作废。
     * 不清的话重连后 ensureSubscribed 以为还订着, 直接放行发送, 又回到
     * "先发后订、丢开头那段事件" 的老问题上。 */
    _subscribedSessions.clear();
    final sub = _eventsSub;
    final c = _client;
    _eventsSub = null;
    _client = null;
    await sub?.cancel();
    await c?.dispose();
  }

  @override
  void dispose() {
    _cancelSmartReconnect();
    _abandonConnectAttempts();
    _connectivityCoalesceTimer?.cancel();
    _cancelConnectingWatchdog();
    _sessionListRefreshTimer?.cancel();
    unawaited(_connectivitySub?.cancel());
    unawaited(_teardownClient());
    unawaited(_teardownCloudClient());
    super.dispose();
  }
}

/// 一次拨号的"还要不要继续"开关 (2026-09-17, 为 LAN/远程赛跑加)。
///
/// [alive] 反映这一轮是否仍是当前轮 (代号没变); [cancel] 是赛跑里对手先赢了。
/// 拨号过程中创建的客户端登记到 [onCancel], 被取消时**立刻** dispose —— 不等它
/// 自己超时, 输家不白占 socket 和射频。
class _DialGuard {
  _DialGuard(this._alive);

  final bool Function() _alive;
  bool _cancelled = false;
  final List<Future<void> Function()> _cleanups = [];

  bool get alive => !_cancelled && _alive();

  void onCancel(Future<void> Function() cleanup) {
    if (_cancelled) {
      unawaited(cleanup());
      return;
    }
    _cleanups.add(cleanup);
  }

  /// 拨号成功、客户端交出去了 —— 不能再被 cancel 连带 dispose。
  void release(Future<void> Function() cleanup) => _cleanups.remove(cleanup);

  void cancel() {
    if (_cancelled) return;
    _cancelled = true;
    final pending = List.of(_cleanups);
    _cleanups.clear();
    for (final c in pending) {
      unawaited(c().catchError((Object _) {}));
    }
  }
}

class _LanDial {
  const _LanDial({this.client, this.endpoint, this.rejected, this.failure});
  final WsClient? client;
  final LanEndpoint? endpoint;
  final WsPairingRejected? rejected;
  final String? failure;
}

class _RelayDial {
  const _RelayDial({this.client, this.failure});
  final RelayChannel? client;

  /// 给用户看的失败原因 (「电脑已离线」「登录已过期，请重新登录」…)。
  final String? failure;
}

final wsClientProvider =
    StateNotifierProvider<WsClientController, WsClientState>(
      (ref) => WsClientController(ref),
    );
