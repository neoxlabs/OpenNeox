/// apk_ranged_download_test.dart — 分段并发下载必须真跑一遍.
///
/// 2026-09-18 真机实录 (用户截图): 更新页红字
///   `An async operation is currently pending`
/// 四段并发下载共用**一个** RandomAccessFile。一个句柄只有一个游标, 也只允许一个在途
/// 异步操作, 两段一交错就抛这个 —— 而且抛得毫无提示性, 用户只看到一句英文异常。
///
/// 为什么原来的测试没拦住: 只测了 debugPlanSegments (区间算得对不对)。区间全对,
/// 一落地就炸。这类"并发下才出现"的问题只有真起一个 HTTP server 跑一遍才测得到。
///
/// 所以这个文件里两条都按真实链路来:
///   · 真 HttpServer, 支持 Range, 按 206 + Content-Range 回;
///   · 下完逐字节比对 —— 分段写错偏移的后果是"文件长度对、内容花", 长度断言抓不到。
library;

import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/startup/apk_updater.dart';

/// 起一个支持 Range 的静态文件服务, 返回 (url, 关闭函数).
Future<(String, Future<void> Function())> _serve(Uint8List body) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((req) async {
    final range = req.headers.value('range');
    if (range == null) {
      req.response
        ..statusCode = 200
        ..headers.set('accept-ranges', 'bytes')
        ..headers.contentLength = body.length
        ..add(body);
      await req.response.close();
      return;
    }
    /* bytes=start-end */
    final m = RegExp(r'bytes=(\d+)-(\d+)').firstMatch(range);
    if (m == null) {
      req.response.statusCode = 416;
      await req.response.close();
      return;
    }
    final start = int.parse(m.group(1)!);
    final end = int.parse(m.group(2)!);
    final slice = body.sublist(start, end + 1);
    req.response
      ..statusCode = 206
      ..headers.set('accept-ranges', 'bytes')
      ..headers.set('content-range', 'bytes $start-$end/${body.length}')
      ..headers.contentLength = slice.length
      ..add(slice);
    await req.response.close();
  });
  return (
    'http://${server.address.address}:${server.port}/pkg.apk',
    () async => server.close(force: true),
  );
}

void main() {
  test('分段并发下载: 不抛 async pending, 且内容逐字节正确', () async {
    /* 要大到真的会被切成多段 (_kMinSegmentBytes = 4MB, 上限 4 段) */
    const total = 17 * 1024 * 1024;
    final rnd = Random(7);
    final body = Uint8List.fromList(
      List<int>.generate(total, (_) => rnd.nextInt(256)),
    );
    final (url, close) = await _serve(body);
    final dir = await Directory.systemTemp.createTemp('neox-apk-test');
    final file = File('${dir.path}/pkg.apk');

    try {
      final updater = ApkUpdater();
      /* 这一句在修之前会抛 FileSystemException:
       *   "An async operation is currently pending" */
      await updater.debugDownloadRanged(url: url, file: file, total: total);

      expect(await file.length(), total, reason: '长度必须等于总长');
      final got = await file.readAsBytes();
      /* 逐字节比 —— 段偏移写错时长度照样对, 只有内容是花的 (装机时才报解析失败) */
      expect(got.length, body.length);
      var firstDiff = -1;
      for (var i = 0; i < body.length; i++) {
        if (got[i] != body[i]) { firstDiff = i; break; }
      }
      expect(firstDiff, -1, reason: '第 $firstDiff 字节开始对不上 — 段偏移写错了');
    } finally {
      await close();
      await dir.delete(recursive: true);
    }
  }, timeout: const Timeout(Duration(seconds: 60)));

  test('切出来的区间首尾相接、不重叠、覆盖全长', () {
    final updater = ApkUpdater();
    for (final total in [1024, 9 * 1024 * 1024, 17 * 1024 * 1024, 94 * 1024 * 1024]) {
      final segs = updater.debugPlanSegments(total);
      expect(segs.first.$1, 0, reason: '$total: 第一段必须从 0 开始');
      expect(segs.last.$2, total - 1, reason: '$total: 最后一段必须到 total-1');
      for (var i = 1; i < segs.length; i++) {
        expect(segs[i].$1, segs[i - 1].$2 + 1, reason: '$total: 第 $i 段跟上一段没接上');
      }
    }
  });
}
