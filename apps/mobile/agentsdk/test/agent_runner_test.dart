import 'dart:async';
import 'dart:io';

import 'package:neox_agent_sdk/neox_agent_sdk.dart';
import 'package:test/test.dart';

/// 脚本化 fake connector — 每次 stream() 按预设 turn 依次出.
class FakeConnector implements LlmConnector {
  FakeConnector(this.turns);

  /// 每个 turn 是一段 LlmDelta 列表.
  final List<List<LlmDelta>> turns;
  int callCount = 0;
  final capturedMessages = <List<ChatMessage>>[];
  final capturedToolSpecs = <List<ToolSpec>>[];

  @override
  Stream<LlmDelta> stream({
    required List<ChatMessage> messages,
    required List<ToolSpec> tools,
    required AgentCancelToken cancel,
  }) async* {
    capturedMessages.add(List.of(messages));
    capturedToolSpecs.add(tools);
    final turn = turns[callCount.clamp(0, turns.length - 1)];
    callCount++;
    for (final d in turn) {
      if (cancel.isCancelled) throw const AgentCancelled();
      yield d;
    }
  }
}


/// 前 [failFirst] 次 stream() 抛错 (可先吐一段半截), 之后正常出.
class FlakyConnector implements LlmConnector {
  FlakyConnector(this.failFirst, {this.partialBeforeFail});
  final int failFirst;
  final String? partialBeforeFail;
  int callCount = 0;

  @override
  Stream<LlmDelta> stream({
    required List<ChatMessage> messages,
    required List<ToolSpec> tools,
    required AgentCancelToken cancel,
  }) async* {
    callCount++;
    if (callCount <= failFirst) {
      if (partialBeforeFail != null) yield LlmDelta(text: partialBeforeFail);
      throw const SocketException('upload timed out');
    }
    yield const LlmDelta(text: '完成');
  }
}

/// 记录调用的 echo 工具.
class EchoTool implements AgentTool {
  final calls = <Map<String, Object?>>[];
  final bool fail;
  EchoTool({this.fail = false});

  @override
  ToolSpec get spec => const ToolSpec(
        name: 'echo',
        description: 'echo back',
        parameters: {'type': 'object', 'properties': {}},
      );

  @override
  Future<ToolResult> run(Map<String, Object?> args, ToolContext ctx) async {
    calls.add(args);
    if (fail) return const ToolResult.error('boom');
    return ToolResult.ok('echo: ${args['msg']}');
  }
}

Future<List<AgentEvent>> collect(Stream<AgentEvent> s) => s.toList();

void main() {

  group('断网耐心', () {
    AgentRunConfig cfg({Duration patience = const Duration(minutes: 60)}) => AgentRunConfig(
          isTransientError: (e) => e is SocketException,
          outagePatience: patience,
          outageBackoffUnit: const Duration(milliseconds: 1),
        );

    test('临时性错误重试这一轮, 接上后正常完成, 不报 agent_error', () async {
      final c = FlakyConnector(3);
      final events = await collect(AgentRunner(connector: c, tools: ToolRegistry(), config: cfg())
          .run(history: [{'role': 'user', 'content': 'hi'}], cancel: AgentCancelToken()));
      final kinds = events.map((e) => e.kind).toList();
      expect(kinds.where((k) => k == 'stream_retry').length, 3);
      expect(kinds, contains('stream_recovered'));
      expect(kinds, isNot(contains('agent_error')));
      expect(events.firstWhere((e) => e.kind == 'agent_text').payload['text'], '完成');
      expect(c.callCount, 4);
    });

    test('半截正文作废: discard 带出, 最终文本不含半截', () async {
      final c = FlakyConnector(1, partialBeforeFail: '半截');
      final events = await collect(AgentRunner(connector: c, tools: ToolRegistry(), config: cfg())
          .run(history: [{'role': 'user', 'content': 'hi'}], cancel: AgentCancelToken()));
      expect(events.firstWhere((e) => e.kind == 'stream_retry').payload['discard'], '半截');
      expect(events.firstWhere((e) => e.kind == 'agent_text').payload['text'], '完成');
    });

    test('没给判定 = 旧行为, 一错就结束', () async {
      final c = FlakyConnector(1);
      final events = await collect(AgentRunner(connector: c, tools: ToolRegistry())
          .run(history: [{'role': 'user', 'content': 'hi'}], cancel: AgentCancelToken()));
      expect(events.map((e) => e.kind), contains('agent_error'));
      expect(c.callCount, 1);
    });

    test('连续失败超出耐心才放弃', () async {
      final c = FlakyConnector(1000);
      final events = await collect(AgentRunner(connector: c, tools: ToolRegistry(),
              config: cfg(patience: const Duration(milliseconds: 200)))
          .run(history: [{'role': 'user', 'content': 'hi'}], cancel: AgentCancelToken()));
      expect(events.map((e) => e.kind), contains('agent_error'));
      expect(c.callCount, greaterThan(2));
    });

    test('重试等待中点停止 → 立即中断', () async {
      final c = FlakyConnector(1000);
      final cancel = AgentCancelToken();
      final runner = AgentRunner(connector: c, tools: ToolRegistry(),
          config: const AgentRunConfig(isTransientError: _always, outageBackoffUnit: Duration(seconds: 10)));
      final sw = Stopwatch()..start();
      Timer(const Duration(milliseconds: 100), cancel.cancel);
      final events = await collect(runner.run(history: [{'role': 'user', 'content': 'hi'}], cancel: cancel));
      expect(sw.elapsedMilliseconds, lessThan(3000));
      expect(events.last.kind, 'session_interrupted');
      expect(events.map((e) => e.kind), isNot(contains('agent_error')));
    });
  });

  group('AgentRunner 主循环', () {
    test('纯文本回答: delta 转发 + agent_text + turn_done', () async {
      final connector = FakeConnector([
        [const LlmDelta(text: '你好'), const LlmDelta(text: '世界')],
      ]);
      final runner = AgentRunner(
        connector: connector,
        tools: ToolRegistry(),
      );
      final events = await collect(
        runner.run(history: [
          {'role': 'user', 'content': 'hi'},
        ], cancel: AgentCancelToken()),
      );
      expect(events.map((e) => e.kind).toList(), [
        'agent_text_delta',
        'agent_text_delta',
        'agent_text',
        'agent_turn_done',
      ]);
      expect(events[2].payload['text'], '你好世界');
      expect(connector.callCount, 1);
      /* system prompt 注入 */
      expect(connector.capturedMessages.single.first['role'], 'system');
    });

    test('工具调用循环: running → result 回灌 → 第二轮总结', () async {
      final connector = FakeConnector([
        [
          const LlmDelta(text: '我查一下。'),
          const LlmDelta(toolCalls: [
            LlmToolCall(id: 'c1', name: 'echo', arguments: {'msg': 'ping'}),
          ]),
        ],
        [const LlmDelta(text: '结果是 pong。')],
      ]);
      final echo = EchoTool();
      final runner = AgentRunner(
        connector: connector,
        tools: ToolRegistry([echo]),
      );
      final events = await collect(
        runner.run(history: [
          {'role': 'user', 'content': 'ping?'},
        ], cancel: AgentCancelToken()),
      );
      expect(events.map((e) => e.kind).toList(), [
        'agent_text_delta',
        'tool_running',
        'tool_done',
        'tool_result',
        'agent_text_delta',
        'agent_text',
        'agent_turn_done',
      ]);
      expect(echo.calls.single['msg'], 'ping');
      expect(connector.callCount, 2);
      /* 第二轮 messages 里有 assistant tool_calls + tool result */
      final second = connector.capturedMessages[1];
      expect(second.any((m) => m['role'] == 'tool'), isTrue);
      final assistantMsg =
          second.lastWhere((m) => m['role'] == 'assistant');
      expect(assistantMsg['tool_calls'], isNotNull);
      /* 最终文本 = 两轮拼接, 中间空一行 (不然下一段的 markdown 标题会粘在上一句后面) */
      final textEv = events.firstWhere((e) => e.kind == 'agent_text');
      expect(textEv.payload['text'], '我查一下。\n\n结果是 pong。');
    });

    test('未知工具名 → 错误回灌但循环继续', () async {
      final connector = FakeConnector([
        [
          const LlmDelta(toolCalls: [
            LlmToolCall(id: 'c1', name: 'nope', arguments: {}),
          ]),
        ],
        [const LlmDelta(text: 'ok')],
      ]);
      final runner = AgentRunner(
        connector: connector,
        tools: ToolRegistry([EchoTool()]),
      );
      final events = await collect(
        runner.run(history: const [], cancel: AgentCancelToken()),
      );
      final result = events.firstWhere((e) => e.kind == 'tool_result');
      expect(result.payload['ok'], isFalse);
      expect('${result.payload['output']}', contains('不存在'));
      expect(events.last.kind, 'agent_turn_done');
    });

    test('工具抛异常 → ToolResult.error, 不炸循环', () async {
      final connector = FakeConnector([
        [
          const LlmDelta(toolCalls: [
            LlmToolCall(id: 'c1', name: 'echo', arguments: {'msg': 'x'}),
          ]),
        ],
        [const LlmDelta(text: 'done')],
      ]);
      final runner = AgentRunner(
        connector: connector,
        tools: ToolRegistry([EchoTool(fail: true)]),
      );
      final events = await collect(
        runner.run(history: const [], cancel: AgentCancelToken()),
      );
      final result = events.firstWhere((e) => e.kind == 'tool_result');
      expect(result.payload['ok'], isFalse);
      expect(events.last.kind, 'agent_turn_done');
    });

    test('maxTurns 到顶: 最后一轮不带工具 + 注入总结提示', () async {
      /* 每轮都想调工具的模型 */
      final connector = FakeConnector([
        [
          const LlmDelta(toolCalls: [
            LlmToolCall(id: 'c1', name: 'echo', arguments: {'msg': '1'}),
          ]),
        ],
        [
          const LlmDelta(toolCalls: [
            LlmToolCall(id: 'c2', name: 'echo', arguments: {'msg': '2'}),
          ]),
        ],
        [const LlmDelta(text: '强制总结')],
      ]);
      final runner = AgentRunner(
        connector: connector,
        tools: ToolRegistry([EchoTool()]),
        config: const AgentRunConfig(maxTurns: 3),
      );
      final events = await collect(
        runner.run(history: const [], cancel: AgentCancelToken()),
      );
      expect(connector.callCount, 3);
      /* 最后一轮: tools 空 + 有总结 system 提示 */
      expect(connector.capturedToolSpecs.last, isEmpty);
      final lastMsgs = connector.capturedMessages.last;
      expect(
        lastMsgs.any((m) =>
            m['role'] == 'system' && '${m['content']}'.contains('最大工具调用轮数')),
        isTrue,
      );
      expect(events.last.kind, 'agent_turn_done');
    });

    test('取消: 事件流以 session_interrupted 收尾', () async {
      final cancel = AgentCancelToken();
      final connector = FakeConnector([
        [const LlmDelta(text: 'a'), const LlmDelta(text: 'b')],
      ]);
      final runner = AgentRunner(
        connector: connector,
        tools: ToolRegistry(),
      );
      final events = <AgentEvent>[];
      await for (final ev in runner.run(history: const [], cancel: cancel)) {
        events.add(ev);
        if (events.length == 1) cancel.cancel();
      }
      expect(events.last.kind, 'session_interrupted');
    });

    test('工具输出超长截断 (保头尾)', () async {
      final big = 'x' * 50000;
      final connector = FakeConnector([
        [
          const LlmDelta(toolCalls: [
            LlmToolCall(id: 'c1', name: 'big', arguments: {}),
          ]),
        ],
        [const LlmDelta(text: 'ok')],
      ]);
      final runner = AgentRunner(
        connector: connector,
        tools: ToolRegistry([_BigTool(big)]),
        config: const AgentRunConfig(maxToolOutputChars: 1000),
      );
      final events = await collect(
        runner.run(history: const [], cancel: AgentCancelToken()),
      );
      final result = events.firstWhere((e) => e.kind == 'tool_result');
      final out = '${result.payload['output']}';
      expect(out.length, lessThan(1200));
      expect(out, contains('已截断'));
    });
  });

  group('CalculatorTool', () {
    final calc = CalculatorTool();
    final ctx = ToolContext(cancel: AgentCancelToken());

    test('四则 + 优先级 + 括号', () async {
      final r = await calc.run({'expression': '(12.5 * 8 + 3) / 7'}, ctx);
      expect(r.isError, isFalse);
      expect(r.output, contains('14.714285714285714'));
    });

    test('函数与常量', () async {
      final r = await calc.run({'expression': 'round(sqrt(2) * 100)'}, ctx);
      expect(r.output, contains('= 141'));
      final r2 = await calc.run({'expression': 'max(3, 7, 5)'}, ctx);
      expect(r2.output, contains('= 7'));
      final r3 = await calc.run({'expression': 'pow(2, 10)'}, ctx);
      expect(r3.output, contains('= 1024'));
    });

    test('幂右结合 + 一元负号', () async {
      final r = await calc.run({'expression': '2 ^ 3 ^ 2'}, ctx);
      expect(r.output, contains('= 512'));
      final r2 = await calc.run({'expression': '-3 + 5'}, ctx);
      expect(r2.output, contains('= 2'));
    });

    test('非法表达式报错不抛', () async {
      final r = await calc.run({'expression': '1 +* 2'}, ctx);
      expect(r.isError, isTrue);
    });
  });

  group('WorkspaceFilesTool 沙箱', () {
    late Directory tmp;
    late WorkspaceFilesTool fsTool;
    final ctx = ToolContext(cancel: AgentCancelToken());

    setUp(() async {
      tmp = await Directory.systemTemp.createTemp('agentsdk_test_');
      fsTool = WorkspaceFilesTool(rootDir: tmp);
    });

    tearDown(() async {
      await tmp.delete(recursive: true);
    });

    test('write → read → list → delete 闭环', () async {
      final w = await fsTool.run(
        {'op': 'write', 'path': 'notes/todo.md', 'content': '- 买菜'},
        ctx,
      );
      expect(w.isError, isFalse);
      final r = await fsTool.run({'op': 'read', 'path': 'notes/todo.md'}, ctx);
      expect(r.output, '- 买菜');
      final l = await fsTool.run({'op': 'list', 'path': 'notes'}, ctx);
      expect(l.output, contains('todo.md'));
      final d =
          await fsTool.run({'op': 'delete', 'path': 'notes/todo.md'}, ctx);
      expect(d.isError, isFalse);
    });

    test('append 追加', () async {
      await fsTool.run(
          {'op': 'write', 'path': 'a.txt', 'content': 'x'}, ctx);
      await fsTool.run(
          {'op': 'append', 'path': 'a.txt', 'content': 'y'}, ctx);
      final r = await fsTool.run({'op': 'read', 'path': 'a.txt'}, ctx);
      expect(r.output, 'xy');
    });

    test('越界路径拒绝', () async {
      for (final bad in ['../etc/passwd', '/etc/passwd', 'a/../../b']) {
        final r = await fsTool.run({'op': 'read', 'path': bad}, ctx);
        expect(r.isError, isTrue, reason: bad);
      }
    });
  });

  group('http_fetch HTML 提纯', () {
    test('剥 script/style/tag, 保正文', () {
      const html = '''
<html><head><title>T</title><style>.a{color:red}</style></head>
<body><script>alert(1)</script><h1>标题</h1><p>正文 &amp; 内容</p></body></html>''';
      final text = extractReadableText(html);
      expect(text, contains('标题'));
      expect(text, contains('正文 & 内容'));
      expect(text, isNot(contains('alert')));
      expect(text, isNot(contains('color:red')));
    });
  });

  group('ToolRegistry', () {
    test('重复注册抛错', () {
      final reg = ToolRegistry([EchoTool()]);
      expect(() => reg.register(EchoTool()), throwsArgumentError);
    });
  });
}

class _BigTool implements AgentTool {
  _BigTool(this.output);
  final String output;

  @override
  ToolSpec get spec => const ToolSpec(
        name: 'big',
        description: 'big output',
        parameters: {'type': 'object', 'properties': {}},
      );

  @override
  Future<ToolResult> run(Map<String, Object?> args, ToolContext ctx) async =>
      ToolResult.ok(output);
}

bool _always(Object _) => true;
