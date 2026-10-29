/// x25519_hkdf.dart — X25519 ECDH + HKDF-SHA256 派生 relay_session_key.
///
/// 严格对齐 `docs/NEOX_MOBILE_PROTOCOL.md` §2.3 + §4.4:
///   - X25519 raw 32-byte priv + pub
///   - HKDF-SHA256(shared_secret, salt=null, info="neox-mobile-relay-v1", length=32)
///
/// 必须跟 Desktop `packages/neox-desktop/src/ui/electron/mobile-bridge/crypto.ts`
/// 的派生输出 byte-by-byte 一致 (双方 fingerprint 自检).
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

/// HKDF info 字符串 — UTF-8 bytes, 跟 Desktop 一致
final Uint8List kHkdfInfo = Uint8List.fromList(
  utf8.encode('neox-mobile-relay-v1'),
);

/// AES-256 派生 key 长度
const int kRelaySessionKeyLength = 32;

/// X25519 + HKDF 一站式工具. 单例 (algorithm 实例可复用).
class X25519Hkdf {
  X25519Hkdf._();
  static final X25519Hkdf instance = X25519Hkdf._();

  final X25519 _x25519 = X25519();
  final Hkdf _hkdf = Hkdf(
    hmac: Hmac.sha256(),
    outputLength: kRelaySessionKeyLength,
  );

  /// 生成全新 X25519 keypair (随机熵, 不可恢复).
  /// 返 [SimpleKeyPair] — 取 raw 用 [extractRawPrivateKey] / [extractRawPublicKeyBytes].
  Future<SimpleKeyPair> generateKeypair() async {
    return _x25519.newKeyPair();
  }

  /// 从 raw 32-byte seed (= raw private key) 恢复 keypair.
  /// 用于从 secure storage 拉历史 priv key 还原.
  Future<SimpleKeyPair> keypairFromRawPrivate(List<int> rawPrivate) async {
    if (rawPrivate.length != 32) {
      throw ArgumentError(
        'X25519 raw private key must be 32 bytes, got ${rawPrivate.length}',
      );
    }
    return _x25519.newKeyPairFromSeed(rawPrivate);
  }

  /// 提 raw 32-byte private key bytes (落盘用, 务必存 secure storage).
  Future<Uint8List> extractRawPrivateKey(SimpleKeyPair kp) async {
    final bytes = await kp.extractPrivateKeyBytes();
    return Uint8List.fromList(bytes);
  }

  /// 提 raw 32-byte public key bytes (发给 Desktop 配对 / 落盘 / 算 fingerprint 都用它).
  Future<Uint8List> extractRawPublicKey(SimpleKeyPair kp) async {
    final pub = await kp.extractPublicKey();
    return Uint8List.fromList(pub.bytes);
  }

  /// 电脑上 CLI 终端入口用的子密钥 (2026-10-17): HKDF-SHA256(relay_session_key, salt=空,
  /// info="neox-cli-endpoint-v1", L=32)。必须跟 core relay-transport deriveCliEndpointKey 一致 ——
  /// 客户端只把这个子密钥交给 CLI, 不交配对密钥本身。
  Future<Uint8List> deriveCliEndpointKey(List<int> relaySessionKey) async {
    final derived = await _hkdf.deriveKey(
      secretKey: SecretKey(relaySessionKey),
      /* salt 写成 32 个 0 而不是空: RFC 5869 里空 salt 就等于 HashLen 个 0 (输出逐字节相同),
       * 但安卓原生 HMAC 拿空 key 直接抛 "Empty key" (模拟器实测) */
      nonce: List<int>.filled(32, 0),
      info: utf8.encode('neox-cli-endpoint-v1'),
    );
    return Uint8List.fromList(await derived.extractBytes());
  }

  /// 派生 relay_session_key (Phase 1.C 落库存, Phase 1.D Mode B 加解密用).
  ///
  /// 流程:
  ///   1. shared_secret = X25519(selfPriv, peerPub)
  ///   2. key = HKDF-SHA256(shared_secret, salt=null, info="neox-mobile-relay-v1", L=32)
  ///
  /// 返 32 byte AES-256 key (raw bytes).
  Future<Uint8List> deriveRelaySessionKey({
    required SimpleKeyPair selfKeypair,
    required List<int> peerPublicKeyRaw,
  }) async {
    if (peerPublicKeyRaw.length != 32) {
      throw ArgumentError(
        'peer X25519 public key must be 32 bytes, got ${peerPublicKeyRaw.length}',
      );
    }
    final remotePub = SimplePublicKey(
      peerPublicKeyRaw,
      type: KeyPairType.x25519,
    );
    final sharedSecret = await _x25519.sharedSecretKey(
      keyPair: selfKeypair,
      remotePublicKey: remotePub,
    );
    final derived = await _hkdf.deriveKey(
      secretKey: sharedSecret,
      // nonce == HKDF salt; Desktop 用 null/empty bytes
      nonce: const <int>[],
      info: kHkdfInfo,
    );
    final keyBytes = await derived.extractBytes();
    if (keyBytes.length != kRelaySessionKeyLength) {
      throw StateError(
        'HKDF returned ${keyBytes.length} bytes, expected $kRelaySessionKeyLength',
      );
    }
    return Uint8List.fromList(keyBytes);
  }
}
