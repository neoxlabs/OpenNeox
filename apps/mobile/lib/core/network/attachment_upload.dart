/// 附件分片上传 (2026-09-29 用户: 「发送了根本都无法回复」)。
///
/// 手机 → 电脑走云中转时, 单条 envelope 上限 256KB (NeoxCloud relay.go maxEnvelopeBytes),
/// 超了中转直接断掉连接、请求丢掉、没有任何报错 —— 一张 2048px 的照片 base64 就有
/// 300~600K 字, 整个塞进 session.input 一发必断。用户看到的是"发出去了, 永远没有回复"。
///
/// 现在: 大附件先 attachment.begin / chunk / end 分片传到电脑 (每片 ≤ 128K 字 base64),
/// session.input 里只带 upload_id; 小附件 (整包仍在一片以内) 照旧内联。
library;

import 'dart:async';

/// session.input 里内联 base64 的上限 —— 连同正文一起要 < 一片
const int kInlineAttachmentB64Chars = 96 * 1024;

/// 单片 base64 字数 —— 跟桌面 mobileAttachments.MAX_UPLOAD_CHUNK_B64_LEN 一致.
/// base64 以 4 字一组, 切片必须落在 4 的倍数上, 不然每片解出来的字节接不上.
const int kUploadChunkB64Chars = 128 * 1024;

typedef RpcCall = Future<dynamic> Function(
  String method,
  Map<String, Object?> params,
);

/// 把 payload.attachments[] 里超过内联上限的项换成 upload_id 引用.
///
/// 输入元素 schema: { kind, name, mime, data_base64, size_bytes }
/// 输出元素 schema: 小的原样; 大的 → { kind, name, mime, size_bytes, upload_id }
Future<List<Map<String, Object?>>> uploadLargeAttachments(
  List<Map<String, Object?>> attachments,
  RpcCall call,
) async {
  final out = <Map<String, Object?>>[];
  for (final a in attachments) {
    final b64 = a['data_base64'];
    if (b64 is! String || b64.length <= kInlineAttachmentB64Chars) {
      out.add(a);
      continue;
    }
    final sizeBytes = a['size_bytes'] is int ? a['size_bytes'] as int : _b64Bytes(b64);
    final begin = await call('attachment.begin', {
      'kind': a['kind'],
      'name': a['name'],
      'mime': a['mime'],
      'size_bytes': sizeBytes,
    });
    final uploadId = begin is Map ? begin['upload_id'] : null;
    if (uploadId is! String || uploadId.isEmpty) {
      throw StateError('attachment.begin 没有返回 upload_id');
    }
    var index = 0;
    for (var off = 0; off < b64.length; off += kUploadChunkB64Chars) {
      final end = (off + kUploadChunkB64Chars).clamp(0, b64.length);
      await call('attachment.chunk', {
        'upload_id': uploadId,
        'index': index++,
        'data_base64': b64.substring(off, end),
      });
    }
    await call('attachment.end', {'upload_id': uploadId});
    out.add({
      'kind': a['kind'],
      'name': a['name'],
      'mime': a['mime'],
      'size_bytes': sizeBytes,
      'upload_id': uploadId,
    });
  }
  return out;
}

int _b64Bytes(String b64) {
  var pad = 0;
  if (b64.endsWith('==')) {
    pad = 2;
  } else if (b64.endsWith('=')) {
    pad = 1;
  }
  return (b64.length * 3) ~/ 4 - pad;
}
