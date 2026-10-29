/// openai_tool_connector.dart — Agent SDK 的 LlmConnector 适配器 (OpenAI 协议).
///
/// 覆盖两条链路 (都是 OpenAI chat shape):
///   - 订阅网关 NeoxCloud /n1/chat/completions
///   - BYOK OpenAI 兼容厂商 (OpenAI/DeepSeek/Kimi/GLM/中转站...)
///
/// 职责: 把 SDK 的 (messages + tools) 转成流式请求, 聚合流式 tool_calls 分片
/// (OpenAI 流式协议里 arguments 按 chunk 拼), 流尾一次性交给 SDK.
///
/// Anthropic / Gemini BYOK 的工具循环后续版本再接 — 那两家用各自的工具 wire
/// 格式, 现在先走纯聊天 (phone_local_agent 按 protocol 分流).
library;

import 'dart:convert';

import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;

import '../execution/inference_params_provider.dart' show canToggleThinking;
import '../llm/chat_backend.dart';
import '../llm/llm_http.dart';
import '../llm/sse.dart';

/// 请求参数工厂 — 每次调用现算 (JWT 可能刷新, headers 动态).
typedef OpenAiEndpointBuilder = Future<
    ({String url, Map<String, String> headers, String model})> Function();

class OpenAiToolConnector implements sdk.LlmConnector {
  OpenAiToolConnector({
    required this.http,
    required this.endpoint,
    required this.providerName,
    this.errorTextBuilder,
    this.maxTokens = 4096,
    this.temperature,
    this.noThinking = false,
    this.viaGateway = false,
    this.reasoningEffort,
    this.onRequestSent,
  });

  /// 思考档 low / medium / high (模型面板「思考」分段, 2026-10-14 陶土稿 v5)。
  /// 只在开着思考、走订阅网关时发 —— 网关后面的上游认 `reasoning_effort`; 自己的 Key 直连厂商时不乱塞。
  final String? reasoningEffort;

  /// 请求马上要发出去前回调一次 —— 只在埋点用 (点发送 → 发出请求 → 首字, `[chat-ttft]`).
  /// 断网重试会再发一次, 调用方自己只认第一次.
  final void Function()? onRequestSent;

  /// 关掉思考 (只对能关的模型发, 见 [canToggleThinking]; 别家不认的参数不乱塞)。
  /// 实测 deepseek-v4.1-flash 首字 3.8–10 秒 → 2–3 秒 (2026-10-02 模拟器, Pilot 短问答)
  final bool noThinking;

  /// 走 Neox 订阅网关。网关后面的上游不一样认哪个开关: 同一条渠道上 deepseek-v4-flash 不认
  /// `thinking: disabled` (照样想几十字), 认 `reasoning_effort: none` (2026-10-08 实测) —— 两个一起发。
  /// 用户自己的 Key 直连厂商时只发官方认的 `thinking`, `none` 档 DeepSeek 官方没有。
  final bool viaGateway;

  final LlmHttp http;
  final OpenAiEndpointBuilder endpoint;
  final String providerName;
  final String Function(int status, String body)? errorTextBuilder;
  final int maxTokens;

  /// null = 厂商默认.
  final double? temperature;

  @override
  Stream<sdk.LlmDelta> stream({
    required List<sdk.ChatMessage> messages,
    required List<sdk.ToolSpec> tools,
    required sdk.AgentCancelToken cancel,
  }) async* {
    final ep = await endpoint();
    final body = jsonEncode({
      'model': ep.model,
      'messages': messages,
      'stream': true,
      'stream_options': {'include_usage': true},
      'max_tokens': maxTokens,
      if (temperature != null) 'temperature': temperature,
      if (noThinking && canToggleThinking(ep.model)) 'thinking': {'type': 'disabled'},
      if (noThinking && viaGateway && canToggleThinking(ep.model)) 'reasoning_effort': 'none',
      if (!noThinking && viaGateway && reasoningEffort != null) 'reasoning_effort': reasoningEffort,
      if (tools.isNotEmpty)
        'tools': [
          for (final t in tools) {'type': 'function', 'function': t.toJson()},
        ],
    });

    /* SDK 取消令牌 → app CancelToken 桥接 */
    final appCancel = CancelToken();
    final sub = cancel.onCancel.listen((_) => appCancel.cancel());
    if (cancel.isCancelled) appCancel.cancel();

    /* 流式 tool_calls 聚合: index → (id, name, argsJson 拼片) */
    final callIds = <int, String>{};
    final callNames = <int, String>{};
    final callArgs = <int, StringBuffer>{};

    try {
      onRequestSent?.call();
      final events = http.streamSse(
        url: ep.url,
        headers: ep.headers,
        body: body,
        providerName: providerName,
        cancel: appCancel,
        errorTextBuilder: errorTextBuilder,
      );

      await for (final ev in events) {
        if (ev.data.isEmpty || ev.data == '[DONE]') continue;
        Map<String, dynamic>? frame;
        try {
          final parsed = jsonDecode(ev.data);
          if (parsed is Map<String, dynamic>) frame = parsed;
        } catch (_) {
          continue;
        }
        if (frame == null) continue;
        final err = frame['error'];
        if (err != null) {
          throw ChatBackendException(
            '$providerName 返回错误 — ${extractVendorErrorMessage(ev.data)}',
            /* 网关流中途的错误帧自带 retryable (上游断了 / 超时), 照它的判断走断网重试 */
            retryable: err is Map && err['retryable'] == true,
          );
        }
        final choices = frame['choices'];
        if (choices is! List || choices.isEmpty || choices.first is! Map) {
          continue;
        }
        final delta = (choices.first as Map)['delta'];
        if (delta is! Map) continue;

        String? text;
        String? thinking;
        final c = delta['content'];
        if (c is String && c.isNotEmpty) text = c;
        final r = delta['reasoning_content'] ?? delta['reasoning'];
        if (r is String && r.isNotEmpty) thinking = r;

        final tc = delta['tool_calls'];
        if (tc is List) {
          for (final item in tc) {
            if (item is! Map) continue;
            final idx = (item['index'] is num)
                ? (item['index'] as num).toInt()
                : 0;
            final id = item['id'];
            if (id is String && id.isNotEmpty) callIds[idx] = id;
            final fn = item['function'];
            if (fn is Map) {
              final name = fn['name'];
              if (name is String && name.isNotEmpty) callNames[idx] = name;
              final args = fn['arguments'];
              if (args is String && args.isNotEmpty) {
                callArgs.putIfAbsent(idx, StringBuffer.new).write(args);
              }
            }
          }
        }

        if (text != null || thinking != null) {
          yield sdk.LlmDelta(text: text, thinking: thinking);
        }
      }

      /* 流尾: 聚合完成的 tool_calls 一次性交出 */
      if (callNames.isNotEmpty) {
        final calls = <sdk.LlmToolCall>[];
        final idxs = callNames.keys.toList()..sort();
        for (final i in idxs) {
          final name = callNames[i]!;
          final id = callIds[i] ?? 'call_$i';
          Map<String, Object?> parsedArgs = const {};
          final raw = callArgs[i]?.toString() ?? '';
          if (raw.isNotEmpty) {
            try {
              final p = jsonDecode(raw);
              if (p is Map<String, Object?>) parsedArgs = p;
            } catch (_) {
              /* arguments 不是合法 JSON — 原文塞进 _raw 让工具/模型自己看 */
              parsedArgs = {'_raw': raw};
            }
          }
          calls.add(
            sdk.LlmToolCall(id: id, name: name, arguments: parsedArgs),
          );
        }
        yield sdk.LlmDelta(toolCalls: calls);
      }
    } on ChatCancelled {
      throw const sdk.AgentCancelled();
    } finally {
      await sub.cancel();
    }
  }
}
