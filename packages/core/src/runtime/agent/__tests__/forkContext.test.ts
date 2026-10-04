import { describe, expect, it } from 'vitest';
import type { Message } from '@neoxlabs/kernel/types/index.js';
import { buildForkMessages, buildForkPrompt } from '../forkContext.js';

const call = (id: string, name = 'readfile') => ({ id, type: 'function' as const, function: { name, arguments: '{}' } });

describe('buildForkMessages', () => {
  it('系统消息原样保留; 正在派 fork 的那条助手消息 (工具调用还没结果) 连同之后的截掉', () => {
    const parent: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '看下 a.ts' },
      { role: 'assistant', content: '', tool_calls: [call('t1')] },
      { role: 'tool', tool_call_id: 't1', content: 'a.ts 内容' },
      { role: 'assistant', content: '我分出去查 b', tool_calls: [call('t2', 'agent'), call('t3')] },
      { role: 'tool', tool_call_id: 't3', content: '同批另一个已经回了' },
    ];
    const out = buildForkMessages(parent);
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(out[3].content).toBe('a.ts 内容');
  });

  it('尾巴上的工具调用都有结果 → 整段保留', () => {
    const parent: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [call('t1')] },
      { role: 'tool', tool_call_id: 't1', content: 'ok' },
      { role: 'assistant', content: 'done' },
    ];
    expect(buildForkMessages(parent)).toHaveLength(4);
  });

  it('任务消息带 fork 说明 + 原任务', () => {
    const p = buildForkPrompt('fix the flaky test');
    expect(p).toMatch(/forked worker, not the main conversation/);
    expect(p.endsWith('fix the flaky test')).toBe(true);
  });
});
