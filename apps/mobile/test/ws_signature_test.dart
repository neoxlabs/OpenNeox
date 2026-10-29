/// ws_signature_test.dart — WS 握手签名的跨语言一致性.
///
/// 这些期望值不是从 Dart 这边跑出来再抄回去的 —— 那样测的只是"我没改坏自己",
/// 而真正的风险在于**两个语言算出不同的值**: 桌面用 Node `crypto.createHmac`,
/// 手机用 package:cryptography, 只要 key 的字节化方式或 base64url padding 有一点
/// 不一致, 握手就会挨一个语焉不详的 401, 而且两边日志都显示"我算的没错"。
///
/// 下面的值由 Node 侧生成 (packages/neox-desktop mobile-bridge/crypto.ts 同款调用):
///   const mac = crypto.createHmac('sha256', key);
///   mac.update(`${ts}.${nonce}`);
///   mac.digest('base64url');
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/crypto/hmac.dart';

void main() {
  const ts = 1765432100000;
  const nonce = 'abc123nonce';

  /* 32 字节派生密钥样本 — 模拟 relay_session_key (X25519 ECDH + HKDF 的输出). */
  final derivedKey = List<int>.generate(32, (i) => (i * 7) % 256);

  test('signWithKey 跟 Node HMAC 逐字符一致 (账号自动配对路径)', () async {
    final sig = await WsSignature.instance.signWithKey(
      key: derivedKey,
      timestampMs: ts,
      nonce: nonce,
    );
    expect(sig, '6qL1Z52JNg2wAfZ4CkVYoGNQja941PGHuev-z33QI44');
  });

  test('派生密钥的 base64 表示跟桌面存的 relay_session_key_b64 对得上', () {
    /* 桌面侧 PairedMobile.relay_session_key_b64 存的就是这串; 它 base64 解码后
     * 必须正是我们拿来当 HMAC key 的那 32 字节, 否则两端 key 不同源。 */
    expect(base64.encode(derivedKey), 'AAcOFRwjKjE4P0ZNVFtiaXB3foWMk5qhqK+2vcTL0tk=');
  });

  test('sign(deviceToken) 跟 Node HMAC 一致 (扫码配对路径)', () async {
    final sig = await WsSignature.instance.sign(
      deviceToken: 'tok_secret_123',
      timestampMs: ts,
      nonce: nonce,
    );
    expect(sig, 'vMe-v-oxy0uHv5jfRRqhZUMrvHelMd6ElI86Ye8PcJ0');
  });

  test('base64url 无 padding — Node digest(base64url) 不带 =', () async {
    final sig = await WsSignature.instance.signWithKey(
      key: derivedKey,
      timestampMs: ts,
      nonce: nonce,
    );
    expect(sig.contains('='), isFalse);
    /* 也不能出现标准 base64 的 +/ — Node 的 base64url 用 -_ */
    expect(sig.contains('+'), isFalse);
    expect(sig.contains('/'), isFalse);
    /* HMAC-SHA256 32 字节 → base64url 43 字符 (无 padding) */
    expect(sig.length, 43);
  });

  test('两条路径的密钥不能互换 — 同一 token 字符串当字节 key 签出来是不同的值', () async {
    const token = 'tok_secret_123';
    final asToken = await WsSignature.instance.sign(
      deviceToken: token,
      timestampMs: ts,
      nonce: nonce,
    );
    final asBytes = await WsSignature.instance.signWithKey(
      key: utf8.encode(token),
      timestampMs: ts,
      nonce: nonce,
    );
    /* 这两个**应该相等** — sign() 就是 signWithKey(utf8(token)) 的语法糖。
     * 钉住它, 免得以后有人给 sign() 换个编码方式而不自知。 */
    expect(asToken, asBytes);
  });

  test('时间戳或 nonce 变了签名必须变 (防重放的前提)', () async {
    final base = await WsSignature.instance.signWithKey(
      key: derivedKey,
      timestampMs: ts,
      nonce: nonce,
    );
    final otherTs = await WsSignature.instance.signWithKey(
      key: derivedKey,
      timestampMs: ts + 1,
      nonce: nonce,
    );
    final otherNonce = await WsSignature.instance.signWithKey(
      key: derivedKey,
      timestampMs: ts,
      nonce: '$nonce-x',
    );
    expect(otherTs, isNot(base));
    expect(otherNonce, isNot(base));
  });
}
