/// aes_gcm.dart — AES-256-GCM 加解密 (Mode B Cloud Relay 用).
///
/// 严格对齐 `docs/NEOX_MOBILE_PROTOCOL.md` §4.4:
///   - 12-byte random nonce
///   - 16-byte auth tag
///   - 输出格式 (envelope): nonce 独立 base64 字段 + ciphertext = encrypted_payload + tag 拼接
///     (跟 Desktop `crypto.ts` encryptAesGcm 完全一致)
///
/// 注: Dart `cryptography` 包的 [SecretBox.concatenation] 默认是 `nonce + cipherText + mac`
/// (3 段拼一起). 我们走协议规范的两段格式 ⇒ nonce 单字段不入 ciphertext,
/// ciphertext = cipherText + mac (中间 16 字节 mac 在最后, 跟 Node 一致).
library;

import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

/// AES-256-GCM 加密结果 (跟协议 §4.4 envelope 字段一一对应)
class AesGcmEncryptedPayload {
  const AesGcmEncryptedPayload({required this.nonce, required this.ciphertext});

  /// 12 bytes random
  final Uint8List nonce;

  /// 密文 + 16 byte tag 拼接 (跟 Desktop 一致)
  final Uint8List ciphertext;
}

class AesGcmCipher {
  AesGcmCipher._();
  static final AesGcmCipher instance = AesGcmCipher._();

  final AesGcm _algo = AesGcm.with256bits();

  /// 加密 [plaintext] 用 32-byte [key]. 自动生成 12-byte random nonce.
  Future<AesGcmEncryptedPayload> encrypt({
    required List<int> key,
    required List<int> plaintext,
  }) async {
    _assertKey(key);
    final secretKey = SecretKey(key);
    final box = await _algo.encrypt(plaintext, secretKey: secretKey);
    // box.nonce 12 bytes, box.cipherText 长度 == plaintext, box.mac.bytes 16 bytes
    final ct = Uint8List(box.cipherText.length + box.mac.bytes.length);
    ct.setAll(0, box.cipherText);
    ct.setAll(box.cipherText.length, box.mac.bytes);
    return AesGcmEncryptedPayload(
      nonce: Uint8List.fromList(box.nonce),
      ciphertext: ct,
    );
  }

  /// 解密. [ciphertext] 末尾 16 字节为 tag.
  Future<Uint8List> decrypt({
    required List<int> key,
    required List<int> nonce,
    required List<int> ciphertext,
  }) async {
    _assertKey(key);
    if (nonce.length != 12) {
      throw ArgumentError('AES-GCM nonce must be 12 bytes, got ${nonce.length}');
    }
    if (ciphertext.length < 16) {
      throw ArgumentError('ciphertext too short to contain 16-byte tag');
    }
    final secretKey = SecretKey(key);
    final ctLen = ciphertext.length - 16;
    final body = ciphertext.sublist(0, ctLen);
    final mac = Mac(ciphertext.sublist(ctLen));
    final box = SecretBox(body, nonce: nonce, mac: mac);
    final plain = await _algo.decrypt(box, secretKey: secretKey);
    return Uint8List.fromList(plain);
  }

  void _assertKey(List<int> key) {
    if (key.length != 32) {
      throw ArgumentError(
        'AES-256-GCM key must be 32 bytes, got ${key.length}',
      );
    }
  }
}
