/// agent_runner.dart — 工具调用主循环 (ReAct loop).
///
/// 流程 (每次 run):
///   1. messages = system + 宿主给的对话历史
///   2. 调 LlmConnector.stream (带 tool specs)
///   3. 模型输出文本 → 转发 agent_text_delta
///      模型 emit tool_calls → 逐个执行 (tool_running → run → tool_done/tool_result)
///      工具结果回灌 messages, 回到 2
///   4. 模型不再调工具 → agent_text (完整文本) + agent_turn_done, 结束
///
/// 边界:
///   - 默认不设轮数上限 (做完为止, 停靠 cancel); 调用方显式给了 maxTurns 才会到顶:
///     注入"请直接总结"的 system 提示再跑最后一轮 (不带工具)
///   - 取消: 任何阶段掐断, 发 session_interrupted
///   - LLM/工具异常: agent_error + session_interrupted, 不吞栈
library;

import 'dart:convert';
import 'dart:math';

import 'dsml_tool_calls.dart';
import 'types.dart';
import 'tool_registry.dart';

class AgentRunner {
  AgentRunner({
    required this.connector,
    required this.tools,
    this.config = const AgentRunConfig(),
  });

  final LlmConnector connector;
  final ToolRegistry tools;
  final AgentRunConfig config;

  static const String _defaultSystemPrompt =
      '你是 Neox 手机 Agent。你运行在用户的手机上, 可以调用给定的工具完成任务 '
      '(联网获取网页、读写应用内文件、算术、时间等)。'
      '规则: 1) 需要外部信息或副作用时果断用工具, 不要凭空编造; '
      '2) 工具返回错误时, 修正参数重试或换思路, 不要原样重复; '
      '3) 任务完成后用用户的语言给出简洁、直接的最终回答; '
      '4) 绝不要在正文里输出工具调用标签或 XML。';

  /// 跑一次任务. [history] 是 OpenAI shape 的既有对话 (不含 system).
  /// 返回事件流 — 宿主订阅后灌 timeline / 落库.
  Stream<AgentEvent> run({
    required List<ChatMessage> history,
    required AgentCancelToken cancel,
    String? sessionId,
  }) async* {
    final env = config.environmentContext;
    final systemContent = (config.systemPrompt ?? _defaultSystemPrompt) +
        (env != null && env.isNotEmpty ? '\n\n<environment>\n$env\n</environment>' : '');
    final messages = <ChatMessage>[
      {'role': 'system', 'content': systemContent},
      ...history,
    ];
    final specs = tools.specs;
    final finalText = StringBuffer();
    /* 断网耐心 —— 连续失败从何时开始 / 第几次重试; 一轮接上就清零 */
    DateTime? failingSince;
    var outageAttempt = 0;
    /* 连续把工具调用写成残缺 DSML 的次数 (跟桌面 kernel 同一口径), 一轮正常就清零 */
    var dsmlRetries = 0;

    try {
      final cap = config.maxTurns;
      for (var turn = 0; cap == null || turn < cap; turn++) {
        cancel.throwIfCancelled();

        final isLastTurn = cap != null && turn == cap - 1;
        if (isLastTurn) {
          messages.add({
            'role': 'system',
            'content': '已达到最大工具调用轮数。请基于目前所有信息直接给出最终回答, 不要再调用工具。',
          });
        }

        final turnText = StringBuffer();
        List<LlmToolCall>? pendingCalls;
        /* 已经显示出去的长度 —— DSML 文本调用 (见 dsml_tool_calls.dart) 从它开始的地方起就不显示 */
        var shown = 0;
        String emit(int upto) {
          final s = turnText.toString();
          if (upto <= shown) return '';
          /* 隔着工具的两段正文落库时是一整段 —— 不断开的话上一句和下一段的标题粘在一起
           * (「aren't stale.# 3 Days in Tokyo」, markdown 标题也就不成立了) */
          if (shown == 0 && finalText.isNotEmpty && !finalText.toString().endsWith('\n')) {
            finalText.write('\n\n');
          }
          final piece = s.substring(shown, upto);
          shown = upto;
          finalText.write(piece);
          return piece;
        }

        final finalLenAtTurnStart = finalText.length;
        while (true) {
          try {
            await for (final delta in connector.stream(
              messages: messages,
              tools: isLastTurn ? const [] : specs,
              cancel: cancel,
            )) {
              cancel.throwIfCancelled();
              if (outageAttempt > 0) {
                /* 重试的这一发接上了 —— 收起「重试中」 */
                outageAttempt = 0;
                failingSince = null;
                yield const AgentEvent('stream_recovered', {});
              }
              final t = delta.text;
              if (t != null && t.isNotEmpty) {
                turnText.write(t);
                final s = turnText.toString();
                final dsml = dsmlStart(s);
                final partial = dsml >= 0 ? -1 : dsmlPartialTailStart(s);
                final piece = emit(dsml >= 0 ? dsml : (partial >= 0 ? partial : s.length));
                if (piece.isNotEmpty) yield AgentEvent('agent_text_delta', {'content': piece});
              }
              final think = delta.thinking;
              if (think != null && think.isNotEmpty) {
                yield AgentEvent('agent_thinking_delta', {'content': think});
              }
              if (delta.toolCalls != null && delta.toolCalls!.isNotEmpty) {
                pendingCalls = delta.toolCalls;
              }
            }
            break;
          } on AgentCancelled {
            rethrow;
          } catch (e) {
            /* 断网耐心: 临时性错误不终止整个任务, 退避后重发这一轮; 连续失败满 outagePatience 才放弃 */
            final transient = config.isTransientError?.call(e) ?? false;
            if (!transient || cancel.isCancelled) rethrow;
            final now = DateTime.now();
            failingSince ??= now;
            if (now.difference(failingSince) >= config.outagePatience) rethrow;
            outageAttempt++;
            final wait = _outageBackoff(outageAttempt);
            /* 这一轮已显示出去的半截作废 (重发会从头生成), 宿主按 discard 从正在拼的那段里删掉 */
            final discard = turnText.toString().substring(0, shown);
            final kept = finalText.toString().substring(0, finalLenAtTurnStart);
            finalText
              ..clear()
              ..write(kept);
            turnText.clear();
            shown = 0;
            pendingCalls = null;
            yield AgentEvent('stream_retry', {
              'attempt': outageAttempt,
              /* 给 attempt+1: UI 把 attempt>=max 当最后一次, 这里永远不是最后一次 */
              'max_retries': outageAttempt + 1,
              'delay_ms': wait.inMilliseconds,
              'is_network_error': true,
              'error': '$e',
              if (discard.isNotEmpty) 'discard': discard,
            });
            await Future.any<void>([
              Future<void>.delayed(wait),
              cancel.onCancel.first.catchError((_) {}),
            ]);
            cancel.throwIfCancelled();
          }
        }

        /* DSML 文本调用: 没走原生 tool_calls, 把调用当正文吐了 —— 翻回结构化调用接着跑 */
        final raw = turnText.toString();
        if ((pendingCalls == null || pendingCalls.isEmpty) && dsmlStart(raw) >= 0) {
          final parsed = parseDsmlToolCalls(raw);
          turnText
            ..clear()
            ..write(parsed.text);
          if (parsed.calls.isNotEmpty) {
            dsmlRetries = 0;
            pendingCalls = [
              for (var i = 0; i < parsed.calls.length; i++)
                LlmToolCall(id: 'dsml_${turn}_$i', name: parsed.calls[i].name, arguments: parsed.calls[i].arguments),
            ];
          } else if (!isLastTurn && dsmlRetries < 2) {
            /* 残缺的不执行; 从展示文本里去掉残片, 让模型用标准 function calling 重来 (最多 2 次) */
            dsmlRetries++;
            if (parsed.text.isNotEmpty) messages.add({'role': 'assistant', 'content': parsed.text});
            messages.add({
              'role': 'user',
              'content': '(系统: 你上一条回复里的工具调用格式不完整, 没有执行。'
                  '请用正常的函数调用重新发起; 如果不需要调用工具, 直接给出回答。)',
            });
            continue;
          } else {
            /* 连续 2 次仍残缺 (或已到最后一轮) → 如实结束, 不把残片当最终回答 */
            yield AgentEvent('agent_error', {
              'message': '模型连续 2 次把工具调用写成了不完整的文本格式 (DSML), 没有执行。可以重试, 或换一个模型。',
            });
          }
        } else {
          /* 结尾先压着的那一截不是 DSML —— 补显示出来 */
          dsmlRetries = 0;
          final piece = emit(raw.length);
          if (piece.isNotEmpty) yield AgentEvent('agent_text_delta', {'content': piece});
        }

        /* 没有工具调用 → 本轮就是最终回答 */
        if (pendingCalls == null || pendingCalls.isEmpty) {
          break;
        }

        /* assistant 消息 (带 tool_calls) 记入历史 — OpenAI 协议要求 */
        messages.add({
          'role': 'assistant',
          if (turnText.isNotEmpty) 'content': turnText.toString(),
          'tool_calls': [
            for (final c in pendingCalls)
              {
                'id': c.id,
                'type': 'function',
                'function': {
                  'name': c.name,
                  'arguments': jsonEncode(c.arguments),
                },
              },
          ],
        });

        /* 同一轮的多个工具调用: 互不依赖的**并发**跑 (总控裁决第六节)。
         *
         * 连续的一段 parallelSafe 调用 (多个搜索 / 多张图 / 多个抓网页) 一次发出去、
         * 同时跑 —— 5 个搜索的总耗时约等于 1 个, 而不是 5 个相加。
         * 其余工具 (写盘 / 跑命令 / 动手机) 没声明 parallelSafe, 仍逐个串行, 行为不变。
         * 事件按 tool_calls 顺序发, 界面上的卡片顺序跟模型发的一致; 结果也按顺序回灌。 */
        var callIndex = 0;
        while (callIndex < pendingCalls.length) {
          if (!_isParallelSafe(tools, pendingCalls[callIndex].name)) {
            final call = pendingCalls[callIndex];
            cancel.throwIfCancelled();
            yield _toolRunningEvent(call);
            final result = await _runTool(call, tools, specs, cancel, sessionId);
            yield* _toolFinishedEvents(call, result, messages);
            callIndex++;
            continue;
          }
          var end = callIndex;
          while (end < pendingCalls.length && _isParallelSafe(tools, pendingCalls[end].name)) {
            end++;
          }
          final group = pendingCalls.sublist(callIndex, end);
          for (final call in group) {
            cancel.throwIfCancelled();
            yield _toolRunningEvent(call);
          }
          final futures = [
            for (final call in group) _runTool(call, tools, specs, cancel, sessionId),
          ];
          for (var k = 0; k < group.length; k++) {
            yield* _toolFinishedEvents(group[k], await futures[k], messages);
          }
          callIndex = end;
        }
        /* 工具结果已回灌 → 下一轮 */
      }

      if (finalText.isNotEmpty) {
        yield AgentEvent('agent_text', {'text': finalText.toString()});
      }
      yield const AgentEvent('agent_turn_done', {});
    } on AgentCancelled {
      if (finalText.isNotEmpty) {
        yield AgentEvent('agent_text', {'text': finalText.toString()});
      }
      yield const AgentEvent('session_interrupted', {});
    } catch (e) {
      yield AgentEvent('agent_error', {'message': '$e'});
      if (finalText.isNotEmpty) {
        yield AgentEvent('agent_text', {'text': finalText.toString()});
      }
      yield const AgentEvent('session_interrupted', {});
    }
  }

  static const _outageSteps = [5, 10, 20, 40, 60];

  /// 这个工具能不能跟同一轮里别的调用并发跑 (见 [ParallelSafeTool])。
  bool _isParallelSafe(ToolRegistry tools, String name) {
    final tool = tools.find(name);
    if (tool is! ParallelSafeTool) return false;
    return (tool as ParallelSafeTool).parallelSafe;
  }

  AgentEvent _toolRunningEvent(LlmToolCall call) => AgentEvent('tool_running', {
        'tool_call_id': call.id,
        'tool_name': call.name,
        'args': call.arguments,
      });

  /// 跑一个工具 —— 异常就地变成错误结果, 不拖垮同批的兄弟调用。
  Future<ToolResult> _runTool(
    LlmToolCall call,
    ToolRegistry tools,
    List<ToolSpec> specs,
    AgentCancelToken cancel,
    String? sessionId,
  ) async {
    final tool = tools.find(call.name);
    if (tool == null) {
      return ToolResult.error(
        '工具 "${call.name}" 不存在。可用工具: ${specs.map((s) => s.name).join(', ')}',
      );
    }
    try {
      return await tool.run(
        call.arguments,
        ToolContext(cancel: cancel, sessionId: sessionId),
      );
    } on AgentCancelled {
      rethrow;
    } catch (e) {
      return ToolResult.error('工具执行异常: $e');
    }
  }

  /// tool_done + tool_result + 回灌 messages —— 三件一起做, 顺序跟原来的逐个执行一致。
  Stream<AgentEvent> _toolFinishedEvents(
    LlmToolCall call,
    ToolResult result,
    List<ChatMessage> messages,
  ) async* {
    final clipped = _clipOutput(result.output);
    yield AgentEvent('tool_done', {
      'tool_call_id': call.id,
      'ok': !result.isError,
    });
    yield AgentEvent('tool_result', {
      'tool_call_id': call.id,
      'tool_name': call.name,
      'output': clipped,
      'ok': !result.isError,
    });

    messages.add({
      'role': 'tool',
      'tool_call_id': call.id,
      'content': result.isError ? 'ERROR: $clipped' : clipped,
    });
  }

  /// 第 n 次断网重试前等多久: 5s → 60s 封顶, ±15% 抖动 (多台设备别同一秒一起重发)
  Duration _outageBackoff(int attempt) {
    final s = _outageSteps[(attempt - 1).clamp(0, _outageSteps.length - 1)];
    final jitter = 0.85 + Random().nextDouble() * 0.3;
    return Duration(microseconds: (config.outageBackoffUnit.inMicroseconds * s * jitter).round());
  }

  /// 截断超长工具输出 — 保头 2/3 尾 1/3, 中间放截断标记.
  String _clipOutput(String s) {
    final max = config.maxToolOutputChars;
    if (s.length <= max) return s;
    final head = (max * 2 / 3).floor();
    final tail = max - head;
    return '${s.substring(0, head)}\n…[输出过长, 中间 ${s.length - max} 字符已截断]…\n${s.substring(s.length - tail)}';
  }
}
