/// chat_repeat_guard.dart — 防跑飞: 同一轮里同工具同参数重复调用直接拦 (总控裁决第六节).
///
/// 不在额度上抠: 模型卡进「原样重发」的死循环时, 同样的参数再跑一遍只会拿到同样的结果 ——
/// 搜索白等一轮, 出图白花一笔。拦下它、把上一份结果指给它, 它就能接着作答。
///
/// 只记**已经成功返回**的调用: 上一次抛异常时重试是正当的。
/// 计数按实例算 —— 每次发送新建一份, 不跨轮累加。
library;

import 'dart:convert';

import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;

class ChatRepeatGuard implements sdk.AgentTool, sdk.ParallelSafeTool {
  ChatRepeatGuard(this._inner);

  final sdk.AgentTool _inner;
  final Set<String> _done = <String>{};

  /// 在飞的调用 —— 同一轮的多个调用是**并发**跑的, 第二个同参数调用可能在
  /// 第一个还没返回时就到了; 只查 [_done] 会漏拦, 两份搜索 / 两张一样的图就都出去了。
  final Map<String, Future<sdk.ToolResult>> _inflight = {};

  /// 这一轮已经成功执行过的调用数 (测试 / 日志用)
  int get doneCount => _done.length;

  @override
  sdk.ToolSpec get spec => _inner.spec;

  @override
  bool get parallelSafe => _inner is sdk.ParallelSafeTool && (_inner as sdk.ParallelSafeTool).parallelSafe;

  @override
  Future<sdk.ToolResult> run(
    Map<String, Object?> args,
    sdk.ToolContext ctx,
  ) async {
    final key = canonicalChatArgs(args);
    if (_done.contains(key)) return _repeated();
    final running = _inflight[key];
    if (running != null) {
      /* 等它跑完再回话: 模型看到的是「已经有结果了」, 而不是两条并行结果 */
      try {
        await running;
      } catch (_) {/* 前一个失败了, 这里只负责回「别重复」 */}
      return _repeated();
    }
    final future = _inner.run(args, ctx);
    _inflight[key] = future;
    try {
      final result = await future;
      if (!result.isError) _done.add(key);
      return result;
    } finally {
      _inflight.remove(key);
    }
  }

  sdk.ToolResult _repeated() => sdk.ToolResult.error(
        '你刚刚已经用同样的参数调用过 ${_inner.spec.name}, 结果就在上面的对话里。'
        '不要重复调用 —— 直接用那个结果; 要不同结果就换参数。',
      );
}

/// 参数的规范串 (键排序) —— 用来判断「同工具同参数」。
String canonicalChatArgs(Map<String, Object?> args) {
  Object? sortValue(Object? v) {
    if (v is Map) {
      final keys = v.keys.map((k) => '$k').toList()..sort();
      return {for (final k in keys) k: sortValue(v[k])};
    }
    if (v is List) return v.map(sortValue).toList();
    return v;
  }

  try {
    return jsonEncode(sortValue(args));
  } catch (_) {
    return args.toString();
  }
}
