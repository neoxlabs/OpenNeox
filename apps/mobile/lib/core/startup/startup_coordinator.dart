/// startup_coordinator.dart — Mobile app 启动单源管理.
///
/// 设计目标:
///   - sessions_page initState 之前散乱 4 个 unawaited 并发 → 主 isolate 编排压力大 ANR
///   - 现在统一一个 coordinator, 本地连接先跑，云端同步后台跑，错误隔离
///
/// Phases:
///   P0 (0 ms):     UI 已渲染 (caller 在 postFrameCallback 触发)
///   P1 (<50 ms):   读本地 cached DB, 触发 sessions_page 显示 paired_desktops
///   P1.5~P3.5 (background): 发行版的后台阶段 ([NeoxEdition.startupPhases];
///                  商业版 = 云端开关 / cloud-agent /sessions / auto_pair / 会话索引)
///   P4 (foreground): auto-connect 上次的真 desktop
///
/// 关键纪律:
///   - P4 不等待 P2/P3 的公网请求, 避免网络慢时拖垮本地体验
///   - 每 phase 有 timeout, 防一个慢的把后面全堵
///   - 每 phase 错误吃掉, 不影响后面 phase
///   - 单次 run 用 _isRunning 防并发触发 (e.g. setState 重入)
library;

import 'dart:async';

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../features/home/state/home_mode_provider.dart';
import '../../features/pilot/call/pilot_call_controller.dart';
import '../edition/edition.dart';
import '../execution/run_target_provider.dart';
import '../network/ws_client_provider.dart';
import '../session_routing/desktop_ranking.dart';
import '../storage/database.dart';
import '../storage/paired_desktop_kind.dart';

class StartupCoordinator {
  StartupCoordinator(this._ref);
  final Ref _ref;

  bool _isRunning = false;
  bool _hasRunOnce = false;
  bool _foregroundReconnectRunning = false;
  DateTime? _lastForegroundReconnectAt;

  /// 入口 — sessions_page postFrameCallback 调 (延后 1500ms 再 run).
  /// 串行执行轻量 phases. 重活 (auto-pair, ECDH) 不在这里 — 放 LoginPage 成功回调.
  Future<void> run() async {
    if (_isRunning || _hasRunOnce) return;
    _isRunning = true;
    final swAll = Stopwatch()..start();
    try {
      /* P0 — Pilot 来电控制器先建起来: 它建的时候才去原生取「推送来电上点了接 / 挂 / 点开」。
       * 以前要等电脑发来一通来电才建 —— 手机连着另一台电脑时, 推送来的这通点了没反应 (2026-10-02 真机) */
      _ref.read(pilotCallControllerProvider);
      /* P1.5 ~ P3.5 — 发行版的后台阶段 (商业版: 云端开关轮询 / 云端会话刷新 /
       * 同账号自动配对 / 会话索引同步, 见 CommercialEdition.startupPhases)。
       *
       * 必须排在 P4「连电脑」**之前**开始、且不 await: 公网同步不能挡住本地电脑连接,
       * 失败/超时只影响它自己那份数据。 */
      for (final p in _ref.read(editionProvider).startupPhases(_ref)) {
        unawaited(_phase(p.name, p.body, budget: p.budget));
      }
      /* P4 — 自动连接最近一台真实电脑。
       * 电脑端旧会话是在 WS authenticated 后通过 session.list 同步的；
       * 只展示 paired chip 不连接，首页就拿不到电脑会话。
       *
       * 对话模式跳过 (2026-09-24): 对话整个跑在手机上, 冷启动去连电脑 (握手 + 会话同步
       * + 一批落库) 只会拖慢首屏 —— 用户原话「每次进来都需要去主动连接电脑, 会造成
       * APP 的性能卡顿」。切到工作/编码、或点开一条电脑会话时再连 (见 connectDesktopIfNeeded)。 */
      if (_ref.read(homeModeProvider).needsDesktop) {
        await _phase(
          'P4 auto-connect desktop',
          _autoConnect,
          budget: const Duration(seconds: 5),
        );
      } else {
        debugPrint('[startup] P4 skipped — chat mode runs on the phone');
      }
      /* P5 — paired_desktops 残留清理。必须排在 P4 之后: 它会删/合并行,
       * 跟"选哪台电脑"直接相关, 先连上再清才不会把正在用的那台清掉。 */
      unawaited(
        _phase(
          'P5 paired_desktops dedupe',
          _dedupePairedDesktops,
          budget: const Duration(seconds: 5),
        ),
      );
    } finally {
      _isRunning = false;
      _hasRunOnce = true;
      debugPrint('[startup] total ${swAll.elapsedMilliseconds}ms');
    }
  }

  Future<void> _phase(
    String name,
    Future<void> Function() body, {
    required Duration budget,
  }) async {
    debugPrint('[startup] ▶ $name start');
    final sw = Stopwatch()..start();
    try {
      await body().timeout(budget);
      debugPrint('[startup] ✓ $name ok in ${sw.elapsedMilliseconds}ms');
    } on TimeoutException {
      debugPrint(
        '[startup] ⏰ $name timeout after ${budget.inMilliseconds}ms — skip',
      );
    } catch (e) {
      debugPrint('[startup] ✗ $name failed: $e');
    }
  }

  /* ─────────────── phase implementations ─────────────── */

  /// paired_desktops 残留清理 (同名合并 + 7 天没连上的清掉).
  ///
  /// 2026-07-28: 从 `main.dart` 的 `Future.delayed` 里搬过来。原来那份自己
  /// `AppDatabase()` **又开了一个连接** —— 同一个 SQLite 文件、两个独立 executor,
  /// drift 会直接告警 "race conditions will occur and might corrupt the database"
  /// (真机 logcat 每次冷启动都在刷)。而这段做的恰恰是**写操作**: 合并、删除
  /// paired_desktops 行, 跟主库的读写并发跑。配对表被搞乱的嫌疑就在这里。
  ///
  /// 现在走 provider 的唯一实例, 且排在 P4 之后 —— 先连上再清, 不会误删在用的那台。
  Future<void> _dedupePairedDesktops() async {
    final dao = _ref.read(appDatabaseProvider).pairedDesktopsDao;
    /* 1. 同名 entries 合并 (历史 random device_id 残留) — 1 桌面 1 entry.
     *    痛点: Mac 换 wifi 改 hostname / 桌面重装让 pubkey 重生成 → 同台机在
     *    手机 DB 攒出 5+ 条。pubkey/device_id 都跟 pair 实例绑, 没法跨 pair 去重。 */
    final merged = await dao.dedupeByName();
    /* 2. 7 天前配对但从没连上过的明显残留 */
    final cleaned = await dao.cleanupStale();
    if (merged > 0 || cleaned > 0) {
      debugPrint('[startup] paired_desktops dedupe: merged=$merged cleaned=$cleaned');
    }
  }

  Future<void> _autoConnect() async {
    /* 2026-09-03: 从"连排名第一的那台"改成"连任何一台能连的"。
     * 真机实录: 排第一的是一台配对已失效的 Windows, 手机对着它反复重试, 而同一个
     * Wi-Fi 下另一台 Mac 开着、能连、一次都没被试过 —— 用户看到的是"连不上"。
     * 排序本身没错 (那是"最该用哪台"), 错在把它当成唯一一台。 */
    await _ref.read(wsClientProvider.notifier).connectToBestAvailableDesktop(
          trigger: DesktopConnectTrigger.automatic,
        );
  }

  /// 回前台时补连 —— 对话模式下不连 (同冷启动 P4 的理由).
  ///
  /// 对话模式里正开着一条电脑会话 (比如点通知进来的) 时由首页自己补连,
  /// 见 HomeStagePage._syncTimelineSubscription。
  Future<void> reconnectOnForeground() async {
    if (!_ref.read(homeModeProvider).needsDesktop) return;
    await connectDesktopIfNeeded();
  }

  /// 没连着电脑就连一台 (首选优先) —— 切到工作/编码、打开电脑会话、发送前重连都走这里.
  /// 内部有去重和 1.2s 节流, 重复调用是安全的。
  Future<void> connectDesktopIfNeeded() async {
    final wsState = _ref.read(wsClientProvider);
    // P0-3 修: 只在"已真正连上"时跳过。原来 connecting 也跳过 → 切后台时一个卡住的
    // connecting 态回前台后被直接放过, 永远卡"正在查找…"。connectToDesktop 内部有
    // in-flight de-dupe, 所以 connecting 态再踢一次是安全的(真在连就复用现有 future,
    // 卡死的就被重新拉起)。
    if (wsState.activeDesktopDeviceId != null &&
        wsState.connection == WsConnectionState.connected) {
      return;
    }
    if (_foregroundReconnectRunning) return;
    final now = DateTime.now();
    final last = _lastForegroundReconnectAt;
    if (last != null && now.difference(last).inMilliseconds < 1200) {
      return;
    }
    _foregroundReconnectRunning = true;
    _lastForegroundReconnectAt = now;
    try {
      final target = await _pickReconnectTarget();
      if (target == null) return;
      debugPrint(
        '[startup] foreground reconnect to ${target.deviceId} (${target.deviceName ?? "-"})',
      );
      await _ref
          .read(wsClientProvider.notifier)
          .connectToDesktop(
            target.deviceId,
            trigger: DesktopConnectTrigger.automatic,
          );
    } finally {
      _foregroundReconnectRunning = false;
    }
  }

  /// 挑重连目标 —— 用跟发送路由**同一套**排序规则.
  ///
  /// 2026-08-09: 这里原来自己写了一遍 `lastConnectedAt ?? pairedAt` 排序, 跟
  /// `rankDesktopsForRouting` 各活各的。两处规则一分裂就必然漂移 —— 而它俩挑出
  /// 不同的电脑, 症状是"自动连上了 A, 一发消息又跳到 B", 极难查。
  ///
  /// 更要命的是那份本地排序**只认自己的历史记忆**: 同一台 Mac 改名/重装后账号下
  /// 会留两条记录 (device_id 和 pubkey 都变了, 名字也不同, 按名字去重合不掉),
  /// 而早就死掉的那条碰巧有更晚的 lastConnectedAt, 于是每次冷启动都去连一台
  /// 关机的机器, 而两分钟前还在 announce 的那台被跳过。
  /// 真机实录: 账号里 `Mac` 和 `kimberly-air-11531` 是同一台, 手机固执地连 `Mac`。
  ///
  /// 现在统一走 rankDesktopsForRouting, 它认服务端的 last_announce_at。
  Future<PairedDesktop?> _pickReconnectTarget() async {
    final db = _ref.read(appDatabaseProvider);
    final allPaired = await db.pairedDesktopsDao.getAll();
    /* 只选真 desktop — cloud chip 要用户手动点 (cloud session 可能 suspended, 自动连卡死) */
    final realDesktops = allPaired
        .where((d) => isRealPairedDesktop(d) && canConnectPairedDesktop(d))
        .toList();
    if (realDesktops.isEmpty) return null;
    final ranked = rankDesktopsForRouting<PairedDesktop>(
      realDesktops,
      deviceId: (d) => d.deviceId,
      lastConnectedAt: (d) => d.lastConnectedAt,
      pairedAt: (d) => d.pairedAt,
      lastAnnounceAt: (d) => d.lastAnnounceAt,
      /* 这里不传 liveDeviceId: 能走到这个函数的前提就是当前没连上 */
    );
    /* 用户设过「首选电脑」就先连它 (2026-09-22)。
     *
     * 上面那套排序答的是"客观上最可能连得上哪台", 它不知道用户想用哪台 —— 于是
     * 首选 Mac 的人, 每次冷启动都被 announce 更新鲜的 Windows 顶掉。**只有这条路
     * 漏了首选**: 发消息路由 (session_router) 和逐台尝试 (ws_client_provider) 都读
     * 了。而它恰恰是用户最先、也最常看到的那一次连接, 于是症状最刺眼。
     * 首选是用户的意图, 客观排序只该决定"首选不通时先试谁"。 */
    /* 2026-09-26: 再往上一层是「当前电脑」—— Wi-Fi 切蜂窝时局域网连接断了才走到这里,
     * 这时刚才在用的那台必须排第一, 不然会按心跳连去另一台 (见 orderByUserIntent)。 */
    return orderByUserIntent(
      ranked,
      preferredDeviceId: _ref.read(preferredDesktopProvider),
      currentDeviceId: _ref.read(wsClientProvider.notifier).currentDesktopId,
      deviceId: (d) => d.deviceId,
    ).first;
  }
}

final startupCoordinatorProvider = Provider<StartupCoordinator>(
  (ref) => StartupCoordinator(ref),
);
