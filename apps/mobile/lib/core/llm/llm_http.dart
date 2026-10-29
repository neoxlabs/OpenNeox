/// llm_http.dart — LLM 请求共用 HTTP 层: 连接复用 + 流式重试退避 + 超时.
///
/// 性能要点:
///   - 全 app 单一 http.Client (keep-alive 连接池) — 之前每次 streamChat new 一个
///     Client 用完 close, TLS 握手 + TCP 慢启动每条消息重付一次 (蜂窝网 300-800ms).
///   - 首字节前的 429/5xx/网络错自动重试 (指数退避 + Retry-After 尊重, 最多 2 次);
///     已出首 delta 后不重试 (避免正文重复), 交给上层显示错误.
///   - 双超时: 建连+首字节 25s; 流中 idle (两 chunk 间) 90s.
library;

import 'dart:async';
import 'dart:convert' show utf8;

import 'package:flutter/foundation.dart' show debugPrint, kDebugMode;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import 'chat_backend.dart';
import 'sse.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 全 app 复用的 HTTP client — keep-alive 池.
final llmHttpClientProvider = Provider<http.Client>((ref) {
  final client = http.Client();
  ref.onDispose(client.close);
  return client;
});

class LlmHttp {
  LlmHttp(this._client);
  final http.Client _client;

  static const connectTimeout = Duration(seconds: 25);
  static const idleTimeout = Duration(seconds: 90);
  static const maxRetries = 2;

  /// 等响应头的时限 = connectTimeout + 按 8KB/s 传完请求体的时间。
  /// send() 到拿到响应头这段**包含上传**: 长会话 body 近 1MB, 手机上行慢时 25s 根本传不完,
  /// 每次重试都死在同一处 (2026-10-16, 跟桌面 kernel headerWait.ts 同一个口径)。
  static Duration headerWait(String body) =>
      connectTimeout + Duration(milliseconds: (utf8.encode(body).length / 8192 * 1000).ceil());

  /// 发一个流式 POST — 返回 SseEvent 流.
  ///
  /// [providerName] 只用于错误文案. 重试仅发生在**拿到响应头之前/非 2xx 时**,
  /// SSE 已经开始吐 chunk 后的错误直接上抛.
  /// [errorTextBuilder] 覆盖默认 BYOK 文案 (网关有自己的 401/402/403 语义).
  Stream<SseEvent> streamSse({
    required String url,
    required Map<String, String> headers,
    required String body,
    required String providerName,
    CancelToken? cancel,
    String Function(int status, String body)? errorTextBuilder,
  }) async* {
    http.StreamedResponse? resp;
    var attempt = 0;
    while (true) {
      cancel?.guard();
      try {
        final req = http.Request('POST', Uri.parse(url))
          ..headers.addAll(headers)
          ..body = body;
        resp = await _client.send(req).timeout(headerWait(body));
      } on TimeoutException {
        if (attempt < maxRetries) {
          await _backoff(attempt++, null, cancel);
          continue;
        }
        throw ChatBackendException(
          tr('$providerName 连接超时。检查网络后重试。'),
          retryable: true,
        );
      } on ChatCancelled {
        rethrow;
      } catch (e) {
        if (attempt < maxRetries) {
          await _backoff(attempt++, null, cancel);
          continue;
        }
        throw ChatBackendException(
          tr('$providerName 网络不可达 — ${_shortErr(e)}'),
          retryable: true,
        );
      }

      if (resp.statusCode == 429 || resp.statusCode >= 500) {
        final bodyText = await resp.stream.bytesToString();
        if (attempt < maxRetries) {
          final retryAfter = _retryAfterSeconds(resp.headers);
          if (kDebugMode) {
            debugPrint(
              '[llm-http] $providerName HTTP ${resp.statusCode}, retry #${attempt + 1}',
            );
          }
          /* 5xx 的 Retry-After 最多等 3 秒: 网关那边已经把上游渠道挨个试过了, 再等 15 秒 ×2
           * 只是让用户对着「思考中」干等半分钟才看到错误 (2026-10-05 实测 34 秒)。
           * 429 是真限流, 照网关说的等。 */
          final wait = resp.statusCode == 429 ? retryAfter : retryAfter?.clamp(1, 3);
          await _backoff(attempt++, wait, cancel);
          continue;
        }
        throw _httpError(providerName, resp.statusCode, bodyText, errorTextBuilder);
      }
      if (resp.statusCode >= 400) {
        final bodyText = await resp.stream.bytesToString();
        throw _httpError(providerName, resp.statusCode, bodyText, errorTextBuilder);
      }
      break;
    }

    /* SSE 流 — idle 超时 + 取消支持 */
    var stream = resp.stream.transform(const SseDecoder()).timeout(
      idleTimeout,
      onTimeout: (sink) {
        sink.addError(
          ChatBackendException(
            tr('$providerName 响应流中断 (90 秒无数据)。'),
            retryable: true,
          ),
        );
        sink.close();
      },
    );
    if (cancel != null) stream = cancel.wrap(stream);
    yield* stream;
  }

  /// 非流式 JSON 请求 (探活 / models 列表用) — 带一次 429/5xx 重试.
  Future<http.Response> request(
    String method, {
    required String url,
    required Map<String, String> headers,
    String? body,
    Duration timeout = const Duration(seconds: 12),
  }) async {
    Future<http.Response> send() {
      final uri = Uri.parse(url);
      return switch (method) {
        'GET' => _client.get(uri, headers: headers).timeout(timeout),
        _ => _client.post(uri, headers: headers, body: body).timeout(timeout),
      };
    }

    var resp = await send();
    if (resp.statusCode == 429 || resp.statusCode >= 500) {
      await Future<void>.delayed(const Duration(milliseconds: 800));
      resp = await send();
    }
    return resp;
  }

  Future<void> _backoff(int attempt, int? retryAfterSec, CancelToken? cancel) async {
    final base = retryAfterSec != null
        ? Duration(seconds: retryAfterSec.clamp(1, 15))
        : Duration(milliseconds: 600 * (1 << attempt)); /* 600ms, 1.2s */
    final slept = Completer<void>();
    final timer = Timer(base, slept.complete);
    /* 退避期间可取消 — 竞速 sleep vs cancel */
    await Future.any([
      slept.future,
      if (cancel != null) cancel.whenCancelled,
    ]);
    timer.cancel();
    cancel?.guard();
  }

  ChatBackendException _httpError(
    String providerName,
    int status,
    String body,
    String Function(int, String)? errorTextBuilder,
  ) {
    if (errorTextBuilder != null) {
      return ChatBackendException(
        errorTextBuilder(status, body),
        statusCode: status,
        retryable: status == 429 || status >= 500,
      );
    }
    return byokHttpError(providerName: providerName, status: status, body: body);
  }

  int? _retryAfterSeconds(Map<String, String> headers) {
    final raw = headers['retry-after'];
    if (raw == null) return null;
    return int.tryParse(raw.trim());
  }

  String _shortErr(Object e) {
    final s = '$e'.replaceAll('\n', ' ');
    return s.length > 80 ? '${s.substring(0, 77)}…' : s;
  }
}

final llmHttpProvider = Provider<LlmHttp>(
  (ref) => LlmHttp(ref.watch(llmHttpClientProvider)),
);
