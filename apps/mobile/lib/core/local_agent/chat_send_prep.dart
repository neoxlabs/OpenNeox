/// chat_send_prep.dart — 手机 Chat 发送前的准备 (Chat 方案 C8-03 / C8-04, P0).
///
/// 1. [prepareChatSend]: 互不依赖的前置步骤 (BYOK 就绪 / 模型 / 会话模式 / 历史 / 身份)
///    一起等。以前一项接一项 await, 弱网下光排队就白等几百毫秒。
/// 2. [ChatEnvironmentCache]: 环境采集不再挡首字。有上一轮那份就直接用; 首轮最多等
///    [ChatEnvironmentCache.firstTurnBudget] (300ms), 超时先不带环境发, 后台补好,
///    下一轮带上。
/// 3. [ChatTurnTiming]: 每轮记「点发送 → 发出请求」「发出请求 → 首字」两段耗时,
///    写 `[chat-ttft]` 前缀的日志, 并通过 [ChatTurnTiming.onMetric] 交给调用方入库
///    (chat:C8-11, 表见 storage/tables.dart 的 chat_turn_samples)。
///
/// 环境段拼在 system prompt 末尾 (只到日期 + 星期, 见 agent_environment.dart)。
/// 每轮重新采集都可能带回变化的内容, 把「system + 已有历史」这段缓存前缀打穿,
/// 所以缓存**按 TTL 整段复用**, 而不是每轮刷新后立刻采用: 同一个 TTL 窗口内两轮
/// 请求的 system 段逐字节相同。窗口默认 10 分钟, 到期后重新采集一次; 采集再慢也
/// 只让那一轮多等 ≤300ms。
///
/// 分钟级的当前时间不走这里, 由 userMessageWithTimeTag 按每条用户消息自己的落库时刻
/// 挂在消息末尾
/// (current_time_tag.dart) —— 缓存里的日期最多差到跨天, 差不了几分钟。
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../telemetry/chat_metric.dart';

/// 发送前算好的一组东西 —— 见 [prepareChatSend].
class ChatSendPrep {
  const ChatSendPrep({
    required this.modelId,
    required this.agentMode,
    required this.messages,
    required this.persona,
  });

  /// 这一轮实际用的模型 (会话里记的模型下架了就换成默认).
  final String modelId;

  /// 会话记的模式 ('chat' / 'work' / 'code' / null) —— 判轻聊天、编码提示都用它.
  final String? agentMode;

  /// 给模型的历史 (含 system).
  final List<Map<String, Object?>> messages;

  /// 会话专属身份 (Pilot); 没有就是空串. 跟 [messages] 里那条 system 同一次采集.
  final String persona;
}

/// 把互不依赖的几项准备并行等完, 结果跟一项项 await 完全一致.
/// [eagerError] 保持"谁先出错先抛谁", 跟串行时的行为一样, 不额外拖时间.
Future<ChatSendPrep> prepareChatSend({
  required Future<void> byokReady,
  required Future<String> modelId,
  required Future<String?> agentMode,
  required Future<List<Map<String, Object?>>> messages,
  required Future<String> persona,
}) async {
  final result = await Future.wait<Object?>(
    [
      byokReady.then<Object?>((_) => null),
      modelId,
      agentMode,
      messages,
      persona,
    ],
    eagerError: true,
  );
  return ChatSendPrep(
    modelId: result[1]! as String,
    agentMode: result[2] as String?,
    messages: result[3]! as List<Map<String, Object?>>,
    persona: result[4]! as String,
  );
}

/// 环境上下文段的缓存 — 让环境采集不再挡首字.
///
/// 命中 (TTL 内): 直接返回上一轮那份, 同时后台采一份新的存着, **但这一份不立刻
/// 上屏** —— TTL 到了才换上. 这样同一个窗口内每轮请求的 system 段逐字节相同,
/// 前缀缓存不会被我们自己打穿.
/// 过期 / 首轮: 后台已经备好新的一份就直接换上 (零等待); 否则最多等
/// [firstTurnBudget], 超时先不带环境发 (或先用上一份), 采完下一轮用上.
class ChatEnvironmentCache {
  ChatEnvironmentCache({
    this.ttl = const Duration(minutes: 10),
    this.firstTurnBudget = const Duration(milliseconds: 300),
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  /// 整段环境复用多久. 越短越新鲜, 越长前缀缓存越稳.
  final Duration ttl;

  /// 没有可用缓存时最多等多久. 超时就先不带环境发.
  final Duration firstTurnBudget;

  final DateTime Function() _now;

  /// 正在用于发送的那份 (前缀稳定)
  String? _value;
  DateTime? _at;

  /// 后台已经采好的下一份, 等 TTL 到期再换上
  String? _pending;
  DateTime? _pendingAt;

  String? _key;
  Future<String>? _inflight;
  String? _inflightKey;

  Future<String> acquire({
    required String key,
    required Future<String> Function() build,
  }) async {
    if (_key != key) {
      /* 换了模型 / 轻聊天档: 上一份里的「当前模型」「工具」都不对了, 不能再用 */
      _value = null;
      _at = null;
      _pending = null;
      _pendingAt = null;
      _key = key;
    }
    final now = _now();
    final value = _value;
    final at = _at;

    if (value != null && at != null && now.difference(at) < ttl) {
      /* 后台刷新同一份够用就行: 下一份只会在 TTL 到期时被换上, 采太勤是白耗电 */
      final pendingAt = _pendingAt;
      if (pendingAt == null || now.difference(pendingAt) >= ttl) {
        _startRefresh(key, build);
      }
      return value;
    }

    if (value != null) {
      /* 过期了: 后台已经备好新的就直接换上, 不再等这一轮 */
      final pending = _pending;
      final pendingAt = _pendingAt;
      if (pending != null && pendingAt != null && now.difference(pendingAt) < ttl) {
        _value = pending;
        _at = pendingAt;
        _pending = null;
        _pendingAt = null;
        _startRefresh(key, build);
        return _value!;
      }
    }

    final fut = _startRefresh(key, build);
    try {
      return await fut.timeout(firstTurnBudget);
    } on TimeoutException {
      /* 采集慢: 宁可这一轮先不带环境 (或先用上一份), 也不能让用户等.
       * 后台那份跑完会存进来, 下一轮直接用. */
      return value ?? '';
    } catch (_) {
      return value ?? '';
    }
  }

  Future<String> _startRefresh(String key, Future<String> Function() build) {
    final running = _inflight;
    if (running != null && _inflightKey == key) return running;

    final fut = build().then((v) {
      /* 采集途中换了 key 的旧结果不要 —— 否则会把别的模型的「当前模型」写回来 */
      if (_key == key) {
        final at = _at;
        final fresh = at == null || _now().difference(at) >= ttl;
        if (fresh) {
          _value = v;
          _at = _now();
          _pending = null;
          _pendingAt = null;
        } else {
          _pending = v;
          _pendingAt = _now();
        }
      }
      return v;
    });
    _inflight = fut;
    _inflightKey = key;
    /* 超时之后这份还在跑: 挂个空监听把它的失败吃掉, 免得变成未捕获异常 */
    fut.then<void>(
      (_) {},
      onError: (Object _) {},
    ).whenComplete(() {
      if (identical(_inflight, fut)) {
        _inflight = null;
        _inflightKey = null;
      }
    });
    return fut;
  }
}

/// 一轮的耗时打点: 点发送 → 请求发出 → 首字。
///
/// 两段分开记: 前段大 = 发送前的准备慢了 (C8-03/04), 后段大 = 模型 / 网络慢。
/// 每次算完除了写日志 (固定前缀 `[chat-ttft]`) 还给 [onMetric] 一份
/// [ChatTurnMetric] —— 手机端拿它写进本地表 (chat:C8-11), 测试里直接拿它断言。
class ChatTurnTiming {
  ChatTurnTiming({
    required this.sessionId,
    DateTime? sendAt,
    DateTime Function()? now,
    void Function(String line)? writeLog,
    this.onMetric,
  })  : sendAt = sendAt ?? DateTime.now(),
        _now = now ?? DateTime.now,
        _writeLog = writeLog ?? debugPrint;

  /// 算完这一轮时回调一次 (只调一次)。回调里别抛 —— 抛了也只丢一条统计。
  final void Function(ChatTurnMetric metric)? onMetric;

  final String sessionId;

  /// 用户点发送的时刻 (sendInput 进来的时候).
  final DateTime sendAt;

  final DateTime Function() _now;
  final void Function(String line) _writeLog;

  /// 日志里带上, 方便按模型 / 轻聊天档分组看.
  String modelId = '';
  bool lightChat = false;

  DateTime? requestAt;
  DateTime? firstTokenAt;
  bool _logged = false;

  /// 请求真正发出 (connector 里发出 SSE 之前). 重试会再调一次, 只认第一次.
  void markRequestSent() => requestAt ??= _now();

  /// 首个带内容的正文字 (思考不算 —— 用户看的还是字).
  void markFirstToken() {
    firstTokenAt ??= _now();
    log();
  }

  /// 一轮结束还没出过字 (报错 / 空回复 / 被取消): 也记一条, `-1` 表示没等到.
  /// 已经打过点就不再重复.
  void logIfUnfinished() => log();

  void log() {
    if (_logged) return;
    _logged = true;
    final req = requestAt;
    final first = firstTokenAt;
    final sendToRequest = req == null ? -1 : req.difference(sendAt).inMilliseconds;
    final requestToFirst =
        (req == null || first == null) ? -1 : first.difference(req).inMilliseconds;
    final total = first == null ? -1 : first.difference(sendAt).inMilliseconds;
    _writeLog(
      '[chat-ttft] session=$sessionId model=${modelId.isEmpty ? '?' : modelId} '
      'light=${lightChat ? 1 : 0} send_to_request=${sendToRequest}ms '
      'request_to_first=${requestToFirst}ms total=${total}ms',
    );
    try {
      onMetric?.call(ChatTurnMetric(
        sessionId: sessionId,
        modelId: modelId,
        lightChat: lightChat,
        sendToRequestMs: sendToRequest,
        requestToFirstMs: requestToFirst,
        firstTokenMs: total,
        gotFirstToken: first != null,
        at: sendAt,
      ));
    } catch (_) {
      /* 统计坏了不能影响这一轮对话 */
    }
  }
}
