/// gemini_backend.dart — Google Gemini (Generative Language API) BYOK 适配器.
///
/// 请求: POST `$baseUrl/v1beta/models/{model}:streamGenerateContent?alt=sse`
///   headers: x-goog-api-key (比 query ?key= 安全 — 不进访问日志)
///   body: { contents, systemInstruction?, generationConfig }
///
/// OpenAI shape → Gemini 转换:
///   - system → systemInstruction.parts[].text
///   - assistant → role 'model'; user → 'user'
///   - image data URL → inline_data { mime_type, data }
///
/// 响应 SSE: candidates[0].content.parts[].text 累积; usageMetadata 尾帧.
library;

import 'dart:convert';

import '../../llm/chat_backend.dart';
import '../../llm/llm_http.dart';
import '../../llm/sse.dart';
import '../byok_models.dart';
import 'package:neox_app/core/i18n/tr.dart';

class GeminiBackend implements ChatBackend {
  GeminiBackend({required this.http, required this.provider});

  final LlmHttp http;
  final ByokProviderConfig provider;

  @override
  Stream<ChatDelta> streamChat(ChatRequest request, {CancelToken? cancel}) async* {
    final converted = _convertMessages(request.messages);
    final body = jsonEncode({
      'contents': converted.contents,
      if (converted.system.isNotEmpty)
        'systemInstruction': {
          'parts': [
            {'text': converted.system},
          ],
        },
      'generationConfig': {
        'maxOutputTokens': request.maxTokens,
        if (request.temperature != null) 'temperature': request.temperature,
      },
    });

    final events = http.streamSse(
      url:
          '${provider.baseUrl}/v1beta/models/${Uri.encodeComponent(request.modelId)}:streamGenerateContent?alt=sse',
      headers: {
        'x-goog-api-key': provider.apiKey,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        ...provider.extraHeaders,
      },
      body: body,
      providerName: provider.name,
      cancel: cancel,
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

      if (frame['error'] != null) {
        throw ChatBackendException(
          tr('${provider.name} 返回错误 — ${extractVendorErrorMessage(ev.data)}'),
        );
      }

      String? text;
      final candidates = frame['candidates'];
      if (candidates is List && candidates.isNotEmpty && candidates.first is Map) {
        final content = (candidates.first as Map)['content'];
        if (content is Map && content['parts'] is List) {
          final buf = StringBuffer();
          for (final p in content['parts'] as List) {
            if (p is Map && p['text'] is String) buf.write(p['text']);
          }
          if (buf.isNotEmpty) text = buf.toString();
        }
      }

      ChatUsage? usage;
      final meta = frame['usageMetadata'];
      if (meta is Map) {
        usage = ChatUsage(
          inputTokens: _asInt(meta['promptTokenCount']),
          outputTokens: _asInt(meta['candidatesTokenCount']),
        );
      }

      if (text != null || usage != null) {
        yield ChatDelta(text: text, usage: usage);
      }
    }
  }

  ({String system, List<Map<String, Object?>> contents}) _convertMessages(
    List<Map<String, Object?>> input,
  ) {
    final systemBuf = StringBuffer();
    final contents = <Map<String, Object?>>[];

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
      final geminiRole = role == 'assistant' ? 'model' : 'user';
      final parts = _convertParts(content);
      if (parts.isEmpty) continue;
      if (contents.isNotEmpty && contents.last['role'] == geminiRole) {
        (contents.last['parts'] as List).addAll(parts);
      } else {
        contents.add({'role': geminiRole, 'parts': parts});
      }
    }
    return (system: systemBuf.toString(), contents: contents);
  }

  List<Object?> _convertParts(Object? content) {
    if (content is String) {
      return content.isEmpty
          ? const []
          : [
              {'text': content},
            ];
    }
    if (content is! List) return const [];
    final parts = <Object?>[];
    for (final p in content) {
      if (p is! Map) continue;
      if (p['type'] == 'text' && p['text'] is String) {
        parts.add({'text': p['text']});
      } else if (p['type'] == 'image_url') {
        final url = p['image_url'] is Map
            ? ((p['image_url'] as Map)['url'] as String?)
            : null;
        final inline = _dataUrlToInlineData(url);
        if (inline != null) parts.add(inline);
      }
    }
    return parts;
  }

  Map<String, Object?>? _dataUrlToInlineData(String? dataUrl) {
    if (dataUrl == null || !dataUrl.startsWith('data:')) return null;
    final comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    final mediaType = dataUrl.substring(5, comma).split(';').first;
    return {
      'inline_data': {
        'mime_type': mediaType.isEmpty ? 'image/jpeg' : mediaType,
        'data': dataUrl.substring(comma + 1),
      },
    };
  }

  int _asInt(dynamic v) => v is num ? v.toInt() : 0;
}
