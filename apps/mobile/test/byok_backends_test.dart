/// byok_backends_test.dart — SSE 解析器 + BYOK 三协议适配器 + 重试/取消.
///
/// 用 MockClient.streaming 模拟厂商 SSE 响应, 验证:
///   - SseDecoder 规范性 (多行 data / CRLF / comment / chunk 边界切断)
///   - OpenAI 兼容 / Anthropic / Gemini 的请求转换与响应解析
///   - 429 → 退避重试; 4xx → 友好错误; 取消令牌
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:neox_app/core/byok/backends/anthropic_backend.dart';
import 'package:neox_app/core/byok/backends/gemini_backend.dart';
import 'package:neox_app/core/byok/backends/openai_compat_backend.dart';
import 'package:neox_app/core/byok/byok_models.dart';
import 'package:neox_app/core/llm/chat_backend.dart';
import 'package:neox_app/core/llm/llm_http.dart';
import 'package:neox_app/core/llm/sse.dart';

Stream<List<int>> _bytes(String s, {int chunkSize = 7}) async* {
  /* 故意按 7 字节切 chunk — 逼出 SseDecoder 的 carry 边界逻辑 */
  final raw = utf8.encode(s);
  for (var i = 0; i < raw.length; i += chunkSize) {
    yield raw.sublist(i, i + chunkSize > raw.length ? raw.length : i + chunkSize);
  }
}

ByokProviderConfig _provider(ByokProtocol protocol, {String baseUrl = 'https://api.test'}) =>
    ByokProviderConfig(
      id: 'p1',
      name: 'TestVendor',
      protocol: protocol,
      baseUrl: baseUrl,
      apiKey: 'sk-test-123',
      models: const ['m1'],
    );

void main() {
  group('SseDecoder', () {
    Future<List<SseEvent>> decode(String raw, {int chunkSize = 7}) =>
        _bytes(raw, chunkSize: chunkSize).transform(const SseDecoder()).toList();

    test('基础帧 + [DONE] + comment 忽略', () async {
      final events = await decode(
        ': keep-alive\n'
        'data: {"a":1}\n\n'
        'data: [DONE]\n\n',
      );
      expect(events.map((e) => e.data), ['{"a":1}', '[DONE]']);
    });

    test('多行 data join, event: 字段保留', () async {
      final events = await decode(
        'event: content_block_delta\n'
        'data: {"line":\n'
        'data: "two"}\n\n',
      );
      expect(events.single.event, 'content_block_delta');
      expect(events.single.data, '{"line":\n"two"}');
    });

    test('CRLF 行尾 + 冒号后单空格剥离', () async {
      final events = await decode('data: hello\r\ndata:world\r\n\r\n');
      expect(events.single.data, 'hello\nworld');
    });

    test('流结束未闭合事件也提交', () async {
      final events = await decode('data: tail-no-blank-line');
      expect(events.single.data, 'tail-no-blank-line');
    });

    test('chunk 边界 1 字节也不破帧', () async {
      final events = await decode(
        'data: {"content":"你好世界"}\n\n',
        chunkSize: 1,
      );
      expect(events.single.data, '{"content":"你好世界"}');
    });
  });

  group('OpenAiCompatBackend', () {
    test('deltas + reasoning + usage 解析, 请求头带 Bearer', () async {
      late http.BaseRequest captured;
      final client = MockClient.streaming((req, body) async {
        captured = req;
        const sse = 'data: {"choices":[{"delta":{"content":"你"}}]}\n\n'
            'data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}\n\n'
            'data: {"choices":[{"delta":{"content":"好"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n'
            'data: [DONE]\n\n';
        return http.StreamedResponse(_bytes(sse), 200);
      });
      final backend = OpenAiCompatBackend(
        http: LlmHttp(client),
        provider: _provider(ByokProtocol.openaiCompat),
      );
      final deltas = await backend
          .streamChat(ChatRequest(modelId: 'gpt-test', messages: const [
            {'role': 'user', 'content': 'hi'},
          ]))
          .toList();

      expect(captured.url.toString(), 'https://api.test/chat/completions');
      expect(captured.headers['Authorization'], 'Bearer sk-test-123');
      expect(deltas.map((d) => d.text).whereType<String>().join(), '你好');
      expect(deltas.map((d) => d.thinking).whereType<String>().join(), '思考中');
      final usage = deltas.lastWhere((d) => d.usage != null).usage!;
      expect(usage.inputTokens, 10);
      expect(usage.outputTokens, 2);
    });

    test('SSE 帧内 error 抛 ChatBackendException', () async {
      final client = MockClient.streaming((req, body) async {
        const sse =
            'data: {"error":{"message":"model overloaded"}}\n\n';
        return http.StreamedResponse(_bytes(sse), 200);
      });
      final backend = OpenAiCompatBackend(
        http: LlmHttp(client),
        provider: _provider(ByokProtocol.openaiCompat),
      );
      expect(
        () => backend
            .streamChat(ChatRequest(modelId: 'm', messages: const []))
            .drain<void>(),
        throwsA(isA<ChatBackendException>()),
      );
    });

    test('429 后重试成功 (退避)', () async {
      var calls = 0;
      final client = MockClient.streaming((req, body) async {
        calls++;
        if (calls == 1) {
          return http.StreamedResponse(
            _bytes('{"error":{"message":"rate limited"}}'),
            429,
          );
        }
        return http.StreamedResponse(
          _bytes('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'),
          200,
        );
      });
      final backend = OpenAiCompatBackend(
        http: LlmHttp(client),
        provider: _provider(ByokProtocol.openaiCompat),
      );
      final deltas = await backend
          .streamChat(ChatRequest(modelId: 'm', messages: const []))
          .toList();
      expect(calls, 2);
      expect(deltas.single.text, 'ok');
    });

    test('401 → 友好错误文案 (含厂商名)', () async {
      final client = MockClient.streaming((req, body) async {
        return http.StreamedResponse(
          _bytes('{"error":{"message":"Invalid API key"}}'),
          401,
        );
      });
      final backend = OpenAiCompatBackend(
        http: LlmHttp(client),
        provider: _provider(ByokProtocol.openaiCompat),
      );
      try {
        await backend
            .streamChat(ChatRequest(modelId: 'm', messages: const []))
            .drain<void>();
        fail('should throw');
      } on ChatBackendException catch (e) {
        expect(e.statusCode, 401);
        expect(e.message, contains('TestVendor'));
        expect(e.message, contains('Invalid API key'));
      }
    });

    test('CancelToken 掐断流', () async {
      final client = MockClient.streaming((req, body) async {
        Stream<List<int>> slow() async* {
          yield utf8.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
          await Future<void>.delayed(const Duration(seconds: 30));
          yield utf8.encode('data: [DONE]\n\n');
        }

        return http.StreamedResponse(slow(), 200);
      });
      final backend = OpenAiCompatBackend(
        http: LlmHttp(client),
        provider: _provider(ByokProtocol.openaiCompat),
      );
      final cancel = CancelToken();
      final got = <String>[];
      final fut = backend
          .streamChat(
            ChatRequest(modelId: 'm', messages: const []),
            cancel: cancel,
          )
          .forEach((d) {
        if (d.text != null) got.add(d.text!);
        cancel.cancel(); /* 第一个 delta 后立刻取消 */
      });
      await expectLater(fut, throwsA(isA<ChatCancelled>()));
      expect(got, ['a']);
    });
  });

  group('AnthropicBackend', () {
    test('请求转换: system 抽出 / 相邻同角色合并 / data URL 图片', () async {
      late String capturedBody;
      late http.BaseRequest captured;
      final client = MockClient.streaming((req, body) async {
        captured = req;
        capturedBody = utf8.decode(await body.expand((c) => c).toList());
        const sse = 'event: message_start\n'
            'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n'
            'event: content_block_delta\n'
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"回答"}}\n\n'
            'event: message_delta\n'
            'data: {"type":"message_delta","usage":{"output_tokens":3}}\n\n'
            'event: message_stop\n'
            'data: {"type":"message_stop"}\n\n';
        return http.StreamedResponse(_bytes(sse), 200);
      });
      final backend = AnthropicBackend(
        http: LlmHttp(client),
        provider: _provider(ByokProtocol.anthropic),
      );
      final deltas = await backend.streamChat(ChatRequest(
        modelId: 'claude-test',
        messages: [
          {'role': 'system', 'content': '你是助手'},
          {'role': 'user', 'content': '第一句'},
          {
            'role': 'user',
            'content': [
              {'type': 'text', 'text': '看图'},
              {
                'type': 'image_url',
                'image_url': {'url': 'data:image/png;base64,QUJD'},
              },
            ],
          },
          {'role': 'assistant', 'content': '好的'},
        ],
      )).toList();

      expect(captured.url.toString(), 'https://api.test/v1/messages');
      expect(captured.headers['x-api-key'], 'sk-test-123');
      expect(captured.headers['anthropic-version'], '2023-06-01');

      final body = jsonDecode(capturedBody) as Map<String, dynamic>;
      expect(body['system'], '你是助手');
      final messages = body['messages'] as List;
      /* 两条相邻 user 合并成一条, assistant 单独 */
      expect(messages.length, 2);
      final firstContent = (messages[0] as Map)['content'] as List;
      expect(firstContent.length, 3); /* 第一句 + 看图 + image */
      final img = firstContent[2] as Map;
      expect(img['type'], 'image');
      expect((img['source'] as Map)['media_type'], 'image/png');
      expect((img['source'] as Map)['data'], 'QUJD');

      expect(deltas.map((d) => d.text).whereType<String>().join(), '回答');
      final usage = deltas.lastWhere((d) => d.usage != null).usage!;
      expect(usage.inputTokens, 5);
      expect(usage.outputTokens, 3);
    });

    test('error 事件抛出', () async {
      final client = MockClient.streaming((req, body) async {
        const sse = 'event: error\n'
            'data: {"type":"error","error":{"message":"overloaded_error"}}\n\n';
        return http.StreamedResponse(_bytes(sse), 200);
      });
      final backend = AnthropicBackend(
        http: LlmHttp(client),
        provider: _provider(ByokProtocol.anthropic),
      );
      expect(
        () => backend
            .streamChat(ChatRequest(modelId: 'm', messages: const []))
            .drain<void>(),
        throwsA(isA<ChatBackendException>()),
      );
    });
  });

  group('GeminiBackend', () {
    test('URL/header/请求转换 + parts 文本解析', () async {
      late String capturedBody;
      late http.BaseRequest captured;
      final client = MockClient.streaming((req, body) async {
        captured = req;
        capturedBody = utf8.decode(await body.expand((c) => c).toList());
        const sse =
            'data: {"candidates":[{"content":{"parts":[{"text":"Gem"}]}}]}\n\n'
            'data: {"candidates":[{"content":{"parts":[{"text":"ini"}]}}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":2}}\n\n';
        return http.StreamedResponse(_bytes(sse), 200);
      });
      final backend = GeminiBackend(
        http: LlmHttp(client),
        provider: _provider(ByokProtocol.gemini),
      );
      final deltas = await backend.streamChat(ChatRequest(
        modelId: 'gemini-test',
        messages: [
          {'role': 'system', 'content': 'sys'},
          {'role': 'user', 'content': 'hi'},
          {'role': 'assistant', 'content': 'yo'},
        ],
      )).toList();

      expect(
        captured.url.toString(),
        'https://api.test/v1beta/models/gemini-test:streamGenerateContent?alt=sse',
      );
      expect(captured.headers['x-goog-api-key'], 'sk-test-123');

      final body = jsonDecode(capturedBody) as Map<String, dynamic>;
      expect(
        ((body['systemInstruction'] as Map)['parts'] as List).first['text'],
        'sys',
      );
      final contents = body['contents'] as List;
      expect((contents[0] as Map)['role'], 'user');
      expect((contents[1] as Map)['role'], 'model');

      expect(deltas.map((d) => d.text).whereType<String>().join(), 'Gemini');
      final usage = deltas.lastWhere((d) => d.usage != null).usage!;
      expect(usage.inputTokens, 7);
      expect(usage.outputTokens, 2);
    });
  });

  group('ByokProviderConfig / ByokModelRef', () {
    test('encode/decode roundtrip', () {
      final list = [
        const ByokProviderConfig(
          id: 'a1',
          name: 'OpenRouter',
          protocol: ByokProtocol.openaiCompat,
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-or-xxx',
          models: ['openai/gpt-4o-mini'],
          extraHeaders: {'X-Title': 'Neox'},
        ),
      ];
      final decoded =
          ByokProviderConfig.decodeList(ByokProviderConfig.encodeList(list));
      expect(decoded.length, 1);
      expect(decoded.single.name, 'OpenRouter');
      expect(decoded.single.protocol, ByokProtocol.openaiCompat);
      expect(decoded.single.models, ['openai/gpt-4o-mini']);
      expect(decoded.single.extraHeaders['X-Title'], 'Neox');
    });

    test('损坏 JSON 返回空不抛', () {
      expect(ByokProviderConfig.decodeList('not-json'), isEmpty);
      expect(ByokProviderConfig.decodeList('[{"id":""}]'), isEmpty);
    });

    test('ByokModelRef 命名空间解析 (model id 自身含斜杠)', () {
      final ref = ByokModelRef.parse('byok/p1/openai/gpt-4o-mini');
      expect(ref, isNotNull);
      expect(ref!.providerId, 'p1');
      expect(ref.modelId, 'openai/gpt-4o-mini');
      expect(ref.fullId, 'byok/p1/openai/gpt-4o-mini');
      expect(ByokModelRef.parse('auto'), isNull);
      expect(ByokModelRef.parse('byok/'), isNull);
    });
  });
}
