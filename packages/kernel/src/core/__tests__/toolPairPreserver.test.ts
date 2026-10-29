import { describe, it, expect } from 'vitest';
import { widenKeepStartForPairedBlocks, validateToolPairIntegrity } from '../toolPairPreserver.js';
import type { Message } from '../../types/index.js';

const assistantCall = (ids: string[], extra: Record<string, any> = {}): Message => ({
  role: 'assistant',
  content: '',
  tool_calls: ids.map(id => ({ id, type: 'function', function: { name: 'readfile', arguments: '{}' } })),
  ...extra,
} as Message);

const toolResult = (id: string): Message => ({ role: 'tool', content: 'ok', tool_call_id: id } as Message);

const anthropicUse = (id: string, extra: Record<string, any> = {}): Message => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'readfile', input: {} }],
  ...extra,
} as any);

const anthropicResult = (id: string): Message => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
} as any);

describe('widenKeepStartForPairedBlocks — 边界', () => {
  it('start <= 0 返回 0', () => {
    expect(widenKeepStartForPairedBlocks([toolResult('t1')], 0)).toBe(0);
    expect(widenKeepStartForPairedBlocks([toolResult('t1')], -3)).toBe(0);
  });

  it('start >= 长度返回长度', () => {
    const msgs = [toolResult('t1')];
    expect(widenKeepStartForPairedBlocks(msgs, 1)).toBe(1);
    expect(widenKeepStartForPairedBlocks(msgs, 9)).toBe(1);
  });

  it('空数组返回 0', () => {
    expect(widenKeepStartForPairedBlocks([], 0)).toBe(0);
    expect(widenKeepStartForPairedBlocks([], 2)).toBe(0);
  });
});

describe('widenKeepStartForPairedBlocks — OpenAI tool pair', () => {
  it('孤儿 tool_result 把边界拉回到对应 assistant', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'start' },
      assistantCall(['t1']),
      toolResult('t1'),
      { role: 'user', content: 'next' },
    ];
    expect(widenKeepStartForPairedBlocks(msgs, 2)).toBe(1);
  });

  it('配对已在保留范围内时不调整', () => {
    const msgs: Message[] = [{ role: 'user', content: 'u' }, assistantCall(['t1']), toolResult('t1')];
    expect(widenKeepStartForPairedBlocks(msgs, 1)).toBe(1);
  });

  it('多个 result 指向同一条 assistant 时一次拉回', () => {
    const msgs: Message[] = [assistantCall(['t1', 't2']), toolResult('t1'), toolResult('t2'), { role: 'user', content: 'x' }];
    expect(widenKeepStartForPairedBlocks(msgs, 2)).toBe(0);
  });

  it('找不到 use 的 result 不改变边界', () => {
    const msgs: Message[] = [{ role: 'user', content: 'x' }, toolResult('missing'), { role: 'user', content: 'y' }];
    expect(widenKeepStartForPairedBlocks(msgs, 1)).toBe(1);
  });

  it('两张工具调用的链式回溯取最早的那条', () => {
    const msgs: Message[] = [
      assistantCall(['t1']),
      toolResult('t1'),
      assistantCall(['t2']),
      toolResult('t2'),
      { role: 'user', content: 'x' },
    ];
    expect(widenKeepStartForPairedBlocks(msgs, 3)).toBe(2);
  });
});

describe('widenKeepStartForPairedBlocks — Anthropic 格式', () => {
  it('content 里的 tool_result 同样拉回 tool_use', () => {
    const msgs: Message[] = [anthropicUse('u1'), anthropicResult('u1'), { role: 'user', content: 'x' }];
    expect(widenKeepStartForPairedBlocks(msgs, 1)).toBe(0);
  });

  it('assistant content 里的 tool_use 能被识别', () => {
    const msgs: Message[] = [{ role: 'user', content: 'x' }, anthropicUse('u1'), anthropicResult('u1')];
    expect(widenKeepStartForPairedBlocks(msgs, 2)).toBe(1);
  });
});

describe('widenKeepStartForPairedBlocks — thinking block 同 ID 保全', () => {
  it('保留范围内 assistant 的同一 message id 会被拉回', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'thinking...', id: 'resp-1' } as any,
      { role: 'assistant', content: 'answer', id: 'resp-1' } as any,
      { role: 'user', content: 'y' },
    ];
    expect(widenKeepStartForPairedBlocks(msgs, 2)).toBe(1);
  });

  it('message_id 字段也支持', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: 'a', message_id: 'm1' } as any,
      { role: 'assistant', content: 'b', message_id: 'm1' } as any,
    ];
    expect(widenKeepStartForPairedBlocks(msgs, 1)).toBe(0);
  });

  it('不同 message id 不拉回', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: 'a', id: 'r1' } as any,
      { role: 'assistant', content: 'b', id: 'r2' } as any,
      { role: 'user', content: 'x' },
    ];
    expect(widenKeepStartForPairedBlocks(msgs, 1)).toBe(1);
  });
});

describe('validateToolPairIntegrity', () => {
  it('配对完整时返回空数组', () => {
    expect(validateToolPairIntegrity([assistantCall(['t1']), toolResult('t1')])).toEqual([]);
  });

  it('孤儿 result 报错', () => {
    const issues = validateToolPairIntegrity([toolResult('t1')]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('Orphaned tool_result: t1');
  });

  it('孤儿 use 报错', () => {
    const issues = validateToolPairIntegrity([assistantCall(['t1'])]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('Orphaned tool_use: t1');
  });

  it('Anthropic 格式也能校验', () => {
    expect(validateToolPairIntegrity([anthropicUse('u1'), anthropicResult('u1')])).toEqual([]);
    expect(validateToolPairIntegrity([anthropicResult('u1')])[0]).toContain('Orphaned tool_result');
  });

  it('多个缺失都报出来', () => {
    const issues = validateToolPairIntegrity([assistantCall(['a', 'b']), toolResult('a'), toolResult('c')]);
    expect(issues.some(i => i.includes('tool_use: b'))).toBe(true);
    expect(issues.some(i => i.includes('tool_result: c'))).toBe(true);
  });
});
