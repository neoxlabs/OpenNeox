/// hmac.dart — HMAC-SHA256(device_token, "{timestamp}.{nonce}") → base64url.
///
/// 严格对齐 Desktop `crypto.ts` signRequest:
/// ```ts
/// const mac = crypto.createHmac('sha256', deviceToken);
/// mac.update(`${timestampMs}.${nonce}`);
/// return mac.digest('base64url');
/// ```
///
/// WS 握手 (`X-Neox-Signature`) 防 replay 用.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

class WsSignature {
  WsSignature._();
  static final WsSignature instance = WsSignature._();

  final Hmac _hmac = Hmac.sha256();

  /// 计算 base64url 签名 (无 padding, 跟 Node `digest('base64url')` 一致).
  ///
  /// key = deviceToken 的 UTF-8 字节 —— 扫码配对路径, token 本身就是随机秘密.
  Future<String> sign({
    required String deviceToken,
    required int timestampMs,
    required String nonce,
  }) => signWithKey(
    key: utf8.encode(deviceToken),
    timestampMs: timestampMs,
    nonce: nonce,
  );

  /// 用任意原始字节当 HMAC key 签名.
  ///
  /// 账号自动配对走这条: key = relay_session_key (X25519 ECDH + HKDF 派生,
  /// 两端各自算出, 从不上网)。那条路径的 deviceToken 是公开的
  /// `account:<phoneId>`, 拿它当 key 等于没签 —— 桌面端因此曾经直接拒掉整条
  /// 账号配对路径, 导致同账号的手机永远连不上局域网。
  Future<String> signWithKey({
    required List<int> key,
    required int timestampMs,
    required String nonce,
  }) async {
    final keyBytes = key;
    final payload = utf8.encode('$timestampMs.$nonce');
    final mac = await _hmac.calculateMac(
      payload,
      secretKey: SecretKey(keyBytes),
    );
    return _b64UrlNoPad(Uint8List.fromList(mac.bytes));
  }
}

/// base64url 编码, 去掉 '=' padding (跟 Node `'base64url'` 行为一致).
String _b64UrlNoPad(Uint8List bytes) {
  return base64Url.encode(bytes).replaceAll('=', '');
}
