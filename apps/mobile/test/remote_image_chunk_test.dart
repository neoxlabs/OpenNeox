/// 手机端图片分块大小 —— 跟桌面 fileFetchChunk.ts 同一套预算 (2026-10-18 真机截图转圈)。
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/network/ws_client_provider.dart';
import 'package:neox_app/features/timeline/widgets/remote_image.dart';

void main() {
  test('云中转 / 云端 agent 用 96KB 块, LAN 直连用 150KB', () {
    expect(imageChunkBytesFor(WsTransport.cloudRelay), kImageChunkBytesCloud);
    expect(imageChunkBytesFor(WsTransport.cloudAgent), kImageChunkBytesCloud);
    expect(imageChunkBytesFor(WsTransport.lan), kImageChunkBytesLan);
    expect(imageChunkBytesFor(WsTransport.none), kImageChunkBytesCloud);
  });

  test('云中转一块封进信封后必须留在 250KB 上限内 (两层 base64)', () {
    const limit = 250 * 1024;
    int envelope(int bytes) {
      final dataBase64 = (bytes / 3).ceil() * 4;
      final cipher = dataBase64 + 16;
      return (cipher / 3).ceil() * 4 + 256;
    }

    expect(envelope(kImageChunkBytesCloud), lessThan(limit));
    /* 原来的 150KB 块在云中转上必然超线 —— 这就是真机上图片一直转圈的原因 */
    expect(envelope(150 * 1024), greaterThan(limit));
  });
}
