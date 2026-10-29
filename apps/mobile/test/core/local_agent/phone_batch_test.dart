/// pilot:D-05 —— 批量动作原语 batch.
///
/// 盯三件事: 按顺序做、失败就停、最后一步整屏 (中间屏不塞给模型)。
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;

import 'package:neox_app/core/local_agent/tools/phone_batch.dart';

const sdk.ToolSpec _uiSpec = sdk.ToolSpec(name: 'phone_ui', description: '', parameters: {});
const sdk.ToolSpec _appSpec = sdk.ToolSpec(name: 'open_app', description: '', parameters: {});

class _FakeTool implements sdk.AgentTool {
  _FakeTool(this.spec, this.onRun);

  @override
  final sdk.ToolSpec spec;
  final Future<sdk.ToolResult> Function(Map<String, Object?> args) onRun;

  @override
  Future<sdk.ToolResult> run(Map<String, Object?> args, sdk.ToolContext ctx) => onRun(args);
}

sdk.ToolContext _ctx() => sdk.ToolContext(cancel: sdk.AgentCancelToken());

void main() {
  test('三步按顺序做: 中间屏只留一行, 最后一步 phone_ui 回整屏', () async {
    final calls = <Map<String, Object?>>[];
    final ui = _FakeTool(_uiSpec, (a) async {
      calls.add(a);
      if (a['op'] == 'snapshot') {
        return const sdk.ToolResult.ok('现在在「美团」, 屏幕上 12 个控件:\n[7] 按钮 「提交订单」\n[8] 按钮 「返回」');
      }
      return sdk.ToolResult.ok('${a['op']}。 现在在「美团」, 屏幕上 12 个控件:\n[1] 按钮 「控件 1」\n[2] 按钮 「控件 2」');
    });
    final batch = PhoneBatchTool((n) => n == 'phone_ui' ? ui : null);

    final r = await batch.run({
      'steps': [
        {'op': 'tap', 'target': 3},
        {'op': 'type', 'target': 4, 'text': '珍珠奶茶'},
        {'tool': 'phone_ui', 'args': {'op': 'snapshot'}},
      ],
    }, _ctx());

    expect(r.isError, isFalse, reason: r.output);
    expect(calls.map((c) => c['op']).toList(), ['tap', 'type', 'snapshot']);
    expect(calls[0].containsKey('full'), isFalse);
    expect(calls[1].containsKey('full'), isFalse);
    expect(calls[2]['full'], isTrue);
    expect(r.output, contains('批量 3 步全部完成'));
    expect(r.output, contains('最终屏幕 (整屏)'));
    expect(r.output, contains('[7] 按钮 「提交订单」'));
    /* 中间两步的整屏没有塞进结果 */
    expect(r.output, isNot(contains('[1] 按钮 「控件 1」')));
  });

  test('十步下单: 一次工具调用做完, 不再十轮往返', () async {
    final calls = <Map<String, Object?>>[];
    final ui = _FakeTool(_uiSpec, (a) async {
      calls.add(a);
      if (a['op'] == 'snapshot') {
        return const sdk.ToolResult.ok('现在在「美团外卖」, 屏幕上 8 个控件:\n[8] 按钮 「提交订单」');
      }
      return sdk.ToolResult.ok('${a['op']}。 现在在「美团外卖」, 屏幕上 8 个控件:\n[1] …');
    });
    final batch = PhoneBatchTool((n) => n == 'phone_ui' ? ui : null);
    final steps = <Object?>[
      {'op': 'tap', 'target': 1},
      {'op': 'tap', 'target': 2},
      {'op': 'tap', 'target': 3},
      {'op': 'type', 'target': 4, 'text': '珍珠奶茶'},
      {'op': 'scroll', 'direction': 'down'},
      {'op': 'tap', 'target': 5},
      {'op': 'tap', 'target': 6},
      {'op': 'tap', 'target': 7},
      {'op': 'back'},
      {'tool': 'phone_ui', 'args': {'op': 'snapshot'}},
    ];

    final r = await batch.run({'steps': steps}, _ctx());

    expect(r.isError, isFalse, reason: r.output);
    expect(calls, hasLength(10));
    expect(r.output, contains('批量 10 步全部完成'));
    expect(RegExp(r'^\d+\. phone_ui', multiLine: true).allMatches(r.output), hasLength(10));
    expect(r.output, contains('最终屏幕 (整屏)'));
    expect(r.output, contains('[8] 按钮 「提交订单」'));
  });

  test('最后一步不是读屏: 不假装有整屏, 让模型再 snapshot', () async {
    final calls = <Map<String, Object?>>[];
    final ui = _FakeTool(_uiSpec, (a) async {
      calls.add(a);
      return const sdk.ToolResult.ok('在点按。 现在在「美团」, 屏幕上 12 个控件:\n[1] …');
    });
    final app = _FakeTool(_appSpec, (a) async {
      calls.add(a);
      return const sdk.ToolResult.ok('已打开');
    });
    final batch = PhoneBatchTool((n) => n == 'phone_ui' ? ui : n == 'open_app' ? app : null);

    final r = await batch.run({
      'steps': [
        {'op': 'tap', 'target': 3},
        {'tool': 'open_app', 'args': {'op': 'open', 'package': 'me.ele'}},
      ],
    }, _ctx());

    expect(r.isError, isFalse, reason: r.output);
    expect(calls, hasLength(2));
    expect(calls[1].containsKey('full'), isFalse);
    expect(r.output, contains('最后一步不是读屏'));
    expect(r.output, isNot(contains('最终屏幕')));
  });

  test('某步失败就停: 后面的步骤不执行, 补一次整屏让模型看清停在哪', () async {
    final calls = <Map<String, Object?>>[];
    final ui = _FakeTool(_uiSpec, (a) async {
      calls.add(a);
      if (a['op'] == 'type') return const sdk.ToolResult.error('没有第 9 个控件, 先 snapshot 看看现在屏幕上有什么');
      if (a['op'] == 'snapshot') {
        return const sdk.ToolResult.ok('现在在「美团」, 屏幕上 12 个控件:\n[5] 输入框 「口味」');
      }
      return const sdk.ToolResult.ok('在点按。 现在在「美团」, 屏幕上 12 个控件:\n[1] …');
    });
    final batch = PhoneBatchTool((n) => n == 'phone_ui' ? ui : null);

    final r = await batch.run({
      'steps': [
        {'op': 'tap', 'target': 3},
        {'op': 'type', 'target': 9, 'text': 'x'},
        {'op': 'tap', 'target': 7},
      ],
    }, _ctx());

    expect(r.isError, isTrue);
    expect(calls.map((c) => c['op']).toList(), ['tap', 'type', 'snapshot']);
    expect(calls[2]['full'], isTrue);
    expect(r.output, contains('第 2 步失败'));
    expect(r.output, contains('后面 1 步没做'));
    expect(r.output, contains('没有第 9 个控件'));
    expect(r.output, contains('现在的屏幕 (整屏)'));
    expect(r.output, contains('[5] 输入框 「口味」'));
    /* 失败后的那一步 (tap target 7) 没有被执行 */
    expect(calls.where((c) => c['op'] == 'tap'), hasLength(1));
  });

  test('参数校验: 空 / 太多 / 不认识的工具 / 套娃 / 截图 / 长文都当场说清楚', () {
    expect(parsePhoneBatchSteps(null).error, isNotNull);
    expect(parsePhoneBatchSteps(<Object?>[]).error, isNotNull);
    expect(parsePhoneBatchSteps(List<Object?>.generate(13, (_) => <String, Object?>{'op': 'snapshot'})).error, contains('最多'));
    expect(parsePhoneBatchSteps(<Object?>[
      {'tool': 'send_sms', 'args': <String, Object?>{}},
    ]).error, contains('只做 phone_ui / open_app'));
    expect(parsePhoneBatchSteps(<Object?>[
      {'tool': 'batch', 'args': <String, Object?>{}},
    ]).error, contains('不能再套 batch'));
    expect(parsePhoneBatchSteps(<Object?>[
      {'op': 'screenshot'},
    ]).error, contains('op 只能是'));
    expect(parsePhoneBatchSteps(<Object?>[
      {'op': 'read_text', 'pages': 3},
    ]).error, contains('op 只能是'));
    expect(parsePhoneBatchSteps(<Object?>[
      {'tool': 'phone_ui', 'args': 'x'},
    ]).error, contains('args 要是对象'));
  });

  test('省略 tool 时按 phone_ui; 显式写 open_app 也认', () {
    final ok = parsePhoneBatchSteps(<Object?>[
      {'op': 'tap', 'target': 1},
      {'tool': 'open_app', 'args': {'op': 'open', 'package': 'me.ele'}},
    ]);
    expect(ok.error, isNull);
    expect(ok.steps, hasLength(2));
    expect(ok.steps![0].tool, 'phone_ui');
    expect(ok.steps![0].op, 'tap');
    expect(ok.steps![1].tool, 'open_app');
  });

  test('不改模型给的 step 参数 (full 是内部注入的)', () async {
    final step = <String, Object?>{'op': 'snapshot'};
    final ui = _FakeTool(_uiSpec, (a) async => const sdk.ToolResult.ok('现在在「美团」, 屏幕上 1 个控件:\n[1] …'));
    final batch = PhoneBatchTool((n) => n == 'phone_ui' ? ui : null);

    await batch.run({'steps': <Object?>[step]}, _ctx());
    expect(step.containsKey('full'), isFalse);
  });

  test('取消后不再做下一步', () async {
    final cancel = sdk.AgentCancelToken();
    var calls = 0;
    final ui = _FakeTool(_uiSpec, (a) async {
      calls++;
      cancel.cancel();
      return const sdk.ToolResult.ok('在点按。 现在在「美团」, 屏幕上 1 个控件:\n[1] …');
    });
    final batch = PhoneBatchTool((n) => n == 'phone_ui' ? ui : null);

    await expectLater(
      batch.run({'steps': <Object?>[{'op': 'tap', 'target': 1}, {'op': 'tap', 'target': 2}]}, sdk.ToolContext(cancel: cancel)),
      throwsA(isA<sdk.AgentCancelled>()),
    );
    expect(calls, 1);
  });
}
