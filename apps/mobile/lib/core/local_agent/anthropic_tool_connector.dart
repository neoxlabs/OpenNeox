/// anthropic_tool_connector.dart — Agent SDK 的 LlmConnector 适配器 (Anthropic 协议).
///
/// 覆盖 BYOK Anthropic 协议厂商 (官方 Claude API + Anthropic 兼容中转站).
/// 真机实锤 (2026-07-20): 用户主力模型 grok-4.5 挂在 Anthropic 协议中转站上,
/// 只接 OpenAI 协议工具循环 = 主力模型没工具, 必须两条协议都接.
///
/// wire 差异 (vs OpenAI):
///   - 请求 tools: [{name, description, input_schema}] (无 type:function 包装)
///   - 工具调用流: content_block_start(type=tool_use, id, name)
///     → input_json_delta.partial_json 逐帧拼 → content_block_stop
///   - 回灌: assistant content [{type:'tool_use',...}] +
///     user content [{type:'tool_result', tool_use_id, content}]
library;

import 'dart:convert';

import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;

import '../byok/byok_models.dart';
import '../llm/chat_backend.dart';
import '../llm/llm_http.dart';
import '../llm/sse.dart';

class AnthropicToolConnector implements sdk.LlmConnector {
  AnthropicToolConnector({
    required this.http,
    required this.provider,
    required this.modelId,
    this.maxTokens = 4096,
    this.temperature,
    this.sessionId,
    this.onRequestSent,
  });

  final LlmHttp http;
  final ByokProviderConfig provider;
  final String modelId;
  final int maxTokens;

  /// 会话头: opencode (Zen / Go) 不带就 400 MissingSessionID; 认不出的上游忽略它 (同桌面 anthropicSessionHeaders.ts)
  final String? sessionId;

  /// null = 厂商默认.
  final double? temperature;

  /// 请求马上要发出去前回调一次 —— 只在埋点用 (点发送 → 发出请求 → 首字, `[chat-ttft]`).
  final void Function()? onRequestSent;

  @override
  Stream<sdk.LlmDelta> stream({
    required List<sdk.ChatMessage> messages,
    required List<sdk.ToolSpec> tools,
    required sdk.AgentCancelToken cancel,
  }) async* {
    final converted = convertOpenAiToAnthropic(messages);
    final body = jsonEncode({
      'model': modelId,
      'max_tokens': maxTokens,
      if (temperature != null) 'temperature': temperature,
      if (converted.system.isNotEmpty) 'system': converted.system,
      'messages': converted.messages,
      'stream': true,
      if (tools.isNotEmpty)
        'tools': [
          for (final t in tools)
            {
              'name': t.name,
              'description': t.description,
              'input_schema': t.parameters,
            },
        ],
    });

    final appCancel = CancelToken();
    final sub = cancel.onCancel.listen((_) => appCancel.cancel());
    if (cancel.isCancelled) appCancel.cancel();

    /* tool_use block 聚合: content block index → id/name/inputJson 拼片 */
    final useIds = <int, String>{};
    final useNames = <int, String>{};
    final useArgs = <int, StringBuffer>{};

    try {
      onRequestSent?.call();
      final events = http.streamSse(
        url: '${provider.baseUrl}/v1/messages',
        headers: {
          'x-api-key': provider.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          if (sessionId != null) 'session_id': sessionId!,
          ...provider.extraHeaders,
        },
        body: body,
        providerName: provider.name,
        cancel: appCancel,
      );

      await for (final ev in events) {
        if (ev.data.isEmpty) continue;
        Map<String, dynamic>? frame;
        try {
          final parsed = jsonDecode(ev.data);
          if (parsed is Map<String, dynamic>) frame = parsed;
        } catch (_) {
          continue;
        }
        if (frame == null) continue;
        final type = (ev.event ?? frame['type'] ?? '') as String;

        switch (type) {
          case 'error':
            throw ChatBackendException(
              '${provider.name} 返回错误 — ${extractVendorErrorMessage(ev.data)}',
              /* overloaded_error / api_error 是 Anthropic 自己说的"稍后再试" */
              retryable: frame['error'] is Map &&
                  const {'overloaded_error', 'api_error'}.contains((frame['error'] as Map)['type']),
            );
          case 'content_block_start':
            {
              final block = frame['content_block'];
              if (block is Map && block['type'] == 'tool_use') {
                final idx = _asInt(frame['index']);
                final id = block['id'];
                final name = block['name'];
                if (id is String && id.isNotEmpty) useIds[idx] = id;
                if (name is String && name.isNotEmpty) useNames[idx] = name;
              }
              continue;
            }
          case 'content_block_delta':
            {
              final delta = frame['delta'];
              if (delta is! Map) continue;
              final dType = delta['type'];
              if (dType == 'text_delta') {
                final t = delta['text'];
                if (t is String && t.isNotEmpty) {
                  yield sdk.LlmDelta(text: t);
                }
              } else if (dType == 'thinking_delta') {
                final t = delta['thinking'];
                if (t is String && t.isNotEmpty) {
                  yield sdk.LlmDelta(thinking: t);
                }
              } else if (dType == 'input_json_delta') {
                final j = delta['partial_json'];
                if (j is String && j.isNotEmpty) {
                  useArgs
                      .putIfAbsent(_asInt(frame['index']), StringBuffer.new)
                      .write(j);
                }
              }
              continue;
            }
          /* message_stop / message_delta / ping — 流尾统一处理 */
        }
      }

      if (useNames.isNotEmpty) {
        final calls = <sdk.LlmToolCall>[];
        final idxs = useNames.keys.toList()..sort();
        for (final i in idxs) {
          Map<String, Object?> args = const {};
          final raw = useArgs[i]?.toString() ?? '';
          if (raw.isNotEmpty) {
            try {
              final p = jsonDecode(raw);
              if (p is Map<String, Object?>) args = p;
            } catch (_) {
              args = {'_raw': raw};
            }
          }
          calls.add(sdk.LlmToolCall(
            id: useIds[i] ?? 'toolu_$i',
            name: useNames[i]!,
            arguments: args,
          ));
        }
        yield sdk.LlmDelta(toolCalls: calls);
      }
    } on ChatCancelled {
      throw const sdk.AgentCancelled();
    } finally {
      await sub.cancel();
    }
  }

  int _asInt(dynamic v) => v is num ? v.toInt() : 0;
}

/// OpenAI shape → Anthropic messages 转换 (含工具回灌消息).
///
/// 支持的输入形态:
///   {role:'system', content:String}                → top-level system
///   {role:'user'|'assistant', content:String|parts} → text/image blocks
///   {role:'assistant', tool_calls:[...]}            → tool_use blocks
///   {role:'tool', tool_call_id, content}            → user tool_result block
/// 相邻同 role 合并 (Anthropic 要求 user/assistant 严格交替).
({String system, List<Map<String, Object?>> messages}) convertOpenAiToAnthropic(
  List<Map<String, Object?>> input,
) {
  final systemBuf = StringBuffer();
  final out = <Map<String, Object?>>[];

  void addBlocks(String role, List<Object?> blocks) {
    if (blocks.isEmpty) return;
    if (out.isNotEmpty && out.last['role'] == role) {
      (out.last['content'] as List).addAll(blocks);
    } else {
      out.add({'role': role, 'content': blocks});
    }
  }

  for (final m in input) {
    final role = (m['role'] as String?) ?? 'user';
    final content = m['content'];

    if (role == 'system') {
      if (content is String && content.isNotEmpty) {
        if (systemBuf.isNotEmpty) systemBuf.write('\n\n');
        systemBuf.write(content);
      }
      continue;
    }

    if (role == 'tool') {
      final id = (m['tool_call_id'] as String?) ?? '';
      addBlocks('user', [
        {
          'type': 'tool_result',
          'tool_use_id': id,
          'content': content is String ? content : jsonEncode(content),
        },
      ]);
      continue;
    }

    final anthropicRole = role == 'assistant' ? 'assistant' : 'user';
    final blocks = <Object?>[..._contentBlocks(content)];

    /* assistant tool_calls → tool_use blocks */
    final toolCalls = m['tool_calls'];
    if (role == 'assistant' && toolCalls is List) {
      for (final tc in toolCalls) {
        if (tc is! Map) continue;
        final fn = tc['function'];
        Map<String, Object?> args = const {};
        if (fn is Map && fn['arguments'] is String) {
          try {
            final p = jsonDecode(fn['arguments'] as String);
            if (p is Map<String, Object?>) args = p;
          } catch (_) {}
        }
        blocks.add({
          'type': 'tool_use',
          'id': tc['id'] ?? '',
          'name': fn is Map ? (fn['name'] ?? '') : '',
          'input': args,
        });
      }
    }
    addBlocks(anthropicRole, blocks);
  }
  return (system: systemBuf.toString(), messages: out);
}

List<Object?> _contentBlocks(Object? content) {
  if (content is String) {
    return content.isEmpty
        ? const []
        : [
            {'type': 'text', 'text': content},
          ];
  }
  if (content is! List) return const [];
  final parts = <Object?>[];
  for (final p in content) {
    if (p is! Map) continue;
    if (p['type'] == 'text' && p['text'] is String) {
      parts.add({'type': 'text', 'text': p['text']});
    } else if (p['type'] == 'image_url') {
      final url =
          p['image_url'] is Map ? ((p['image_url'] as Map)['url'] as String?) : null;
      if (url != null && url.startsWith('data:')) {
        final comma = url.indexOf(',');
        if (comma > 0) {
          final mediaType = url.substring(5, comma).split(';').first;
          parts.add({
            'type': 'image',
            'source': {
              'type': 'base64',
              'media_type': mediaType.isEmpty ? 'image/jpeg' : mediaType,
              'data': url.substring(comma + 1),
            },
          });
        }
      }
    }
  }
  return parts;
}
