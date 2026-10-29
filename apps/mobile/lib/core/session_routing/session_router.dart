/// session_router.dart — 智能 session 创建 + 消息路由.
///
/// 旧 SessionsPage._createBestSession 把 "登录就走 phone-local" 硬编码 (bug),
/// 导致 Pro 用户登录后也用不上 cloud agent. 这里抽出统一服务给 StageInput / 任意
/// 入口复用, 修正决策树:
///
/// **创建优先级**:
///   1. 已连接桌面 (LAN/relay) → 在该桌面创建 session
///   2. cloud 可用 (登录 + cloudFeatureFlags.createEnabled) → 创建 cloud session
///   3. fallback → 创建 phone-local session (无 LLM 配置则发不出消息)
///
/// **发送路由** (按 session 类型):
///   - sessionMirror.desktopDeviceId == kPhoneLocalDeviceId → phoneLocalAgent
///   - 其他 → wsClient (desktop 或 cloud relay 自动选)
library;

import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../features/home/state/selected_model_provider.dart';
import '../composer/chat_mode_pref.dart';
import '../execution/cloud_agent_access.dart';
import '../feature_flags.dart' show kAutoRouteToCloud;
import '../execution/run_target.dart' show isPhoneLocalDeviceId;
import '../execution/run_target_provider.dart';
import '../local_agent/linux_env.dart';
import '../local_agent/phone_local_agent.dart';
import '../network/stream_buffer_provider.dart';
import '../../features/home/state/current_project_provider.dart';
import '../network/ws_client_provider.dart';
import '../storage/database.dart';
import '../storage/paired_desktop_kind.dart';
import 'desktop_ranking.dart';
import 'package:neox_app/core/i18n/tr.dart';

class SessionRouteResult {
  SessionRouteResult({
    required this.sessionId,
    required this.kind,
    this.degradedNotice,
  });
  final String sessionId;

  /// 'desktop' | 'cloud' | 'phone_local'
  final String kind;

  /// auto 模式下**没落到最优档位**时的一句实话, 由调用方提示给用户.
  ///
  /// 2026-08-08: 这个字段的存在是因为 auto 分支原来是 `catch (_) {}` 一路
  /// 静默降级 —— 用户交了一个需要工具的任务, 拿回一段编出来的文本, 还不知道
  /// 为什么。本文件顶部自己写着「用户显式选了『完整 Agent』却悄悄落到『无工具
  /// 快聊』是最坏的欺骗」, 那条纪律在显式选择的分支上守住了, auto (默认档)
  /// 这条路上却没有。
  ///
  /// null = 落在了预期档位, 没什么好说的。
  final String? degradedNotice;
}

class SessionRouter {
  SessionRouter(this._ref);
  final Ref _ref;

  /// 创建 session, 返回 sessionId.
  ///
  /// [target] 显式运行位置 (用户在输入框「运行位置」chip 选的):
  ///   auto    → 智能选择 "桌面 > 云端 > 手机" (默认, 保持旧语义)
  ///   desktop/cloud/phone → 锁定该位置, 不可用时抛诚实错误 (不静默降级 —
  ///   用户显式选了"完整 Agent"却悄悄落到"无工具快聊"是最坏的欺骗)
  ///
  /// [agentMode] = 'assistant'|'work'|'code' — 桌面路径透传 (协议 v1.1).
  Future<SessionRouteResult> createBestSession({
    RunTargetPref target = RunTargetPref.auto,
    String? agentMode,
  }) async => _stampMode(
    await _createBestSession(target: target, agentMode: agentMode),
    agentMode,
  );

  /// 把模式盖进刚建好的会话行.
  ///
  /// **为什么在这一层盖, 而不是在各个 createSession 里.**
  /// 会话有三条创建路径 (桌面 / 云端 / 手机本地), 每条各自往 drift 里 upsert 一次
  /// SessionMirrorCompanion, 加起来十来处。挨个去补一定会漏 —— 而漏了之后
  /// typecheck 和单测全绿, 只有"工作 home 里少一条"这种事后症状能发现
  /// (跟 timeline 加字段要手写四遍是同一种坑)。
  /// 这里是三条路唯一的汇合点, 也是**唯一知道模式**的那一层: 盖一次, 盖全。
  ///
  /// agentMode 为 null 时什么都不写 —— 让那一行保持"未知", 而不是假装它是对话。
  Future<SessionRouteResult> _stampMode(
    SessionRouteResult r,
    String? agentMode,
  ) async {
    if (agentMode == null || agentMode.isEmpty) return r;
    try {
      await _ref
          .read(appDatabaseProvider)
          .sessionMirrorDao
          .setAgentMode(r.sessionId, agentMode);
    } catch (e) {
      /* 盖不上只影响"工作/编码 home 能不能筛出它", 不该让会话建不成 */
      debugPrint('[session_router] stamp agentMode failed: $e');
    }
    return r;
  }

  Future<SessionRouteResult> _createBestSession({
    RunTargetPref target = RunTargetPref.auto,
    String? agentMode,
  }) async {
    final db = _ref.read(appDatabaseProvider);
    /* 列表还没到手时 effectiveModelProvider 是空串, 会话就落到 agent 自己现拉的第一个模型 ——
     * 跟输入框将要显示的不是同一个 (2026-10-08 真机: 刚登录就发, 会话建成 deepseek-v4-flash,
     * 发送时才发现这个账号用不了, 报不支持)。先等列表, 两边用同一份。 */
    try {
      await _ref.read(availableModelsProvider.future).timeout(const Duration(seconds: 15));
    } catch (_) {/* 拉不到就按现有的走 */}
    /* 生效的那个 (没手选过的本机模型对订阅用户不算数, 见 effectiveModelProvider) */
    final modelHint = _ref.read(effectiveModelProvider);

    Future<List<PairedDesktop>> connectableDesktops() async => _rankDesktops(
      (await db.pairedDesktopsDao.getAll())
          .where((d) => isRealPairedDesktop(d) && canConnectPairedDesktop(d))
          .toList(),
    );

    switch (target) {
      case RunTargetPref.desktop:
        {
          final desktops = await connectableDesktops();
          if (desktops.isEmpty) {
            throw StateError(tr('还没配对电脑 — 去「设置 → 我的电脑」扫码配对'));
          }
          final id = await _createDesktopSession(
            _pickDesktop(desktops),
            agentMode: agentMode,
            modelHint: modelHint,
          );
          return SessionRouteResult(sessionId: id, kind: 'desktop');
        }
      case RunTargetPref.cloud:
        {
          if (!_cloudAvailable()) {
            throw StateError(tr('云端 Agent 需要登录且套餐开通 — 到「我的 → 会员」查看'));
          }
          final result = await _createCloudSession(modelId: modelHint, agentMode: agentMode);
          return SessionRouteResult(sessionId: result.sessionId, kind: 'cloud');
        }
      case RunTargetPref.phone:
        {
          await _guardCodeModeOnPhone(agentMode);
          final id = await _ref
              .read(phoneLocalAgentProvider)
              .createSession(modelHint: _phoneModelHint(modelHint));
          return SessionRouteResult(sessionId: id, kind: 'phone_local');
        }
      case RunTargetPref.auto:
        {
          /* 降级留痕 —— 每一次 fallback 都记下来, 最后如实告诉用户。
           * 原来这里是两个 `catch (_) {}`, 一路静默滑到无工具快聊。 */
          var triedDesktop = false;
          var triedCloud = false;

          /* 1. 已连接桌面优先 */
          final desktops = await connectableDesktops();
          if (desktops.isNotEmpty) {
            triedDesktop = true;
            final desktop = _pickDesktop(desktops);
            try {
              final id = await _createDesktopSession(
                desktop,
                agentMode: agentMode,
                modelHint: modelHint,
              );
              return SessionRouteResult(sessionId: id, kind: 'desktop');
            } catch (_) {
              /* 连着电脑却建不出来 = 电脑那头明确拒绝了 (没配模型 / 项目目录没了),
               * 原因要原样给人看。原来一律吞掉往下落: 编码模式落到手机上再被拦,
               * 用户看到的是「Code 模式需要电脑」—— 可电脑明明连着。
               * 只有"没连上"才往云端/手机落。 */
              if (_isConnectedTo(desktop.deviceId)) rethrow;
            }
          }
          /* 2. 云端 —— 自动模式不再往这落 (2026-10-11 用户: 我们的优势是手机本地就能干, 不需要云端 Agent;
           * 编码在电脑连不上时落到云端, 拿到的是「没有一个 Pod 在 warm 阶段」这种报错)。
           * 只有明确选了云端 (RunTargetPref.cloud) 才建云端会话。 */
          if (kAutoRouteToCloud && _cloudAvailable()) {
            triedCloud = true;
            try {
              final result = await _createCloudSession(modelId: modelHint, agentMode: agentMode);
              return SessionRouteResult(
                sessionId: result.sessionId,
                kind: 'cloud',
                /* 配了电脑却没连上, 落到云端 —— 能力没降但机器变了, 说一声 */
                degradedNotice: triedDesktop ? tr('电脑不在线，这条在云端跑') : null,
              );
            } catch (e) {
              /* 云端满了 / 暂不可用: 编码没别处可去, 原因直接给人看; 工作落到手机 */
              if (agentMode == 'code') rethrow;
              debugPrint('[session_router] 云端建不出来, 落到手机: $e');
            }
          }
          /* 3. phone-local fallback — Code 模式在手机上没意义, 诚实拦截 */
          await _guardCodeModeOnPhone(agentMode);
          final id = await _ref
              .read(phoneLocalAgentProvider)
              .createSession(modelHint: _phoneModelHint(modelHint));
          return SessionRouteResult(
            sessionId: id,
            kind: 'phone_local',
            /* 这一条才是真正的能力降级: 用户以为在用完整 Agent, 实际落到了
             * 手机本地。不说的话他会拿到一段"看起来像干了活"的文本。
             * 本来就没有电脑/云端可用的人不需要被打扰 —— 那是预期行为。 */
            degradedNotice: (triedDesktop || triedCloud)
                ? (triedDesktop
                      ? tr('电脑没连上，这条改在手机上跑（没有文件和终端工具）')
                      : tr('云端暂时不可用，这条改在手机上跑（没有文件和终端工具）'))
                : null,
          );
        }
    }
  }

  /// 手机本地会话用哪个模型 —— 跟输入框 chip 上**显示的**那个一致.
  ///
  /// 2026-09-24 模拟器实拍: chip 写着 qwen3.8-flash, 发出去的会话却是 deepseek-v4-flash。
  /// 没选过模型时 selectedModelProvider 是空 / 'auto', 手机 agent 就自己挑列表第一个;
  /// 而 chip 显示的是 effectiveModelProvider (没选过 = 最省的那个)。界面说 A、实际发 B。
  /// 电脑会话不走这里: 那边的模型 id 带命名空间, 由电脑自己解析。
  String _phoneModelHint(String selected) {
    final effective = _ref.read(effectiveModelProvider);
    return effective.isNotEmpty ? effective : selected;
  }

  /// Code 模式禁用手机本地 (2026-07-20 场景适配拍板): 手机没有终端/仓库/IDE,
  /// 写代码任务落到手机本地只会产出没法验证的文本 — 诚实拒绝并指路.
  /// 编码落到手机: 补全了本地能力 (Node / Python / git) 就放行 (2026-10-12), 没补全才拦。
  Future<void> _guardCodeModeOnPhone(String? agentMode) async {
    if (agentMode != 'code') return;
    if (Platform.isAndroid && (await LinuxEnv.status()).installed) return;
    throw StateError(
      Platform.isAndroid
          ? tr('在手机上写代码要先下载工具包 (设置 → 工具包), 或者连上电脑')
          : tr('编码要在电脑上跑 —— 电脑没连上，确认电脑上的 Neox 开着'),
    );
  }

  /// 按 session 类型路由发送消息.
  ///
  /// [attachments] 元素 schema 跟 mobile 协议 payload.attachments[] 一致:
  ///   { kind: 'image'|'file', name, mime, data_base64, size_bytes }
  /// [approvalMode] 跟 desktop / mobile-bridge 对齐:
  ///   auto | manual(Plan) | dangerous(YOLO) | yolo(兼容→dangerous).
  /// 旧实现把非 yolo 一律压成 auto → Plan/YOLO 选择完全失效.
  Future<void> sendMessage({
    required String sessionId,
    required String text,
    List<Map<String, Object?>> attachments = const [],
    String approvalMode = 'auto',
    /// 聊天模式: 电脑那边换精简 prompt、不带工具 (见 core/composer/chat_mode_pref.dart)
    bool chatMode = false,
  }) async {
    final payload = <String, Object?>{
      if (text.isNotEmpty) 'text': text,
      if (attachments.isNotEmpty) 'attachments': attachments,
      'approval_mode': _normalizeApprovalMode(approvalMode),
      if (chatMode) 'chat_mode': true,
    };
    /* 立刻本地占位 —— 不等电脑把 user_message 回显回来.
     *
     * 这套占位机制 (setPendingUserText / pendingUserTextProvider / 收到回显时
     * clearPendingUserText) 早就写好了, timeline 和 composer 两处都在 watch,
     * setPendingUserText 的文档注释甚至写着"composer 点发送时 immediately 设"
     * —— 唯独**全项目没有一个地方调用它**。于是发出去到回显到达之间, 屏幕上
     * 你说的话根本不存在。
     *
     * 而实时那条回显还不一定来: 电脑的 EntryLog 事件走 SessionContext.onAppend,
     * 跨进程时不通 (wsServer.ts 注释原话), 实测启动后只有第一个会话推得出来,
     * 之后全靠重新订阅时补发。也就是说这一轮里, 用户发的话在手机上是**彻底
     * 看不见**的, 直到下次进这个会话。
     *
     * 占位由本地立刻给出, 回显到了再被真事件替换 (那份有真 seq, 会持久化)。
     * 重复渲染不用担心: timeline_state 对 user_message 本来就按
     * message_id / (文本 + 5 秒窗口) 去重, 这正是它当初被写出来要解的场景。 */
    if (text.isNotEmpty) {
      _ref
          .read(streamBufferProvider.notifier)
          .setPendingUserText(sessionId, text);
    }
    await _sendInput(
      sessionId: sessionId,
      kind: 'user_message',
      payload: payload,
    );
  }

  /// 控制指令 (control:pause / control:cancel / control:resume / control:takeover
  /// / control:stop_agent) — 跟 sendMessage 同款路由.
  /// [payload] 给需要带参的控制用 (如 stop_agent 的 agent_id)。
  Future<void> sendControl({
    required String sessionId,
    required String kind,
    Map<String, Object?> payload = const {},
  }) async {
    /* 重试要沿用这个会话的模式 —— 聊天模式里重试不能突然带上全套工具 */
    final withMode = kind == 'control:retry' && _ref.read(chatModeProvider).isOn(sessionId)
        ? {...payload, 'chat_mode': true}
        : payload;
    await _sendInput(sessionId: sessionId, kind: kind, payload: withMode);
  }

  Future<void> _sendInput({
    required String sessionId,
    required String kind,
    required Map<String, Object?> payload,
  }) async {
    final db = _ref.read(appDatabaseProvider);
    final mirror = await db.sessionMirrorDao.findById(sessionId);
    if (mirror == null || isPhoneLocalDeviceId(mirror.desktopDeviceId)) {
      await _ref
          .read(phoneLocalAgentProvider)
          .sendInput(sessionId: sessionId, kind: kind, payload: payload);
    } else {
      /* 先确保订阅就位再发 —— 顺序反了会**丢消息**。
       *
       * 桌面收到 session.input 立刻开始吐事件; 订阅要是还没登记上, 那一段事件
       * 就永远收不到, 而且不会有任何报错。真机实录: 手机发完一条, 会话里只落了
       * 一条 seq=3 的 agent_text, seq 1/2 (用户自己那条 user_message 的回显 +
       * agent 开头输出) 整个消失 —— 用户在手机上看不到自己刚说了什么。
       *
       * 补发也救不了: subscribe 那一刻桌面 last_committed_seq 还是 null,
       * latest_seq 报 0, 本地 localMax 也是 0, `latest > localMax` 不成立,
       * 补发整个不触发。所以只能从源头保证"先订阅, 后触发事件"。 */
      final ws = _ref.read(wsClientProvider.notifier);
      /* 终端会话 / 客户端会话: 先连到这条会话的主人, 别发给同一台电脑的另一个入口 */
      await ws.ensureConnectedToSessionOwner(sessionId);
      await ws.ensureSubscribed(sessionId);
      await ws.sendInput(sessionId: sessionId, kind: kind, payload: payload);
    }
  }

  // ────────────────────────────────────────────────────────────
  //  Internals
  // ────────────────────────────────────────────────────────────

  bool _isConnectedTo(String deviceId) {
    final s = _ref.read(wsClientProvider);
    return s.connection == WsConnectionState.connected &&
        s.transport != WsTransport.cloudAgent &&
        s.activeDesktopDeviceId == deviceId;
  }

  /// 云端能不能新建 (服务端开关 + 登录) —— 判据在发行版的 [CloudAgentAccess.canCreate]。
  bool _cloudAvailable() =>
      _ref.read(cloudAgentAccessProvider)?.canCreate ?? false;

  /// 给可连桌面排序 —— **当前正连着的排第一**, 其次按最近连接时间倒序.
  ///
  /// 2026-07-28 真机实锤的 P0: 原来 `connectableDesktops()` 直接把 DAO 的 `getAll()`
  /// 过滤一下就 `.first`, **没有任何排序**, 拿到的是插入顺序最早的那台 —— 也就是用户
  /// 最早配对、往往早就换网/关机的老电脑。
  ///
  /// 后果是一条完整的坏链路:
  ///   选「我的电脑」→ 命中失联老机 → `_createDesktopSession` 见没连它, 于是
  ///   `connectToDesktop(老机)` **把当前那条健康连接顶掉** → `_waitForDesktopReady`
  ///   空等 12s 超时 → 抛错。用户看到的是"发不出去", 而设备页还把老机标成「当前」、
  ///   顶部写「未连接电脑」—— 明明刚配好的电脑 WS 已经 authenticated。
  ///
  /// 所以这里的排序不只是"挑得更准", 它同时消除了**发送动作劫持 activeDesktopDeviceId**
  /// 这个副作用: 已连接的那台永远排第一, `_createDesktopSession` 的 `connectedToTarget`
  /// 直接命中, 不会再去 connect 别的设备。
  /// 从可连列表里挑一台 —— 尊重用户的「首选电脑」, 而不是永远拿排序第一台.
  ///
  ///   2026-08-04 用户实录: 配了多台电脑却切不了, 消息发去了一台没在干活的机器,
  ///   而 UI 只写"我的电脑"不写是哪台, 所以连错了也看不出来。
  ///   首选存在且当前可连 → 用它; 连不上 → 落回排序第一 (别把人卡死),
  ///   调用方可据返回值与首选是否一致来提示"已临时改用 X"。
  ///
  /// 2026-09-22: 提到最前这件事收进 [hoistPreferred] 纯函数。原来三个调用点
  /// (这里 / ws_client_provider / startup_coordinator) 各写一遍, 而
  /// startup_coordinator 那份漏了 —— 首选 Mac 的人每次冷启动都连去 Windows。
  /// 2026-09-26: 刚断开的「当前电脑」排在首选之上 (见 orderByUserIntent) ——
  /// 否则 Wi-Fi 一切, 新建会话就被发去心跳更新鲜的另一台。
  PairedDesktop _pickDesktop(List<PairedDesktop> ranked) => orderByUserIntent(
        ranked,
        preferredDeviceId: _ref.read(preferredDesktopProvider),
        currentDeviceId: _ref.read(wsClientProvider.notifier).currentDesktopId,
        deviceId: (d) => d.deviceId,
      ).first;

  List<PairedDesktop> _rankDesktops(List<PairedDesktop> desktops) {
    final ws = _ref.read(wsClientProvider);
    return rankDesktopsForRouting<PairedDesktop>(
      desktops,
      deviceId: (d) => d.deviceId,
      lastConnectedAt: (d) => d.lastConnectedAt,
      pairedAt: (d) => d.pairedAt,
      /* 服务端记的存活时间 —— 让"还活着的那台"压过"我上次连过的那台" */
      lastAnnounceAt: (d) => d.lastAnnounceAt,
      /* 只有真连着才算 live —— 传"曾经 active"进去就退化回老 bug */
      liveDeviceId:
          (ws.connection == WsConnectionState.connected &&
              ws.transport != WsTransport.cloudAgent)
          ? ws.activeDesktopDeviceId
          : null,
    );
  }

  /// 在电脑上建会话.
  ///
  /// [modelHint] 必须传下去 (2026-09-18 用户实录: 输入框选的是 deepseek, 发完变成 kimi-k3)。
  /// 电脑那头 session.create 不认模型时会**继承同工作区最近一条会话的模型**, 于是用户在
  /// 手机上选的模型被悄悄换掉。新协议里 session.create 收 model_id; 老版本电脑不认这个参数,
  /// 所以建完再显式 set 一次, 两边都能对上。
  Future<String> _createDesktopSession(
    PairedDesktop desktop, {
    String? agentMode,
    String? modelHint,
  }) async {
    var wsState = _ref.read(wsClientProvider);
    final connectedToTarget =
        wsState.connection == WsConnectionState.connected &&
        wsState.transport != WsTransport.cloudAgent &&
        wsState.activeDesktopDeviceId == desktop.deviceId;
    if (!connectedToTarget) {
      await _ref
          .read(wsClientProvider.notifier)
          .connectToDesktop(desktop.deviceId);
      await _waitForDesktopReady(desktop.deviceId);
      wsState = _ref.read(wsClientProvider);
    }
    if (wsState.connection != WsConnectionState.connected ||
        wsState.transport == WsTransport.cloudAgent ||
        wsState.activeDesktopDeviceId != desktop.deviceId) {
      throw StateError(tr('电脑暂时连不上，请稍后重试'));
    }
    final ws = _ref.read(wsClientProvider.notifier);
    /* 选过项目就在那个项目里建 (2026-09-18 用户: 「选择项目后 就应该是这个项目
     * 新建会话等」)。原来无论选没选项目, 首页开的新会话都落在电脑当前工作区 ——
     * 于是"选项目"只对那一条会话有效, 下一条又跑回去了。
     *
     * 2026-09-22: 建不出来就**如实报错**, 不再悄悄落回电脑当前工作区。
     * 落回去的会话在另一个项目里跑, 而首页药丸还写着你选的项目 —— 代码改到哪了
     * 都不知道。电脑那头现在会自己把没打开的项目打开, 换电脑时项目也会被清掉,
     * 剩下的失败都是真原因 (目录没了 / 没配模型), 该让人看见。 */
    final project = _ref.read(currentProjectProvider);
    if (project != null && project.path.isNotEmpty) {
      final inProject = await ws.createSessionInWorkspace(
        workspacePath: project.path,
        agentMode: agentMode,
        modelId: modelHint,
      );
      if (inProject == null || inProject.isEmpty) {
        throw StateError(tr('电脑暂时连不上，请稍后重试'));
      }
      await _applyModelHint(ws, inProject, modelHint);
      return inProject;
    }
    final id = await ws.createSession(agentMode: agentMode, modelId: modelHint);
    if (id == null) throw StateError(tr('电脑没有返回任务 ID'));
    await _applyModelHint(ws, id, modelHint);
    return id;
  }

  /// 老版本电脑忽略 model_id → 建出来的会话还是它自己继承的模型。补一发 set_model。
  /// 'auto' 不下发: 那是"让系统挑", 不是一个真实模型 id。
  Future<void> _applyModelHint(
    dynamic ws,
    String sessionId,
    String? modelHint,
  ) async {
    if (modelHint == null || modelHint.isEmpty || modelHint == 'auto') return;
    try {
      await ws.updateSessionModel(sessionId, modelHint);
    } catch (e) {
      debugPrint('[session_router] 建会话后补设模型失败: $e');
    }
  }

  Future<void> _waitForDesktopReady(String desktopDeviceId) async {
    const interval = Duration(milliseconds: 250);
    const maxTicks = 48; // 12s
    for (var i = 0; i < maxTicks; i++) {
      final s = _ref.read(wsClientProvider);
      if (s.activeDesktopDeviceId == desktopDeviceId &&
          s.connection == WsConnectionState.connected &&
          s.transport != WsTransport.cloudAgent) {
        return;
      }
      await Future<void>.delayed(interval);
    }
  }

  Future<({String sessionId, String agentDeviceId})> _createCloudSession({
    String? modelId,
    String? agentMode,
  }) async {
    final cloud = _ref.read(cloudAgentAccessProvider);
    if (cloud == null) throw StateError(tr('云端 Agent 不可用'));
    final result = await cloud.createSession(
      modelHint: modelId,
      agentMode: agentMode == 'work' || agentMode == 'code' ? agentMode : null,
    );
    unawaited(
      _ref
          .read(wsClientProvider.notifier)
          .connectToDesktop(result.agentDeviceId),
    );
    return result;
  }
}

/// 把 composer 的 wire / 兼容别名归一成 desktop setApprovalMode 认的三档.
String _normalizeApprovalMode(String raw) {
  switch (raw.trim().toLowerCase()) {
    case 'yolo':
    case 'dangerous':
      return 'dangerous';
    case 'plan':
    case 'manual':
      return 'manual';
    case 'auto':
    default:
      return 'auto';
  }
}

final sessionRouterProvider = Provider<SessionRouter>((ref) {
  return SessionRouter(ref);
});
