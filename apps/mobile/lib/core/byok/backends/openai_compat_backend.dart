/// openai_compat_backend.dart — OpenAI 兼容协议 BYOK 适配器.
///
/// 覆盖: OpenAI / OpenRouter / DeepSeek / Kimi / GLM / Qwen / Doubao / MiniMax /
/// SiliconFlow / Groq / 任意 OpenAI 兼容中转站.
///
/// 请求: POST `$baseUrl/chat/completions`, messages 原样透传 (本来就是 OpenAI shape).
/// 响应: SSE data 帧 choices[0].delta.content / .reasoning_content; [DONE] 结束;
///       usage 在 stream_options.include_usage 时最后一帧给.
library;

import 'dart:convert';

import '../../llm/chat_backend.dart';
import '../../llm/llm_http.dart';
import '../../llm/sse.dart';
import '../byok_models.dart';
import 'package:neox_app/core/i18n/tr.dart';

class OpenAiCompatBackend implements ChatBackend {
  OpenAiCompatBackend({required this.http, required this.provider});

  final LlmHttp http;
  final ByokProviderConfig provider;

  @override
  Stream<ChatDelta> streamChat(ChatRequest request, {CancelToken? cancel}) async* {
    final body = jsonEncode({
      'model': request.modelId,
      'messages': request.messages,
      'stream': true,
      'stream_options': {'include_usage': true},
      'max_tokens': request.maxTokens,
      if (request.temperature != null) 'temperature': request.temperature,
    });
    final events = http.streamSse(
      url: '${provider.baseUrl}/chat/completions',
      headers: {
        'Authorization': 'Bearer ${provider.apiKey}',
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        ...provider.extraHeaders,
      },
      body: body,
      providerName: provider.name,
      cancel: cancel,
    );

    await for (final ev in events) {
      if (ev.data.isEmpty || ev.data == '[DONE]') continue;
      Map<String, dynamic>? frame;
      try {
        final parsed = jsonDecode(ev.data);
        if (parsed is Map<String, dynamic>) frame = parsed;
      } catch (_) {
        continue; /* 部分中转站会混入非 JSON 心跳帧 */
      }
      if (frame == null) continue;

      /* 有些兼容站在 SSE 帧里回错误 */
      final err = frame['error'];
      if (err != null) {
        throw ChatBackendException(
          tr('${provider.name} 返回错误 — ${extractVendorErrorMessage(ev.data)}'),
        );
      }

      ChatUsage? usage;
      final u = frame['usage'];
      if (u is Map) {
        usage = ChatUsage(
          inputTokens: _asInt(u['prompt_tokens']),
          outputTokens: _asInt(u['completion_tokens']),
        );
      }

      String? text;
      String? thinking;
      final choices = frame['choices'];
      if (choices is List && choices.isNotEmpty && choices.first is Map) {
        final delta = (choices.first as Map)['delta'];
        if (delta is Map) {
          final c = delta['content'];
          if (c is String && c.isNotEmpty) text = c;
          final r = delta['reasoning_content'] ?? delta['reasoning'];
          if (r is String && r.isNotEmpty) thinking = r;
        }
      }
      if (text != null || thinking != null || usage != null) {
        yield ChatDelta(text: text, thinking: thinking, usage: usage);
      }
    }
  }

  int _asInt(dynamic v) => v is num ? v.toInt() : 0;
}
