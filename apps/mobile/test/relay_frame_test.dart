import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/network/relay_frame.dart';

void main() {
  final route = FrameHeader(to: 'd', from: 'p');

  test('单帧字节跟电脑端 / 中转一致', () {
    final nonce = List<int>.generate(12, (i) => i);
    final ct = [0xaa, 0xbb];
    final frames = encodeFrames(route, nonce, ct);
    expect(frames, hasLength(1));
    final hdr = utf8.encode('{"to":"d","from":"p"}');
    expect(frames.first, [0x00, 0x02, 0x00, hdr.length, ...hdr, ...nonce, ...ct]);
  });

  test('3MB 切片, 乱序拼回', () {
    final rng = Random(1);
    final nonce = List<int>.generate(12, (_) => rng.nextInt(256));
    final ct = Uint8List.fromList(List<int>.generate(3 * 1024 * 1024, (_) => rng.nextInt(256)));
    final frames = encodeFrames(route, nonce, ct);
    expect(frames.length, greaterThan(10));
    final asm = FrameAssembler();
    Uint8List? whole;
    for (final f in frames.reversed) {
      expect(isBinaryFrame(f), isTrue);
      expect(f.length, lessThanOrEqualTo(kFrameMaxBytes));
      final d = decodeFrame(f)!;
      whole = asm.push(d.hdr, d.body) ?? whole;
    }
    expect(whole, isNotNull);
    expect(whole!.sublist(0, 12), nonce);
    expect(whole.sublist(12), ct);
    expect(asm.pending, 0);
  });

  test('带原始字节的明文 (跟电脑端 rpcPlaintext.ts 一致)', () {
    final json = utf8.encode('{"jsonrpc":"2.0","id":"1","result":{"data_bin":3}}');
    final b = Uint8List.fromList([0x01, 0, 0, 0, json.length, ...json, 7, 8, 9]);
    final pt = decodeRpcPlaintext(b)!;
    expect(jsonDecode(pt.json)['result']['data_bin'], 3);
    expect(pt.bin, [7, 8, 9]);
    final plain = decodeRpcPlaintext(Uint8List.fromList(utf8.encode('{"a":1}')))!;
    expect(plain.bin, isNull);
    expect(chunkBytesOf({'data_bytes': Uint8List.fromList([1])}), [1]);
    expect(chunkBytesOf({'data_base64': base64Encode([2, 3])}), [2, 3]);
    expect(chunkBytesOf({'data_base64': '%%'}), isNull);
  });

  test('坏帧 / 重复片 / v1 文本都不认', () {
    expect(decodeFrame(utf8.encode('{"to_device_id":"x"}')), isNull);
    expect(isBinaryFrame(utf8.encode('{"a":1}')), isFalse);
    final frames = encodeFrames(route, List.filled(12, 0), Uint8List(600 * 1024));
    final d = decodeFrame(frames.first)!;
    final asm = FrameAssembler();
    expect(asm.push(d.hdr, d.body), isNull);
    expect(asm.push(d.hdr, d.body), isNull);
    expect(asm.pending, 1);
  });
}
