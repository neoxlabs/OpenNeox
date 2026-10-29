/// widget_test.dart — 加密原语单元测试 (Phase 1.C smoke).
///
/// widget mount 测试因 drift stream 在 fake_async 里清理需要异步处理,
/// 跟 Flutter test framework 的 "no pending timers" 严校验冲突, 留 Phase 1.D
/// 接 cloud relay 时一起重做 widget smoke.
///
/// 这里至少校验加密原语 (Phone ↔ Desktop 互通的核心保证) 跑得通.
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/crypto/fingerprint.dart';
import 'package:neox_app/core/crypto/hmac.dart';
import 'package:neox_app/core/crypto/x25519_hkdf.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('X25519 + HKDF roundtrip — 两端派出同一 key', () async {
    // 模拟 Phone + Desktop 各生成 keypair, 互算共享 + HKDF, 应得同一 32-byte key
    final kpA = await X25519Hkdf.instance.generateKeypair();
    final kpB = await X25519Hkdf.instance.generateKeypair();
    final pubA = await X25519Hkdf.instance.extractRawPublicKey(kpA);
    final pubB = await X25519Hkdf.instance.extractRawPublicKey(kpB);

    final keyAtA = await X25519Hkdf.instance.deriveRelaySessionKey(
      selfKeypair: kpA,
      peerPublicKeyRaw: pubB,
    );
    final keyAtB = await X25519Hkdf.instance.deriveRelaySessionKey(
      selfKeypair: kpB,
      peerPublicKeyRaw: pubA,
    );
    expect(keyAtA.length, 32);
    expect(keyAtB.length, 32);
    expect(keyAtA, keyAtB);
  });

  test('Fingerprint 格式 ab:cd:ef:... (8 段)', () async {
    final fp = await Fingerprint.instance.compute(utf8.encode('hello'));
    expect(fp.split(':').length, 8);
    expect(RegExp(r'^[0-9a-f]{2}(:[0-9a-f]{2}){7}$').hasMatch(fp), true);
  });

  test('HMAC signRequest 无 padding base64url', () async {
    final sig = await WsSignature.instance.sign(
      deviceToken: 'test-token',
      timestampMs: 1700000000000,
      nonce: 'abc123',
    );
    expect(sig.contains('='), false, reason: 'base64url 不应带 padding');
    expect(sig.length > 20, true);
  });
}
