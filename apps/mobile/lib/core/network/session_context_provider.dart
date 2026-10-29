/// session_context_provider.dart — 拿当前 session 用的 model 的 contextWindow.
///
/// 数据来源:
///   1. session.get → modelId
///   2. model.list → 找匹配 model 的 contextWindow
/// 缓存到首页打开 timeline 时拉一次, 切换 model 时手动 refresh.
///
/// 注: mobile 端目前不追踪"已用 tokens" (desktop 把 run_result 转成无 payload 的
/// agent_turn_done 就 drop 了). UI 先显示 max, 已用走 desktop run_result 真正
/// 透传给 phone 那一步再补.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../execution/run_target.dart';
import '../local_agent/phone_local_agent.dart';
import '../storage/database.dart';
import 'ws_client_provider.dart';

class SessionContextInfo {
  const SessionContextInfo({
    required this.contextWindow,
    required this.modelId,
    required this.modelName,
    this.contextTokens = 0,
  });
  final int? contextWindow;
  final String modelId;
  final String modelName;
  /// 当前 context 实际占用 tokens (来自 desktop token_usage event 推过来的 context_tokens)
  final int contextTokens;

  SessionContextInfo copyWith({int? contextTokens}) => SessionContextInfo(
        contextWindow: contextWindow,
        modelId: modelId,
        modelName: modelName,
        contextTokens: contextTokens ?? this.contextTokens,
      );
}

class SessionContextController extends StateNotifier<SessionContextInfo?> {
  SessionContextController(this._ref, this.sessionId) : super(null) {
    _refresh();
    /* 连接就绪是另一个补拉时机 —— app 冷启动时 provider 先于 WS 客户端建好,
     * 首次 _refresh 必然拿不到 (fetchSessionInfo 里 `c == null` 静默返 null)。
     * 只靠 context_usage 补拉的话, 没有活跃 turn 就永远等不到那条事件,
     * 菜单里的上下文行一直是空的 (2026-07-29 真机)。 */
    _ref.listen<WsClientState>(wsClientProvider, (prev, next) {
      if (prev?.connection == next.connection) return;
      if (next.connection != WsConnectionState.connected) return;
      if (state?.contextWindow != null) return;
      unawaited(_refresh());
    });
  }
  final Ref _ref;
  final String sessionId;

  Future<void> refresh() => _refresh();

  /// 元数据 (modelId / contextWindow) 还没拿到过 —— 用来决定要不要补拉.
  bool get _metaMissing => state?.contextWindow == null;
  bool _refreshing = false;
  int _metaRetries = 0;
  /// 最多补拉几次: 拿不到就是真没有 (模型不在 list), 别每条 metrics 都打一次 RPC.
  static const _maxMetaRetries = 3;

  /// 收到 desktop 推的 context_usage event 时调 — 更新已用 tokens.
  ///
  /// **state 为 null 时也要收下**: 已用量是桌面每轮推过来的真实数据, 它不该依赖
  /// 模型元数据 (_refresh 拿 modelId / contextWindow) 是否成功。之前 `cur == null`
  /// 直接 return, 于是只要 _refresh 没跑通 (模型不在 model.list / session.get 没给
  /// modelId), 用户就**永远**看不到上下文占用 —— 哪怕桌面一直在推准确数字
  /// (2026-07-29 真机: 桌面 used=22808, 手机什么都不显示)。
  /// 没有 window 就只显示"已用 N", 比什么都没有强。
  void onContextUsage(int tokens) {
    if (tokens <= 0) return;
    /* 补拉元数据的天然时机 —— 这条事件是桌面推过来的, 说明连接**此刻**是通的。
     *
     * 根因 (2026-07-29 真机): `_refresh()` 只在 provider 构造时跑一次, 而 app 刚
     * 启动那一刻 WS 客户端常常还没就绪, `fetchSessionInfo` 里
     * `if (c == null) return null;` 静默返回 → modelId 判空 → contextWindow 永远
     * 拿不到, 而且**再也不会重试**。表现就是: 库里 modelId 明明是
     * `deepseek:deepseek-v4-pro`, 手机却一直显示不出上下文环。 */
    if (_metaMissing && !_refreshing && _metaRetries < _maxMetaRetries) {
      _metaRetries++;
      unawaited(_refresh());
    }
    final cur = state;
    if (cur == null) {
      state = SessionContextInfo(
        contextWindow: null,
        modelId: '',
        modelName: '',
        contextTokens: tokens,
      );
      return;
    }
    if (cur.contextTokens == tokens) return;
    state = cur.copyWith(contextTokens: tokens);
  }

  Future<void> _refresh() async {
    if (_refreshing) return;
    _refreshing = true;
    try {
      // 手机本地 session 不存在于 desktop —— 绝不能问 desktop session.get。
      // 否则 desktop 返 "session not found", 而 ws.fetchSessionInfo 的副作用会把刚新建的
      // 手机会话本地 mirror 删掉 → timeline 误报"这个任务已在电脑上删除"。这是该 bug 的根因:
      // timeline 自己的 _loadSessionInfo 路由对了, 但这个 context chip provider 漏判了。
      final db = _ref.read(appDatabaseProvider);
      final mirror = await db.sessionMirrorDao.findById(sessionId);
      if (mirror != null && isPhoneLocalDeviceId(mirror.desktopDeviceId)) {
        final pinfo =
            await _ref.read(phoneLocalAgentProvider).fetchSessionInfo(sessionId);
        final mid = pinfo?.modelId;
        if (mounted) {
          state = (mid == null || mid.isEmpty)
              ? null
              : SessionContextInfo(
                  contextWindow: null,
                  modelId: mid,
                  modelName: mid,
                  contextTokens: 0,
                );
        }
        return;
      }
      final ws = _ref.read(wsClientProvider.notifier);
      final info = await ws.fetchSessionInfo(sessionId);
      if (info == null) {
        /* 连接还没就绪 / RPC 失败 —— 不是"这个会话没有模型", 下次 context_usage
         * 到达时会再试 (那时连接必然是通的)。 */
        debugPrint('[session_context] session.get returned null for $sessionId '
            '(retry $_metaRetries/$_maxMetaRetries)');
        return;
      }
      final modelId = info.modelId;
      /* desktop 把 sessionStore.contextUsed 透传过来, 进 timeline 立刻 seed chip,
       * 不用等下一轮 agent metrics 才显数. 0 = 全新 session / 从未跑过 turn. */
      final seededTokens = info.currentContextTokens;
      if (modelId == null || modelId.isEmpty) {
        debugPrint('[session_context] no modelId for $sessionId — '
            'keep tokens only');
        /* 不能置 null: 那会把 context_usage 已经收到的真实占用抹掉 */
        if (mounted && state == null && seededTokens > 0) {
          state = SessionContextInfo(
            contextWindow: null,
            modelId: '',
            modelName: '',
            contextTokens: seededTokens,
          );
        }
        return;
      }
      final models = await ws.fetchAvailableModels();
      ModelInfo? matched;
      for (final m in models) {
        if (m.id == modelId) { matched = m; break; }
      }
      if (matched == null) {
        /* 偶发: 当前 modelId 不在 list (model 被 disable / BYOK 只用户那台机有).
         * 仍展示 modelId, contextWindow 留空. */
        if (mounted) {
          final live = state?.contextTokens ?? 0;
          state = SessionContextInfo(
            contextWindow: null,
            modelId: modelId,
            modelName: modelId,
            contextTokens: live > seededTokens ? live : seededTokens,
          );
        }
        return;
      }
      if (mounted) {
        /* 实时推来的占用比 seed 新, 不能被 refresh 倒退回去 */
        final live = state?.contextTokens ?? 0;
        state = SessionContextInfo(
          contextWindow: matched.contextWindow,
          modelId: modelId,
          modelName: matched.name,
          contextTokens: live > seededTokens ? live : seededTokens,
        );
      }
    } catch (e) {
      if (kDebugMode) debugPrint('[session_context] refresh failed: $e');
    } finally {
      _refreshing = false;
    }
  }

  /// 用户在 timeline 主动切了模型 — contextTokens 归零等新模型下一轮 metrics.
  /// 不用 _refresh() 是因为那个会从 desktop seed 旧值, 切模型语义上要清零.
  void resetForModelSwitch() {
    final cur = state;
    if (cur == null) return;
    state = cur.copyWith(contextTokens: 0);
    // 异步 refresh 拉新 modelId / contextWindow, contextTokens 由 refresh 重设
    unawaited(_refresh());
  }
}

final sessionContextProvider = StateNotifierProvider.family<
    SessionContextController, SessionContextInfo?, String>(
  (ref, sessionId) => SessionContextController(ref, sessionId),
);
