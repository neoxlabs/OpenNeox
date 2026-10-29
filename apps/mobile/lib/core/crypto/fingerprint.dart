/// fingerprint.dart — pubkey/key fingerprint (sha256 取前 8 字节 hex 格式 "ab:cd:...").
///
/// 严格对齐 Desktop `crypto.ts` pubkeyFingerprint — 用户肉眼比对配对 pubkey + 自检
/// relay_session_key 一致用.
library;

import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

class Fingerprint {
  Fingerprint._();
  static final Fingerprint instance = Fingerprint._();

  final Sha256 _sha256 = Sha256();

  /// 计算 fingerprint: sha256(bytes) 头 8 字节 → "ab:cd:ef:..." (lowercase hex)
  Future<String> compute(List<int> bytes) async {
    final hash = await _sha256.hash(bytes);
    final h = Uint8List.fromList(hash.bytes);
    final out = StringBuffer();
    for (var i = 0; i < 8; i++) {
      if (i > 0) out.write(':');
      out.write(h[i].toRadixString(16).padLeft(2, '0'));
    }
    return out.toString();
  }
}
