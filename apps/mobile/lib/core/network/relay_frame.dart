/// relay_frame.dart — 云中转协议 v2: 二进制帧 + 传输层分片 (跟电脑端
/// packages/core/src/relay-transport/frameCodec.ts、中转 hub/frame.go 逐字节一致)。
///
///   [0x00][0x02][hdrLen u16 BE][hdr JSON utf8][body]
///   hdr = {to, from, to_ep?, from_ep?, mid?, i?, n?}
///   不分片: body = nonce(12) + 密文; 分片: 每片是 (nonce + 密文) 的一段。
///
/// v1 的 JSON 信封要把密文 base64 再包一层, 单条 256KB 封顶, 上面的功能只能各自截断、
/// 小块串行拉。v2 加密一次切帧, 中转只读头转发、不存东西, 收端拼回再解密。
///
/// 协商: 自己发的 v1 信封盖 `cap: 2`; 中转连上发 relay_hello{v:2}; 对端发来过 cap>=2 的信封
/// 或 v2 帧 —— 两样都有才改发 v2, 老电脑 / 老中转照旧 v1。
library;

import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

const int kFrameMagic = 0x00;
const int kFrameVersion = 2;
const int kFrameMaxBytes = 250 * 1024;
const int _kHdrBudget = 512;
const int kMessageMaxBytes = 64 * 1024 * 1024;
const int _kMaxPartials = 32;
const Duration _kPartialTtl = Duration(seconds: 60);
const int kNonceLen = 12;

bool isBinaryFrame(Object? raw) => raw is List<int> && raw.isNotEmpty && raw[0] == kFrameMagic;

class FrameHeader {
  FrameHeader({required this.to, required this.from, this.toEp, this.fromEp, this.mid, this.i, this.n});
  final String to;
  final String from;
  final String? toEp;
  final String? fromEp;
  final String? mid;
  final int? i;
  final int? n;

  Map<String, Object> toJson() => {
        'to': to,
        'from': from,
        if (toEp != null) 'to_ep': toEp!,
        if (fromEp != null) 'from_ep': fromEp!,
        if (mid != null) 'mid': mid!,
        if (i != null) 'i': i!,
        if (n != null) 'n': n!,
      };
}

Uint8List _frame(Map<String, Object> hdr, List<int> body) {
  final h = utf8.encode(jsonEncode(hdr));
  if (h.length > _kHdrBudget) throw StateError('frame header too large: ${h.length}');
  final out = Uint8List(4 + h.length + body.length);
  out[0] = kFrameMagic;
  out[1] = kFrameVersion;
  out[2] = (h.length >> 8) & 0xff;
  out[3] = h.length & 0xff;
  out.setRange(4, 4 + h.length, h);
  out.setRange(4 + h.length, out.length, body);
  return out;
}

final Random _rng = Random.secure();

String _mid() => List.generate(8, (_) => _rng.nextInt(256).toRadixString(16).padLeft(2, '0')).join();

/// 加密好的一条 → 若干帧 (小消息一帧)
List<Uint8List> encodeFrames(FrameHeader route, List<int> nonce, List<int> ciphertext,
    {int maxFrame = kFrameMaxBytes}) {
  final body = Uint8List(nonce.length + ciphertext.length)
    ..setRange(0, nonce.length, nonce)
    ..setRange(nonce.length, nonce.length + ciphertext.length, ciphertext);
  final base = FrameHeader(to: route.to, from: route.from, toEp: route.toEp, fromEp: route.fromEp).toJson();
  final budget = maxFrame - 4 - _kHdrBudget;
  if (body.length <= budget) return [_frame(base, body)];
  if (body.length > kMessageMaxBytes) throw StateError('message too large: ${body.length}');
  final n = (body.length + budget - 1) ~/ budget;
  final mid = _mid();
  return [
    for (var i = 0; i < n; i++)
      _frame({...base, 'mid': mid, 'i': i, 'n': n},
          Uint8List.sublistView(body, i * budget, min(body.length, (i + 1) * budget))),
  ];
}

/// 解一帧; 格式不对返回 null
({FrameHeader hdr, Uint8List body})? decodeFrame(List<int> raw) {
  final b = raw is Uint8List ? raw : Uint8List.fromList(raw);
  if (b.length < 4 || b[0] != kFrameMagic || b[1] != kFrameVersion) return null;
  final n = (b[2] << 8) | b[3];
  if (n == 0 || b.length <= 4 + n) return null;
  Object? j;
  try {
    j = jsonDecode(utf8.decode(Uint8List.sublistView(b, 4, 4 + n)));
  } catch (_) {
    return null;
  }
  if (j is! Map || j['to'] is! String || j['from'] is! String) return null;
  return (
    hdr: FrameHeader(
      to: j['to'] as String,
      from: j['from'] as String,
      toEp: j['to_ep'] as String?,
      fromEp: j['from_ep'] as String?,
      mid: j['mid'] as String?,
      i: (j['i'] as num?)?.toInt(),
      n: (j['n'] as num?)?.toInt(),
    ),
    body: Uint8List.sublistView(b, 4 + n),
  );
}

/// 解密后的明文: 普通是 JSON 文本; 首字节 0x01 = [0x01][jsonLen u32 BE][JSON][原始字节],
/// 文件块的字节不进 base64 (跟电脑端 rpcPlaintext.ts 一致)。
const int kPlaintextBinTag = 0x01;

({String json, Uint8List? bin})? decodeRpcPlaintext(Uint8List b) {
  if (b.isNotEmpty && b[0] == kPlaintextBinTag) {
    if (b.length < 5) return null;
    final n = (b[1] << 24) | (b[2] << 16) | (b[3] << 8) | b[4];
    if (b.length < 5 + n) return null;
    return (json: utf8.decode(Uint8List.sublistView(b, 5, 5 + n)), bin: Uint8List.sublistView(b, 5 + n));
  }
  return (json: utf8.decode(b), bin: null);
}

/// file.fetch 回包里的字节: v2 原始字节 (data_bytes) 或老格式 data_base64
Uint8List? chunkBytesOf(Map<String, dynamic>? r) {
  final raw = r?['data_bytes'];
  if (raw is Uint8List) return raw;
  final b64 = r?['data_base64'];
  if (b64 is! String) return null;
  try {
    return base64Decode(b64);
  } catch (_) {
    return null;
  }
}

class _Partial {
  _Partial(this.n) : parts = List<Uint8List?>.filled(n, null), at = DateTime.now();
  final int n;
  final List<Uint8List?> parts;
  final DateTime at;
  int got = 0;
  int bytes = 0;
}

/// 分片拼装。缺片的整条 60 秒后作废, 上层按请求超时重试 (中转不存, 不做重传)。
class FrameAssembler {
  final Map<String, _Partial> _partials = {};

  int get pending => _partials.length;

  /// 喂一帧; 齐了返回完整 body (nonce + 密文)
  Uint8List? push(FrameHeader hdr, Uint8List body) {
    final mid = hdr.mid;
    if (mid == null) return body;
    final i = hdr.i, n = hdr.n;
    if (i == null || n == null || n < 2 || i < 0 || i >= n || n * kFrameMaxBytes > kMessageMaxBytes * 2) {
      return null;
    }
    _prune();
    final key = '${hdr.from}|${hdr.fromEp ?? ''}|$mid';
    var p = _partials[key];
    if (p == null) {
      if (_partials.length >= _kMaxPartials) _partials.remove(_partials.keys.first);
      p = _partials[key] = _Partial(n);
    }
    if (p.n != n || p.parts[i] != null) return null;
    p.bytes += body.length;
    if (p.bytes > kMessageMaxBytes) {
      _partials.remove(key);
      return null;
    }
    p.parts[i] = Uint8List.fromList(body);
    p.got++;
    if (p.got < p.n) return null;
    _partials.remove(key);
    final out = BytesBuilder(copy: false);
    for (final part in p.parts) {
      out.add(part!);
    }
    return out.toBytes();
  }

  void _prune() {
    final cutoff = DateTime.now().subtract(_kPartialTtl);
    _partials.removeWhere((_, p) => p.at.isBefore(cutoff));
  }
}
