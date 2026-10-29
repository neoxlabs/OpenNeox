/// pilot:D-04 —— phone_ui 读屏接上增量: 同一个界面第二次只回变了的控件.
///
/// 这里是端到端一层: 假的 neox.phone/tools 通道回整屏, 工具吐给模型的文本才算数。
library;

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;
import 'package:shared_preferences/shared_preferences.dart';

import 'package:neox_app/core/local_agent/tools/phone_tools.dart';
import 'package:neox_app/core/local_agent/tools/snapshot_diff.dart';

const _ch = MethodChannel('neox.phone/tools');

Map<String, Object?> _snapshot(List<String> elements, {String pkg = 'com.sankuai.meituan'}) => {
      'app': '美团',
      'package': pkg,
      'elements': elements.join('\n'),
      'count': elements.length,
    };

List<String> _screen(int n, {Map<int, String> changed = const {}}) => List.generate(
      n,
      (i) => changed[i + 1] ?? '[${i + 1}] 按钮 「控件 ${i + 1}」',
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Object? next;
  late int calls;

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    snapshotDiff.reset();
    calls = 0;
    next = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_ch, (call) async {
      if (call.method != 'ui') return null;
      calls++;
      return next;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_ch, null);
    snapshotDiff.reset();
  });

  sdk.ToolContext ctx() => sdk.ToolContext(cancel: sdk.AgentCancelToken());

  Future<String> snapshot(PhoneUiTool tool, {Map<String, Object?> extra = const {}}) async {
    final r = await tool.run({'op': 'snapshot', ...extra}, ctx());
    expect(r.isError, isFalse, reason: r.output);
    return r.output;
  }

  test('同一屏再读: 第二次回执 ≤20%', () async {
    final tool = PhoneUiTool((_, __) async => true);

    next = _snapshot(_screen(60));
    final first = await snapshot(tool);
    expect(first, contains('[60] 按钮 「控件 60」'));

    next = _snapshot(_screen(60, changed: {12: '[12] 输入框 「珍珠奶茶」'}));
    final second = await snapshot(tool);

    expect(second, contains('[12] 输入框 「珍珠奶茶」'));
    expect(second, contains('[1-11] 同上'));
    expect(second, contains('[13-60] 同上'));
    expect(second, isNot(contains('[59] 按钮 「控件 59」')));
    expect(second.length * 100, lessThanOrEqualTo(first.length * 20));
    expect(second, contains('full=true'));
  });

  test('full=true 拿回整屏 (上下文里没有上一屏时)', () async {
    final tool = PhoneUiTool((_, __) async => true);
    next = _snapshot(_screen(30));
    await snapshot(tool);

    next = _snapshot(_screen(30));
    final second = await snapshot(tool, extra: {'full': true});
    expect(second, contains('[30] 按钮 「控件 30」'));
    expect(second, isNot(contains('同上')));
  });

  test('翻过页 (read_text) 之后下一次 snapshot 是整屏', () async {
    final tool = PhoneUiTool((_, __) async => true);
    next = _snapshot(_screen(20));
    await snapshot(tool);

    next = {'app': '微信', 'package': 'com.tencent.mm', 'pages': 2, 'text': '对方: 在吗\n我: 在', 'truncated': false};
    final rt = await tool.run({'op': 'read_text', 'pages': 2}, ctx());
    expect(rt.isError, isFalse, reason: rt.output);

    next = _snapshot(_screen(20), pkg: 'com.tencent.mm');
    final after = await snapshot(tool);
    expect(after, contains('[20] 按钮 「控件 20」'));
    expect(after, isNot(contains('同上')));
  });

  test('出错后不再回「同上」, 下一步能看清屏幕', () async {
    final tool = PhoneUiTool((_, __) async => true);
    next = _snapshot(_screen(10));
    await snapshot(tool);

    next = {'error': '没有第 99 个控件, 先 snapshot 看看现在屏幕上有什么'};
    final bad = await tool.run({'op': 'tap', 'target': 99}, ctx());
    expect(bad.isError, isTrue);

    next = _snapshot(_screen(10));
    final after = await snapshot(tool);
    expect(after, contains('[10] 按钮 「控件 10」'));
    expect(calls, 3);
  });
}
