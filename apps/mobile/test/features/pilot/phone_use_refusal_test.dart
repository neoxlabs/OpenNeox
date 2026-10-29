/// pilot:D-11 —— 用户拒绝「允许操作某 App」后, 这件事要记住。
///
/// 端到端一层: 假的 neox.phone/tools 回 needs_grant, 确认框回「不允许」,
/// 看工具回执 + SharedPreferences 里的禁止名单。
library;

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;
import 'package:shared_preferences/shared_preferences.dart';

import 'package:neox_app/core/local_agent/phone_use_policy.dart';
import 'package:neox_app/core/local_agent/tools/phone_tools.dart';

const _ch = MethodChannel('neox.phone/tools');
const _control = MethodChannel('neox.phone/control');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_ch, (call) async {
      if (call.method == 'ui') {
        return {'error': '「小卖部」还没被允许操作', 'blocked': true, 'needs_grant': true, 'package': 'com.example.shop', 'label': '小卖部'};
      }
      return null;
    });
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_control, (call) async => null);
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_ch, null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_control, null);
  });

  test('拒绝后记进禁止名单, 回执让模型别再试', () async {
    final tool = PhoneUiTool((_, __) async => false);
    final r = await tool.run({'op': 'snapshot'}, sdk.ToolContext(cancel: sdk.AgentCancelToken()));

    expect(r.isError, isTrue);
    expect(r.output, contains('小卖部'));
    expect(r.output, contains('不会再问'));

    final p = await PhoneUsePolicy.load();
    expect(p.deny, contains('com.example.shop'));
    expect(p.allow, isNot(contains('com.example.shop')));
  });
}
