/// DSML 文本形态工具调用 (2026-10-12 用户真机: 去 QQ 看消息第 11 步, 正文变成一屏 <｜DSML｜invoke …>)。
import 'package:neox_agent_sdk/neox_agent_sdk.dart';
import 'package:neox_agent_sdk/src/dsml_tool_calls.dart';
import 'package:test/test.dart';

import 'agent_runner_test.dart' show FakeConnector, EchoTool, collect;

/// 用户截图里那一段 (外壳是 calls, 分隔符全角竖线写两遍)
const _shot = '我先看看。\n<｜｜DSML｜｜calls>\n<｜｜DSML｜｜invoke name="echo">\n'
    '<｜｜DSML｜｜parameter name="op" string="true">tap</｜｜DSML｜｜parameter>\n'
    '<｜｜DSML｜｜parameter name="target" string="false">3</｜｜DSML｜｜parameter>\n'
    '</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜calls>';

/// 2026-10-18 实拍: 正文只有 DSML 的**闭合标签** (开头那半进了思考流), 竖线后还带空格。
const _orphanClose = 'Let me do it in one edit for ui.ts and one for settings.test.ts.</｜｜DSML｜｜ parameter>\n'
    '</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';

void main() {
  test('只有闭合标签的残片: 判为残缺, 残片摘干净, 人话留下', () {
    final p = parseDsmlToolCalls(_orphanClose);
    expect(p.calls, isEmpty);
    expect(p.sawIncomplete, isTrue);
    expect(p.text, contains('Let me do it in one edit'));
    expect(p.text, isNot(contains('DSML')));
  });

  test('竖线与关键字之间的空格 + calls 外壳照常解析', () {
    const src = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="echo">\n'
        '<｜｜DSML｜｜ parameter name="op" string="true">tap</｜｜DSML｜｜ parameter>\n'
        '</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
    final p = parseDsmlToolCalls(src);
    expect(p.calls.single.name, 'echo');
    expect(p.calls.single.arguments, {'op': 'tap'});
    expect(p.sawIncomplete, isFalse);
    expect(p.text, isEmpty);
  });

  test('残缺 → 追加提示重来 → 第二次正常调用工具 → 任务继续', () async {
    final echo = EchoTool();
    final connector = FakeConnector([
      [const LlmDelta(text: _orphanClose)],
      [
        const LlmDelta(toolCalls: [
          LlmToolCall(id: 'c1', name: 'echo', arguments: {'msg': 'ping'}),
        ]),
      ],
      [const LlmDelta(text: '完成')],
    ]);
    final events = await collect(AgentRunner(
      connector: connector,
      tools: ToolRegistry([echo]),
    ).run(history: [
      {'role': 'user', 'content': 'hi'},
    ], cancel: AgentCancelToken()));

    expect(connector.callCount, 3);
    expect(echo.calls.single, {'msg': 'ping'});
    expect(events.map((e) => e.kind), isNot(contains('agent_error')));
    /* 重来的那一轮: 模型看见了「格式不完整」的提示 */
    final second = connector.capturedMessages[1];
    expect(
      second.any((m) => '${m['content']}'.contains('格式不完整')),
      isTrue,
    );
    expect(events.last.kind, 'agent_turn_done');
  });

  test('连续两次还残缺 → 如实结束并带提示', () async {
    final connector = FakeConnector([
      [const LlmDelta(text: _orphanClose)],
    ]);
    final events = await collect(AgentRunner(
      connector: connector,
      tools: ToolRegistry(),
    ).run(history: const [], cancel: AgentCancelToken()));

    /* 1 次原始 + 2 次重来 = 3 次, 之后不再请求 */
    expect(connector.callCount, 3);
    final err = events.firstWhere((e) => e.kind == 'agent_error');
    expect('${err.payload['message']}', contains('DSML'));
  });

  test('解析: 参数按 string 标记取类型, 人话留下, 外壳摘掉', () {
    final p = parseDsmlToolCalls(_shot);
    expect(p.calls.single.name, 'echo');
    expect(p.calls.single.arguments, {'op': 'tap', 'target': 3});
    expect(p.text, '我先看看。');
    expect(p.sawIncomplete, isFalse);
  });

  test('半截的 (invoke 没闭合) 不执行', () {
    final p = parseDsmlToolCalls('<｜DSML｜function_calls>\n<｜DSML｜invoke name="echo">\n<｜DSML｜parameter name="op" string="true">ta');
    expect(p.calls, isEmpty);
    expect(p.sawIncomplete, isTrue);
    expect(p.text, isEmpty);
  });

  test('运行: 分块流进来的 DSML 不显示, 翻成真调用执行, 下一轮接着答', () async {
    /* 切成小块, 让「<｜｜DS」这种半截头出现在块尾 */
    final chunks = <LlmDelta>[];
    for (var i = 0; i < _shot.length; i += 7) {
      chunks.add(LlmDelta(text: _shot.substring(i, i + 7 > _shot.length ? _shot.length : i + 7)));
    }
    final echo = EchoTool();
    final runner = AgentRunner(
      connector: FakeConnector([chunks, [const LlmDelta(text: '看完了')]]),
      tools: ToolRegistry([echo]),
    );
    final events = await collect(runner.run(history: [
      {'role': 'user', 'content': 'hi'},
    ], cancel: AgentCancelToken()));
    final shown = events.where((e) => e.kind == 'agent_text_delta').map((e) => e.payload['content']).join();
    expect(shown, isNot(contains('DSML')));
    expect(shown, contains('我先看看。'));
    expect(shown, contains('看完了'));
    expect(echo.calls.single, {'op': 'tap', 'target': 3});
    final finalText = events.firstWhere((e) => e.kind == 'agent_text').payload['text'] as String;
    expect(finalText, isNot(contains('DSML')));
  });

  test('正文里普通的「<」照常显示', () async {
    final runner = AgentRunner(
      connector: FakeConnector([[const LlmDelta(text: 'a <'), const LlmDelta(text: ' b')]]),
      tools: ToolRegistry(),
    );
    final events = await collect(runner.run(history: [
      {'role': 'user', 'content': 'hi'},
    ], cancel: AgentCancelToken()));
    final shown = events.where((e) => e.kind == 'agent_text_delta').map((e) => e.payload['content']).join();
    expect(shown, 'a < b');
  });
}
