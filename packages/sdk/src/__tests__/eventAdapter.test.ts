/**
 * eventAdapter 回归测试
 *
 * 这两个 bug 单测发现不了 —— 只有拿真模型跑一次、盯着事件流才看得见。
 * 事件形状取自 DeepSeek v4-pro 的真实 kernel 事件流(onRawEvent 抓的):
 *
 *   tool_call_delta { id, name, arguments_delta }   ← 参数在这里流式来
 *   tool_call_start { id, name }                    ← 只有 id/name, 没有参数
 *   tool_call_done  { id, name, arguments, success }
 *   token_usage     { usage: { prompt_tokens, completion_tokens, ... }, is_final }
 *
 * 修复前的表现:
 *   · tool_call 事件的 input 永远是 {} (只认 evt.arguments, 而 start 根本没有)
 *   · AgentResult.usage 永远是 0 (只读 camelCase, kernel 发的是 snake_case)
 */

import { describe, expect, it } from 'vitest';
import { createTranslatorState, translateEvent } from '../core/eventAdapter.js';
import type { AgentEvent } from '../types.js';

/** 把一串 kernel 事件喂进翻译器, 收集吐出来的 SDK 事件 */
function run(events: any[]) {
  const state = createTranslatorState();
  const out: AgentEvent[] = [];
  for (const e of events) out.push(...translateEvent(e, state));
  return { out, state };
}

const streamArgs = (id: string, name: string, json: string) =>
  [...json].map((ch) => ({ type: 'tool_call_delta', id, name, arguments_delta: ch }));

describe('tool_call 事件的 input', () => {
  it('参数从 tool_call_delta 累积而来 —— start 只带 id/name 也要能填上', () => {
    const id = 'call_1';
    const { out } = run([
      ...streamArgs(id, 'edit_file', '{"path":"a.ts","find":"x","replace":"y"}'),
      { type: 'tool_call_start', id, name: 'edit_file' },
    ]);
    const call = out.find((e) => e.type === 'tool_call') as any;
    expect(call).toBeDefined();
    expect(call.input).toEqual({ path: 'a.ts', find: 'x', replace: 'y' });
    expect(call.id).toBe(id);
  });

  it('参数在 start 时还没流完 —— 由 tool_call_done 补发, 且只发一次', () => {
    const id = 'call_2';
    const { out } = run([
      { type: 'tool_call_start', id, name: 'read_file' },
      {
        type: 'tool_call_done',
        id,
        name: 'read_file',
        arguments: '{"path":"b.ts"}',
        success: true,
        output: 'ok',
      },
    ]);
    const calls = out.filter((e) => e.type === 'tool_call') as any[];
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({ path: 'b.ts' });
    /* 补发的 tool_call 必须排在 tool_result 前面, 顺序不能倒 */
    expect(out.map((e) => e.type)).toEqual(['tool_call', 'tool_result']);
  });

  it('start 已发过就不再补发 —— 不产生重复事件', () => {
    const id = 'call_3';
    const { out } = run([
      ...streamArgs(id, 'echo', '{"text":"hi"}'),
      { type: 'tool_call_start', id, name: 'echo' },
      { type: 'tool_call_done', id, name: 'echo', arguments: '{"text":"hi"}', success: true, output: 'hi' },
    ]);
    expect(out.filter((e) => e.type === 'tool_call')).toHaveLength(1);
  });

  it('工具失败时走 tool_error, 同样带上补发的 tool_call', () => {
    const id = 'call_4';
    const { out } = run([
      { type: 'tool_call_start', id, name: 'write_file' },
      { type: 'tool_call_done', id, name: 'write_file', arguments: '{"path":"c"}', success: false, output: 'boom' },
    ]);
    expect(out.map((e) => e.type)).toEqual(['tool_call', 'tool_error']);
  });
});

describe('token usage', () => {
  it('读 kernel 的 snake_case 字段 (此前只认 camelCase, 所以恒为 0)', () => {
    const { state } = run([
      {
        type: 'token_usage',
        is_final: true,
        usage: { prompt_tokens: 536, completion_tokens: 66, total_tokens: 602 },
      },
    ]);
    expect(state.usage.inputTokens).toBe(536);
    expect(state.usage.outputTokens).toBe(66);
  });

  it('多步 run 的多条 is_final 要累加, 不是覆盖', () => {
    const { state } = run([
      { type: 'token_usage', is_final: true, usage: { prompt_tokens: 100, completion_tokens: 10 } },
      { type: 'token_usage', is_final: true, usage: { prompt_tokens: 200, completion_tokens: 20 } },
    ]);
    expect(state.usage.inputTokens).toBe(300);
    expect(state.usage.outputTokens).toBe(30);
  });

  it('增量快照 (is_final:false) 不计入, 避免重复累加', () => {
    const { state } = run([
      { type: 'token_usage', is_final: false, usage: { prompt_tokens: 50, completion_tokens: 5 } },
      { type: 'token_usage', is_final: true, usage: { prompt_tokens: 100, completion_tokens: 10 } },
    ]);
    expect(state.usage.inputTokens).toBe(100);
    expect(state.usage.outputTokens).toBe(10);
  });

  it('缓存读写也统计 (DeepSeek 走 prompt_cache_hit/miss)', () => {
    const { state } = run([
      {
        type: 'token_usage',
        is_final: true,
        usage: {
          prompt_tokens: 622,
          completion_tokens: 26,
          prompt_cache_hit_tokens: 512,
          prompt_cache_miss_tokens: 110,
        },
      },
    ]);
    expect(state.usage.cacheReadTokens).toBe(512);
    expect(state.usage.cacheWriteTokens).toBe(110);
  });

  it('camelCase 来源仍然认 (别的 provider 路径)', () => {
    const { state } = run([
      { type: 'token_usage', is_final: true, usage: { promptTokens: 7, completionTokens: 3 } },
    ]);
    expect(state.usage.inputTokens).toBe(7);
    expect(state.usage.outputTokens).toBe(3);
  });

  it('done 事件带出累计后的 usage', () => {
    const { out } = run([
      { type: 'token_usage', is_final: true, usage: { prompt_tokens: 11, completion_tokens: 2 } },
      { type: 'run_done' },
    ]);
    const done = out.find((e) => e.type === 'done') as any;
    expect(done.usage.inputTokens).toBe(11);
    expect(done.stopReason).toBe('end_turn');
  });
});
