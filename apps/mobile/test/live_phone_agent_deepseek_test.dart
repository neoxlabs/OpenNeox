/// live_phone_agent_deepseek_test.dart — 手机本地 Agent 打真实 DeepSeek 端点的活测.
///
/// 这不是单元测试 —— 它真的发网络请求、真的烧 token。默认**跳过**, 只有显式提供
/// key 时才跑:
///
///   NEOX_TEST_LLM_KEY=sk-xxx \
///   env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
///   flutter test test/live_phone_agent_deepseek_test.dart
///
/// 可选覆盖: NEOX_TEST_LLM_BASE (默认 https://api.deepseek.com)
///          NEOX_TEST_LLM_MODEL (默认 deepseek-v4-pro)
///
/// 为什么值得单独存在:
///   agentsdk 自己的测试全部用假 connector, 验的是"循环逻辑对不对"。但手机本地 Agent
///   真正容易翻车的地方在**真实厂商的流式 wire 形状**: tool_calls 分片怎么拼、
///   arguments 跨 chunk 断在哪、finish_reason 什么时候来、usage 帧混在流里。
///   这些只有打真端点才测得出来。
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;

import 'package:neox_app/core/llm/llm_http.dart';
import 'package:neox_app/core/local_agent/openai_tool_connector.dart';

void main() {
  final key = Platform.environment['NEOX_TEST_LLM_KEY'] ?? '';
  final base =
      Platform.environment['NEOX_TEST_LLM_BASE'] ?? 'https://api.deepseek.com';
  final model =
      Platform.environment['NEOX_TEST_LLM_MODEL'] ?? 'deepseek-v4-pro';

  setUpAll(() {
    /* flutter_test 默认装了一个把所有 HTTP 打成 400 的 HttpOverrides —
     * 活测必须摘掉, 否则请求根本出不去。 */
    HttpOverrides.global = null;
  });

  sdk.AgentRunner buildRunner({int maxTurns = 6}) {
    final connector = OpenAiToolConnector(
      http: LlmHttp(http.Client()),
      providerName: 'DeepSeek',
      endpoint: () async => (
        url: '$base/chat/completions',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $key',
        },
        model: model,
      ),
    );
    final tools = sdk.ToolRegistry()
      ..register(sdk.CalculatorTool())
      ..register(sdk.ClockTool());
    return sdk.AgentRunner(
      connector: connector,
      tools: tools,
      config: sdk.AgentRunConfig(maxTurns: maxTurns),
    );
  }

  Future<List<sdk.AgentEvent>> drain(Stream<sdk.AgentEvent> s) =>
      s.toList().timeout(const Duration(seconds: 120));

  group('手机本地 Agent × DeepSeek 真端点', skip: key.isEmpty ? '未提供 NEOX_TEST_LLM_KEY' : null, () {
    test('必须调工具才能答对的题 — 完整 ReAct 闭环', () async {
      final events = await drain(
        buildRunner().run(
          history: [
            {
              'role': 'user',
              'content': '用 calculator 工具计算 (17*23+41)/2, 最后一行只写这个数字, 不要解释。',
            },
          ],
          cancel: sdk.AgentCancelToken(),
        ),
      );

      final kinds = events.map((e) => e.kind).toList();
      // ignore: avoid_print
      print('事件序列: ${kinds.join(' → ')}');

      /* 1) 工具真的被调了 */
      final running = events.where((e) => e.kind == 'tool_running').toList();
      expect(running, isNotEmpty, reason: '模型应当调用 calculator');
      expect(running.first.payload['tool_name'], 'calculator');

      /* 2) 工具算对了 — (17*23+41)/2 = 216 */
      final results = events.where((e) => e.kind == 'tool_result').toList();
      expect(results, isNotEmpty);
      expect(results.first.payload['ok'], isTrue,
          reason: '工具执行失败: ${results.first.payload['output']}');
      expect('${results.first.payload['output']}', contains('216'));

      /* 3) 循环正常收尾, 且最终答案带上了工具结果 */
      expect(kinds.last, 'agent_turn_done');
      final finalText = events.lastWhere((e) => e.kind == 'agent_text').payload['text'];
      expect('$finalText', contains('216'));
    }, timeout: const Timeout(Duration(seconds: 150)));

    test('多轮工具: 先取时间再算术 — 验证结果回灌后能继续调工具', () async {
      final events = await drain(
        buildRunner().run(
          history: [
            {
              'role': 'user',
              'content': '先用 clock 工具拿当前时间, 然后用 calculator 算 365*24, '
                  '最后一行输出这两个信息。必须用工具, 不许自己算。',
            },
          ],
          cancel: sdk.AgentCancelToken(),
        ),
      );

      final called = events
          .where((e) => e.kind == 'tool_running')
          .map((e) => e.payload['tool_name'])
          .toSet();
      // ignore: avoid_print
      print('调用到的工具: $called');

      expect(called, containsAll(<String>{'clock', 'calculator'}),
          reason: '两个工具都应被调用 (工具结果回灌后模型要能发起第二次调用)');
      expect(events.map((e) => e.kind).last, 'agent_turn_done');

      final finalText =
          '${events.lastWhere((e) => e.kind == 'agent_text').payload['text']}';
      expect(finalText, contains('8760')); // 365*24
    }, timeout: const Timeout(Duration(seconds: 180)));

    test('取消: 跑起来后立刻掐断 → session_interrupted 收尾', () async {
      final cancel = sdk.AgentCancelToken();
      final stream = buildRunner().run(
        history: [
          {'role': 'user', 'content': '用 calculator 算 999*999, 然后详细解释一万字。'},
        ],
        cancel: cancel,
      );

      final got = <sdk.AgentEvent>[];
      final done = Completer<void>();
      final sub = stream.listen(got.add, onDone: done.complete);
      await Future<void>.delayed(const Duration(milliseconds: 1500));
      cancel.cancel();
      await done.future.timeout(const Duration(seconds: 30));
      await sub.cancel();

      expect(got.map((e) => e.kind), contains('session_interrupted'));
      expect(got.map((e) => e.kind), isNot(contains('agent_turn_done')));
    }, timeout: const Timeout(Duration(seconds: 90)));

    test('流式文本增量真的是增量 (不是一次性整包)', () async {
      final events = await drain(
        buildRunner().run(
          history: [
            {'role': 'user', 'content': '用两三句话介绍杭州, 不要调用任何工具。'},
          ],
          cancel: sdk.AgentCancelToken(),
        ),
      );

      final deltas =
          events.where((e) => e.kind == 'agent_text_delta').toList();
      // ignore: avoid_print
      print('文本增量分片数: ${deltas.length}');
      expect(deltas.length, greaterThan(3),
          reason: '流式应产生多个分片; 只有 1 片说明 SSE 聚合退化成了整包');
      expect(events.map((e) => e.kind).last, 'agent_turn_done');
    }, timeout: const Timeout(Duration(seconds: 120)));
  });
}
