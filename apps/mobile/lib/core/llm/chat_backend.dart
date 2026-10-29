/// chat_backend.dart — 手机端 LLM 流式聊天统一抽象.
///
/// 两类实现:
///   - GatewayBackend (model_gateway_client): 订阅模式, 走 NeoxCloud /n1, JWT 计费
///   - BYOK 三协议 (openai_compat / anthropic / gemini): 直连厂商, key 不出手机
///
/// 消息统一用 OpenAI chat shape (role + content: String | parts[]),
/// 各适配器内部转厂商 wire 格式 — 调用方 (phone_local_agent) 不感知协议差异.
library;

import 'dart:convert';

import 'sse.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 一次流式请求.
class ChatRequest {
  const ChatRequest({
    required this.modelId,
    required this.messages,
    this.maxTokens = 4096,
    this.temperature,
  });

  /// 厂商侧模型 id (不含 byok/ 前缀).
  final String modelId;

  /// OpenAI shape: [{role, content}] — content 是 String 或
  /// [{type:'text',text} | {type:'image_url',image_url:{url:'data:...'}}].
  final List<Map<String, Object?>> messages;

  final int maxTokens;

  /// null = 不传 (厂商默认).
  final double? temperature;
}

/// 流式增量 — text / thinking 至少一个非空; usage 只在结束帧带.
class ChatDelta {
  const ChatDelta({this.text, this.thinking, this.usage});
  final String? text;
  final String? thinking;
  final ChatUsage? usage;
}

class ChatUsage {
  const ChatUsage({this.inputTokens = 0, this.outputTokens = 0});
  final int inputTokens;
  final int outputTokens;
}

abstract class ChatBackend {
  /// 流式聊天 — delta 依序 yield; 出错抛 [ChatBackendException];
  /// [cancel] 取消时流以 [ChatCancelled] 错误结束.
  Stream<ChatDelta> streamChat(ChatRequest request, {CancelToken? cancel});
}

/// 统一错误 — message 已经是用户可读中文 (含厂商侧原因), UI 直接显示.
class ChatBackendException implements Exception {
  const ChatBackendException(this.message, {this.statusCode, this.retryable = false});
  final String message;
  final int? statusCode;

  /// 连接期临时错误 (429/5xx/网络) — 适配器内部已按此决定是否重试过.
  final bool retryable;

  @override
  String toString() => message;
}

/// 按 HTTP 状态码给 BYOK 直连的友好错误 (区分"是厂商的问题不是 Neox 的问题").
ChatBackendException byokHttpError({
  required String providerName,
  required int status,
  required String body,
}) {
  final vendorMsg = extractVendorErrorMessage(body);
  final suffix = vendorMsg.isEmpty ? '' : ' — $vendorMsg';
  switch (status) {
    case 401:
    case 403:
      return ChatBackendException(
        tr('$providerName 拒绝了这个 API Key (HTTP $status)$suffix。请到设置里检查 Key。'),
        statusCode: status,
      );
    case 402:
      return ChatBackendException(
        tr('$providerName 账户余额不足$suffix。请到厂商控制台充值。'),
        statusCode: status,
      );
    case 404:
      return ChatBackendException(
        tr('$providerName 找不到这个模型$suffix。检查模型名或换一个模型。'),
        statusCode: status,
      );
    case 429:
      return ChatBackendException(
        tr('$providerName 限流了 (HTTP 429)$suffix。稍等片刻再试。'),
        statusCode: status,
        retryable: true,
      );
    default:
      if (status >= 500) {
        return ChatBackendException(
          tr('$providerName 服务暂时不稳定 (HTTP $status)$suffix。这是厂商侧问题, 稍后重试。'),
          statusCode: status,
          retryable: true,
        );
      }
      return ChatBackendException(
        tr('$providerName 请求失败 (HTTP $status)$suffix'),
        statusCode: status,
      );
  }
}

/// 从厂商错误 body 里抠 message (OpenAI/Anthropic/Gemini 三家 error shape 都试).
String extractVendorErrorMessage(String body) {
  if (body.isEmpty) return '';
  dynamic parsed;
  try {
    parsed = jsonDecode(body);
  } catch (_) {
    return '';
  }
  if (parsed is Map) {
    final err = parsed['error'];
    if (err is Map && err['message'] is String) {
      return _clip(err['message'] as String);
    }
    if (err is String) return _clip(err);
    if (parsed['message'] is String) return _clip(parsed['message'] as String);
  }
  if (parsed is List && parsed.isNotEmpty && parsed.first is Map) {
    final err = (parsed.first as Map)['error'];
    if (err is Map && err['message'] is String) {
      return _clip(err['message'] as String);
    }
  }
  return '';
}

String _clip(String s) {
  final clean = s.replaceAll('\n', ' ').trim();
  return clean.length > 140 ? '${clean.substring(0, 137)}…' : clean;
}
