/// pilot:D-07 —— phone_ui 坐标点击的自检接线.
///
/// 原生侧做文字比对 / 包名自检 (TapSelfCheck.kt, 有 JVM 单测); 这里钉住:
/// expect 真的传到了原生, 原生回的「点完不在原来的 App」提醒真的到了模型眼前。
library;

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;
import 'package:shared_preferences/shared_preferences.dart';

import 'package:neox_app/core/local_agent/tools/phone_tools.dart';
import 'package:neox_app/core/local_agent/tools/snapshot_diff.dart';

const _ch = MethodChannel('neox.phone/tools');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<Object?, Object?> lastArgs;
  late Object? next;

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    snapshotDiff.reset();
    next = null;
    lastArgs = const {};
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_ch, (call) async {
      if (call.method != 'ui') return null;
      lastArgs = call.arguments as Map<Object?, Object?>;
      return next;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_ch, null);
    snapshotDiff.reset();
  });

  sdk.ToolContext ctx() => sdk.ToolContext(cancel: sdk.AgentCancelToken());

  test('expect 原样传给原生 (它才是拦下改版后点错的那道)', () async {
    next = {
      'app': '美团',
      'package': 'com.sankuai.meituan',
      'elements': '[1] 按钮 「去结算」',
      'count': 1,
      'did': '点了坐标 (100, 200)',
    };
    final tool = PhoneUiTool((_, __) async => true);
    final r = await tool.run({'op': 'tap_at', 'x': 100, 'y': 200, 'expect': '立即下单'}, ctx());

    expect(r.isError, isFalse, reason: r.output);
    expect(lastArgs['op'], 'tap_at');
    expect(lastArgs['expect'], '立即下单');
  });

  test('原生说点完前台换 App 了 → 提醒带进回执, 不叫成功', () async {
    next = {
      'app': '微信',
      'package': 'com.tencent.mm',
      'elements': '[1] 按钮 「发送」',
      'count': 1,
      'did': '点了坐标 (100, 200)',
      'warning': '点了之后前台从「com.sankuai.meituan / 「美团」」变成了「com.tencent.mm / 「微信」」',
    };
    final tool = PhoneUiTool((_, __) async => true);
    final r = await tool.run({'op': 'tap_at', 'x': 100, 'y': 200, 'expect': '去结算'}, ctx());

    expect(r.isError, isFalse, reason: r.output);
    expect(r.output, contains('自检'));
    expect(r.output, contains('com.tencent.mm'));
  });

  test('原生拒点 (坐标上不是 expect 说的字) → 工具回错误让模型重截图', () async {
    next = {'error': '坐标上现在是「去结算」, 不是你说的「立即下单」(com.sankuai.meituan)。界面多半改版了, 没点。'};
    final tool = PhoneUiTool((_, __) async => true);
    final r = await tool.run({'op': 'tap_at', 'x': 100, 'y': 200, 'expect': '立即下单'}, ctx());

    expect(r.isError, isTrue);
    expect(r.output, contains('没点'));
  });
}
