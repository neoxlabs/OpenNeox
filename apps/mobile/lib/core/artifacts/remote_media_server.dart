/// remote_media_server.dart — 电脑上的视频 / 音频在手机里边下边播.
///
/// 2026-10-22 用户: 「电脑端把 Excel、视频显示了, 手机端怎么办?」以前手机只能把整个文件拉下来
/// 再交给别的 App, 几十 MB 的录屏要等很久。
///
/// 做法: 手机本机起一个只监听 127.0.0.1 的小 HTTP 服务, 播放器 (video_player) 按 Range 要哪段,
/// 这里就经加密通道 (file.fetch) 去电脑拉哪段, 拉到的块缓存一小批 —— 拖进度条只拉那附近,
/// 不用下完整个文件。地址带随机 token, 本机别的 App 猜不到。
library;

import 'dart:async';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

/// 按 (偏移, 长度) 去电脑拉一块; 拉不到返回 null
typedef RemoteRangeFetch = Future<Uint8List?> Function(int offset, int length);

class _Entry {
  _Entry(this.fetch, this.size, this.mime);
  final RemoteRangeFetch fetch;
  final int size;
  final String mime;
  /// 最近拉到的块 (起点 → 字节), 播放器会反复要相邻的小段
  final Map<int, Uint8List> blocks = {};
  final Map<int, Future<Uint8List?>> inflight = {};
}

class RemoteMediaServer {
  RemoteMediaServer._();
  static final RemoteMediaServer instance = RemoteMediaServer._();

  /// 一次向电脑要多少 (电脑按通道上限再收口)
  static const int blockBytes = 512 * 1024;
  static const int _maxBlocks = 24;

  HttpServer? _server;
  final Map<String, _Entry> _entries = {};
  final Random _rng = Random.secure();

  /// 登记一个远端文件, 返回给播放器的本机地址
  Future<Uri> register({required RemoteRangeFetch fetch, required int size, required String mime}) async {
    final s = await _ensure();
    final token = List.generate(16, (_) => _rng.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
    _entries[token] = _Entry(fetch, size, mime);
    return Uri.parse('http://127.0.0.1:${s.port}/$token');
  }

  void unregister(Uri uri) => _entries.remove(uri.pathSegments.isEmpty ? '' : uri.pathSegments.first);

  Future<HttpServer> _ensure() async {
    final s = _server;
    if (s != null) return s;
    final srv = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    srv.listen(_handle, onError: (_) {});
    return _server = srv;
  }

  Future<void> _handle(HttpRequest req) async {
    final res = req.response;
    try {
      final e = _entries[req.uri.pathSegments.isEmpty ? '' : req.uri.pathSegments.first];
      if (e == null || (req.method != 'GET' && req.method != 'HEAD')) {
        res.statusCode = HttpStatus.notFound;
        return;
      }
      final range = parseRange(req.headers.value(HttpHeaders.rangeHeader), e.size);
      res.headers
        ..set(HttpHeaders.acceptRangesHeader, 'bytes')
        ..contentType = ContentType.parse(e.mime);
      if (range == null) {
        res.statusCode = HttpStatus.requestedRangeNotSatisfiable;
        res.headers.set(HttpHeaders.contentRangeHeader, 'bytes */${e.size}');
        return;
      }
      final (start, end) = range;
      final partial = req.headers.value(HttpHeaders.rangeHeader) != null;
      res.statusCode = partial ? HttpStatus.partialContent : HttpStatus.ok;
      res.contentLength = end - start + 1;
      if (partial) res.headers.set(HttpHeaders.contentRangeHeader, 'bytes $start-$end/${e.size}');
      if (req.method == 'HEAD') return;
      var pos = start;
      while (pos <= end) {
        final (blockStart, block) = await _blockAt(e, pos);
        if (block == null || block.isEmpty) break;
        final from = pos - blockStart;
        final to = min(block.length, end - blockStart + 1);
        res.add(Uint8List.sublistView(block, from, to));
        pos = blockStart + to;
        /* 先把下一块要过来, 播放不卡在来回上 */
        if (pos <= end && pos < e.size) unawaited(_blockAt(e, pos));
      }
    } catch (_) {
      /* 播放器中途断开很常见 (拖进度条), 不管 */
    } finally {
      try {
        await res.close();
      } catch (_) {}
    }
  }

  /// 含 pos 的那块: 缓存里有就用, 没有就从 pos 起拉一块 (同一起点并发只拉一次)
  Future<(int, Uint8List?)> _blockAt(_Entry e, int pos) async {
    for (final b in e.blocks.entries) {
      if (pos >= b.key && pos < b.key + b.value.length) return (b.key, b.value);
    }
    /* whenComplete 用块体: `=> remove(pos)` 会返回这个 future 自己, 等自己 = 永远完不成 */
    final f = e.inflight[pos] ??= e.fetch(pos, min(blockBytes, e.size - pos)).whenComplete(() {
      e.inflight.remove(pos);
    });
    final bytes = await f;
    if (bytes != null && bytes.isNotEmpty) {
      e.blocks[pos] = bytes;
      while (e.blocks.length > _maxBlocks) {
        e.blocks.remove(e.blocks.keys.first);
      }
    }
    return (pos, bytes);
  }
}

/// `bytes=a-b` / `bytes=a-` / `bytes=-n` → (起, 止) 闭区间; 没有 Range = 整个文件; 越界返回 null
(int, int)? parseRange(String? header, int size) {
  if (size <= 0) return null;
  if (header == null || header.isEmpty) return (0, size - 1);
  final m = RegExp(r'^bytes=(\d*)-(\d*)$').firstMatch(header.split(',').first.trim());
  if (m == null) return (0, size - 1);
  final a = m[1]!, b = m[2]!;
  if (a.isEmpty) {
    if (b.isEmpty) return null;
    final n = int.parse(b);
    return n <= 0 ? null : (max(0, size - n), size - 1);
  }
  final start = int.parse(a);
  if (start >= size) return null;
  final end = b.isEmpty ? size - 1 : min(int.parse(b), size - 1);
  return end < start ? null : (start, end);
}
