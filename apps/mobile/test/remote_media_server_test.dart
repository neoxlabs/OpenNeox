import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/artifacts/remote_media_server.dart';

void main() {
  test('parseRange', () {
    expect(parseRange(null, 100), (0, 99));
    expect(parseRange('bytes=10-19', 100), (10, 19));
    expect(parseRange('bytes=90-', 100), (90, 99));
    expect(parseRange('bytes=-5', 100), (95, 99));
    expect(parseRange('bytes=10-500', 100), (10, 99));
    expect(parseRange('bytes=100-', 100), isNull);
    expect(parseRange('bytes=20-10', 100), isNull);
  });

  test('按 Range 去远端拉块, 跨块拼接, 拉过的块不重拉', () async {
    HttpOverrides.global = null;
    const size = 1300 * 1024;
    final file = Uint8List.fromList(List.generate(size, (i) => (i * 7) & 0xff));
    final calls = <int>[];
    /* 模拟电脑按 96KB 收口 (老协议云中转), 服务要能接着拉 */
    Future<Uint8List?> fetch(int off, int len) async {
      calls.add(off);
      final n = len > 96 * 1024 ? 96 * 1024 : len;
      return Uint8List.sublistView(file, off, off + n);
    }

    final uri = await RemoteMediaServer.instance.register(fetch: fetch, size: size, mime: 'video/mp4');
    final client = HttpClient()..findProxy = (_) => 'DIRECT';
    Future<(int, Map<String, String>, List<int>)> get(String? range) async {
      final req = await client.getUrl(uri);
      if (range != null) req.headers.set(HttpHeaders.rangeHeader, range);
      final res = await req.close();
      final body = <int>[];
      await for (final c in res) {
        body.addAll(c);
      }
      return (res.statusCode, {'cr': res.headers.value(HttpHeaders.contentRangeHeader) ?? ''}, body);
    }

    final (code, h, body) = await get('bytes=100000-400000');
    expect(code, 206);
    expect(h['cr'], 'bytes 100000-400000/$size');
    expect(body, file.sublist(100000, 400001));
    final before = calls.length;
    final (_, __, again) = await get('bytes=150000-160000');
    expect(again, file.sublist(150000, 160001));
    expect(calls.length, before, reason: '已缓存的块不该重拉');
    final (full, ___, all) = await get(null);
    expect(full, 200);
    expect(all.length, size);
    expect(all.sublist(size - 10), file.sublist(size - 10));
    final (bad, ____, _____) = await get('bytes=${size + 1}-');
    expect(bad, 416);
    client.close();
  });
}
