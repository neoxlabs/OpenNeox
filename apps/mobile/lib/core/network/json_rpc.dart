/// json_rpc.dart — JSON-RPC 2.0 消息封套 + 错误码.
///
/// 严格对齐 `docs/NEOX_MOBILE_PROTOCOL.md` §3.3 (message schema) + §5 (error codes).
///
/// Desktop 对端实现见 `mobile-bridge/jsonRpc.ts`. 字段命名 / 顺序 / 错误码必须 1:1.
library;

import 'dart:convert';

/// JSON-RPC 2.0 通用封套. 不用 freezed — 字段少, 手写更可控 (字段顺序 + null 跳过).
class RpcMessage {
  const RpcMessage({
    this.id,
    this.method,
    this.params,
    this.result,
    this.error,
  });

  /// request: id + method (+ params)
  /// notification: method (+ params) — 无 id
  /// response: id + (result | error)
  final String? id;
  final String? method;
  final Object? params;
  final Object? result;
  final RpcError? error;

  bool get isRequest => method != null && id != null;
  bool get isNotification => method != null && id == null;
  bool get isResponse => method == null && id != null;

  /// 序列化为 JSON string (准备发 WS).
  String toJsonString() {
    final map = <String, Object?>{'jsonrpc': '2.0'};
    if (id != null) map['id'] = id;
    if (method != null) map['method'] = method;
    if (params != null) map['params'] = params;
    if (result != null) map['result'] = result;
    if (error != null) map['error'] = error!.toJson();
    return jsonEncode(map);
  }

  /// 从 JSON string parse 出 RpcMessage. 异常时返 null (协议 §5 -32600 由调用方决定).
  static RpcMessage? fromJsonString(String raw) {
    try {
      final obj = jsonDecode(raw);
      if (obj is! Map<String, dynamic>) return null;
      if (obj['jsonrpc'] != '2.0') return null;
      return RpcMessage(
        id: obj['id'] as String?,
        method: obj['method'] as String?,
        params: obj['params'],
        result: obj['result'],
        error: obj['error'] is Map<String, dynamic>
            ? RpcError.fromJson(obj['error'] as Map<String, dynamic>)
            : null,
      );
    } catch (_) {
      return null;
    }
  }

  RpcMessage copyWith({
    String? id,
    String? method,
    Object? params,
    Object? result,
    RpcError? error,
  }) {
    return RpcMessage(
      id: id ?? this.id,
      method: method ?? this.method,
      params: params ?? this.params,
      result: result ?? this.result,
      error: error ?? this.error,
    );
  }
}

class RpcError implements Exception {
  const RpcError({required this.code, required this.message, this.data});

  final int code;
  final String message;
  final Object? data;

  Map<String, Object?> toJson() => {
        'code': code,
        'message': message,
        if (data != null) 'data': data,
      };

  static RpcError fromJson(Map<String, dynamic> json) {
    return RpcError(
      code: json['code'] is int
          ? json['code'] as int
          : int.tryParse('${json['code']}') ?? -32603,
      message: json['message'] as String? ?? 'unknown error',
      data: json['data'],
    );
  }

  @override
  String toString() => 'RpcError($code, $message)';
}

/// 协议 §5 错误码常量
class RpcErrorCode {
  RpcErrorCode._();

  // standard JSON-RPC
  static const int invalidRequest = -32600;
  static const int methodNotFound = -32601;
  static const int invalidParams = -32602;
  static const int internalError = -32603;
  static const int parseError = -32700;

  // Neox 自定义
  static const int authFailed = 4001;
  static const int sessionNotFound = 4002;
  static const int permissionDenied = 4003;
  static const int rateLimit = 4004;
  static const int desktopOffline = 5001;
  static const int decryptFailed = 5002;
}

/// 工厂: 构造 notification (无 id, 不需要 response)
RpcMessage makeNotification(String method, [Object? params]) {
  return RpcMessage(method: method, params: params);
}

/// 工厂: 构造 request (带 id, 等 response)
RpcMessage makeRequest(String id, String method, [Object? params]) {
  return RpcMessage(id: id, method: method, params: params);
}

/// 工厂: 构造成功 response
RpcMessage makeResponse(String id, Object? result) {
  return RpcMessage(id: id, result: result);
}

/// 工厂: 构造错误 response
RpcMessage makeErrorResponse(String id, int code, String message, [Object? data]) {
  return RpcMessage(id: id, error: RpcError(code: code, message: message, data: data));
}
