/// anthropic_backend.dart — Anthropic Messages API BYOK 适配器.
///
/// 请求: POST `$baseUrl/v1/messages`
///   headers: x-api-key + anthropic-version: 2023-06-01
///   body: { model, max_tokens, system?, messages, stream: true }
///
/// OpenAI shape → Anthropic 转换:
///   - role=system 消息抽出拼 top-level system 字符串
///   - content parts: text 原样; image_url data URL → {type:'image',
///     source:{type:'base64', media_type, data}}
///   - 相邻同 role 消息合并 (Anthropic 要求 user/assistant 交替)
///
/// 响应 SSE (按 event: 类型):
///   content_block_delta → delta.text_delta.text / delta.thinking_delta.thinking
///   message_delta       → usage.output_tokens
///   message_start       → message.usage.input_tokens
///   error               → 抛
library;

import 'dart:convert';

import '../../llm/chat_backend.dart';
import '../../llm/llm_http.dart';
import '../../llm/sse.dart';
import '../byok_models.dart';
import 'package:neox_app/core/i18n/tr.dart';

class AnthropicBackend implements ChatBackend {
  AnthropicBackend({required this.http, required this.provider});

  final LlmHttp http;
  final ByokProviderConfig provider;

  @override
  Stream<ChatDelta> streamChat(ChatRequest request, {CancelToken? cancel}) async* {
    final converted = _convertMessages(request.messages);
    final body = jsonEncode({
      'model': request.modelId,
      'max_tokens': request.maxTokens,
      if (request.temperature != null) 'temperature': request.temperature,
      if (converted.system.isNotEmpty) 'system': converted.system,
      'messages': converted.messages,
      'stream': true,
    });

    final events = http.streamSse(
      url: '${provider.baseUrl}/v1/messages',
      headers: {
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        ...provider.extraHeaders,
      },
      body: body,
      providerName: provider.name,
      cancel: cancel,
    );

    var inputTokens = 0;
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
            tr('${provider.name} 返回错误 — ${extractVendorErrorMessage(ev.data)}'),
          );
        case 'message_start':
          {
            final usage = frame['message'] is Map
                ? ((frame['message'] as Map)['usage'])
                : null;
            if (usage is Map) inputTokens = _asInt(usage['input_tokens']);
            continue;
          }
        case 'content_block_delta':
          {
            final delta = frame['delta'];
            if (delta is! Map) continue;
            final dType = delta['type'];
            if (dType == 'text_delta') {
              final t = delta['text'];
              if (t is String && t.isNotEmpty) yield ChatDelta(text: t);
            } else if (dType == 'thinking_delta') {
              final t = delta['thinking'];
              if (t is String && t.isNotEmpty) yield ChatDelta(thinking: t);
            }
            continue;
          }
        case 'message_delta':
          {
            final usage = frame['usage'];
            if (usage is Map) {
              yield ChatDelta(
                usage: ChatUsage(
                  inputTokens: inputTokens,
                  outputTokens: _asInt(usage['output_tokens']),
                ),
              );
            }
            continue;
          }
        /* message_stop / content_block_start / ping — 不需要 */
      }
    }
  }

  ({String system, List<Map<String, Object?>> messages}) _convertMessages(
    List<Map<String, Object?>> input,
  ) {
    final systemBuf = StringBuffer();
    final out = <Map<String, Object?>>[];

    for (final m in input) {
      final role = (m['role'] as String?) ?? 'user';
      final content = m['content'];
      if (role == 'system') {
        if (content is String) {
          if (systemBuf.isNotEmpty) systemBuf.write('\n\n');
          systemBuf.write(content);
        }
        continue;
      }
      final anthropicRole = role == 'assistant' ? 'assistant' : 'user';
      final parts = _convertContent(content);
      if (parts.isEmpty) continue;
      /* 相邻同 role 合并 — Anthropic 要求严格交替 */
      if (out.isNotEmpty && out.last['role'] == anthropicRole) {
        (out.last['content'] as List).addAll(parts);
      } else {
        out.add({'role': anthropicRole, 'content': parts});
      }
    }
    return (system: systemBuf.toString(), messages: out);
  }

  List<Object?> _convertContent(Object? content) {
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
        final url = p['image_url'] is Map
            ? ((p['image_url'] as Map)['url'] as String?)
            : null;
        final img = _dataUrlToAnthropicImage(url);
        if (img != null) parts.add(img);
      }
    }
    return parts;
  }

  Map<String, Object?>? _dataUrlToAnthropicImage(String? dataUrl) {
    if (dataUrl == null || !dataUrl.startsWith('data:')) return null;
    final comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    final meta = dataUrl.substring(5, comma); /* e.g. image/png;base64 */
    final mediaType = meta.split(';').first;
    return {
      'type': 'image',
      'source': {
        'type': 'base64',
        'media_type': mediaType.isEmpty ? 'image/jpeg' : mediaType,
        'data': dataUrl.substring(comma + 1),
      },
    };
  }

  int _asInt(dynamic v) => v is num ? v.toInt() : 0;
}
