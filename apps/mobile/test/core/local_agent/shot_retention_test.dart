/// pilot:D-08 —— 任务结束删掉本轮截图 (Dart 侧接线).
///
/// 原生实现在 ShotRound.kt / ScreenshotCache.sweepAll (有 JVM 单测)。
/// 这里钉住两件事: 安卓上确实去调 `uiRoundEnd`; 通道不通 / 非安卓绝不把任务搞挂。
library;

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/local_agent/tools/shot_retention.dart';

const _ch = MethodChannel('neox.phone/tools');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late List<String> methods;
  late Object? reply;

  setUp(() {
    methods = <String>[];
    reply = {'deleted': 2};
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_ch, (call) async {
      methods.add(call.method);
      return reply;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_ch, null);
  });

  test('任务结束 → 叫原生删本轮截图, 回删了几张', () async {
    expect(await endRoundShots(android: true), 2);
    expect(methods, ['uiRoundEnd']);
  });

  test('非安卓 → 不碰通道', () async {
    expect(await endRoundShots(android: false), 0);
    expect(methods, isEmpty);
  });

  test('通道报错 → 按 0 算, 不影响任务', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_ch, (call) async {
      throw PlatformException(code: 'boom');
    });
    expect(await endRoundShots(android: true), 0);
  });
}
