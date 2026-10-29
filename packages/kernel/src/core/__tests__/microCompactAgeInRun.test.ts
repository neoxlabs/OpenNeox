import { describe, it, expect } from 'vitest';
import { microCompact } from '../microCompact.js';

/* 一条用户消息 + N 轮 (assistant 调 shell → tool 结果), 模拟一个从头跑到尾的长任务 */
function longRun(rounds: number) {
  const msgs: any[] = [{ role: 'user', content: '修个 bug' }];
  for (let i = 0; i < rounds; i++) {
    const id = `c${i}`;
    msgs.push({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'execute_shell', arguments: JSON.stringify({ command: `node probe-${i}.mjs` }) } }] });
    msgs.push({ role: 'tool', tool_call_id: id, name: 'execute_shell', content: `OUTPUT-${i} `.repeat(200) });
  }
  return msgs;
}

describe('microCompact · 长任务里的时间衰减', () => {
  it('只有一条用户消息时, 按模型轮次算年龄, 旧的 shell 输出也会清掉', () => {
    const r = microCompact(longRun(30), 4, 18);
    const tools = r.messages.filter((m: any) => m.role === 'tool');
    expect(r.clearedCount).toBe(12);
    expect(tools[0].content).toMatch(/Old tool result cleared/);
    expect(tools[29].content).toContain('OUTPUT-29');
    expect(tools[12].content).toContain('OUTPUT-12');
  });

  it('不到年龄线的不动', () => {
    expect(microCompact(longRun(10), 4, 18).clearedCount).toBe(0);
  });
});
