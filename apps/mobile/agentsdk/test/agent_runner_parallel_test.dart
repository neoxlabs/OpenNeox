/// 同一轮的多个工具调用要**并发**跑 (总控裁决第六节: 速度靠并发)。
///
/// 5 个搜索 / 3 张图的总耗时应该 ≈ 单次, 而不是 5 倍 / 3 倍;
/// 没声明 parallelSafe 的工具 (写盘 / 跑命令 / 动手机) 仍然逐个串行, 行为不变。
library;

import 'dart:async';

import 'package:neox_agent_sdk/neox_agent_sdk.dart';
import 'package:test/test.dart';

/// 脚本化 fake connector — 每次 stream() 按预设 turn 依次出.
class _ScriptedConnector implements LlmConnector {
  _ScriptedConnector(this.turns);

  final List<List<LlmDelta>> turns;
  int callCount = 0;

  @override
  Stream<LlmDelta> stream({
    required List<ChatMessage> messages,
    required List<ToolSpec> tools,
    required AgentCancelToken cancel,
  }) async* {
    final turn = turns[callCount.clamp(0, turns.length - 1)];
    callCount++;
    for (final d in turn) {
      if (cancel.isCancelled) throw const AgentCancelled();
      yield d;
    }
  }
}

class _SlowTool implements AgentTool, ParallelSafeTool {
  _SlowTool(this.name, {this.safe = true});

  final String name;
  final bool safe;
  int calls = 0;

  static const delay = Duration(milliseconds: 120);

  @override
  ToolSpec get spec => ToolSpec(
        name: name,
        description: 'slow $name',
        parameters: const {'type': 'object', 'properties': {}},
      );

  @override
  bool get parallelSafe => safe;

  @override
  Future<ToolResult> run(Map<String, Object?> args, ToolContext ctx) async {
    calls++;
    await Future<void>.delayed(delay);
    return ToolResult.ok('$name ok');
  }
}

LlmDelta _calls(String name, int count) => LlmDelta(
      toolCalls: [
        for (var i = 0; i < count; i++)
          LlmToolCall(id: '$name-$i', name: name, arguments: {'q': '$name-$i'}),
      ],
    );

Future<(List<AgentEvent>, int)> _runAndTime(
  LlmConnector connector,
  List<AgentTool> tools,
) async {
  final runner = AgentRunner(connector: connector, tools: ToolRegistry(tools));
  final started = DateTime.now();
  final events = await runner
      .run(history: const [], cancel: AgentCancelToken(), sessionId: 's')
      .toList();
  return (events, DateTime.now().difference(started).inMilliseconds);
}

void main() {
  const delayMs = 120;

  test('一轮 5 个搜索并发跑, 总耗时 ≈ 单次 (不是串行相加)', () async {
    final search = _SlowTool('web_search');
    final connector = _ScriptedConnector([
      [_calls('web_search', 5)],
      [const LlmDelta(text: '搜完了')],
    ]);

    final (events, elapsed) = await _runAndTime(connector, [search]);

    expect(search.calls, 5);
    /* 串行会是 5 × 120 = 600ms; 并发只要 ~120ms */
    expect(elapsed, lessThan(delayMs * 3),
        reason: '5 个搜索应该同时跑, 实测 ${elapsed}ms');

    /* 事件按 tool_calls 顺序回灌 —— 界面卡片顺序跟模型发的一致 */
    final results = events.where((e) => e.kind == 'tool_result').toList();
    expect(results.map((e) => e.payload['tool_call_id']),
        ['web_search-0', 'web_search-1', 'web_search-2', 'web_search-3', 'web_search-4']);
    expect(results.every((e) => e.payload['ok'] == true), isTrue);
  });

  test('一轮 3 张图并发画, 总耗时 ≈ 单次', () async {
    final image = _SlowTool('generate_image');
    final connector = _ScriptedConnector([
      [_calls('generate_image', 3)],
      [const LlmDelta(text: '画好了')],
    ]);

    final (events, elapsed) = await _runAndTime(connector, [image]);

    expect(image.calls, 3);
    expect(elapsed, lessThan(delayMs * 2.5), reason: '3 张图应该同时画, 实测 ${elapsed}ms');
    expect(events.where((e) => e.kind == 'tool_result').length, 3);
  });

  test('搜索 + 画图混在同一轮: 两件也并发', () async {
    final search = _SlowTool('web_search');
    final image = _SlowTool('generate_image');
    final connector = _ScriptedConnector([
      [
        LlmDelta(toolCalls: const [
          LlmToolCall(id: 's0', name: 'web_search', arguments: {'q': 'a'}),
          LlmToolCall(id: 'i0', name: 'generate_image', arguments: {'prompt': '猫'}),
        ]),
      ],
      [const LlmDelta(text: '好了')],
    ]);

    final (_, elapsed) = await _runAndTime(connector, [search, image]);

    expect(search.calls, 1);
    expect(image.calls, 1);
    expect(elapsed, lessThan(delayMs * 1.9), reason: '实测 ${elapsed}ms');
  });

  test('没声明 parallelSafe 的工具仍逐个串行 (写盘 / 跑命令行为不变)', () async {
    final tool = _SlowTool('execute_shell', safe: false);
    final connector = _ScriptedConnector([
      [_calls('execute_shell', 3)],
      [const LlmDelta(text: '跑完了')],
    ]);

    final (_, elapsed) = await _runAndTime(connector, [tool]);

    expect(tool.calls, 3);
    expect(elapsed, greaterThanOrEqualTo(delayMs * 3 - 30),
        reason: '串行应该是 3 × 120ms, 实测 ${elapsed}ms');
  });

  test('同批里一个工具失败不拖垮兄弟调用', () async {
    final ok = _SlowTool('web_search');
    final bad = _FailingTool();
    final connector = _ScriptedConnector([
      [
        LlmDelta(toolCalls: const [
          LlmToolCall(id: 'b0', name: 'generate_image', arguments: {'prompt': '猫'}),
          LlmToolCall(id: 's0', name: 'web_search', arguments: {'q': 'a'}),
        ]),
      ],
      [const LlmDelta(text: '继续')],
    ]);

    final runner = AgentRunner(
      connector: connector,
      tools: ToolRegistry([bad, ok]),
    );
    final events = await runner
        .run(history: const [], cancel: AgentCancelToken(), sessionId: 's')
        .toList();

    final results = events.where((e) => e.kind == 'tool_result').toList();
    expect(results, hasLength(2));
    expect(results.first.payload['ok'], false, reason: '出图失败如实回报');
    expect(results.last.payload['ok'], true, reason: '同批的搜索照常返回');
    expect(ok.calls, 1);
  });
}

class _FailingTool implements AgentTool, ParallelSafeTool {
  @override
  ToolSpec get spec => const ToolSpec(
        name: 'generate_image',
        description: 'fails',
        parameters: {'type': 'object', 'properties': {}},
      );

  @override
  bool get parallelSafe => true;

  @override
  Future<ToolResult> run(Map<String, Object?> args, ToolContext ctx) async {
    throw StateError('boom');
  }
}
