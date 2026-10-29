/**
 * microCompact 去重 key 要带范围。
 * 只按路径: "读 1-300 行"和"读 300-600 行"被当成同一次, 后一段把前一段清掉,
 * 模型手里只剩后半截 → 回头重读。
 */
import { describe, expect, it } from 'vitest';
import { microCompact } from '../microCompact.js';

function readCall(id: string, args: Record<string, unknown>) {
  return [
    { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'readfile', arguments: JSON.stringify(args) } }] },
    { role: 'tool', name: 'readfile', tool_call_id: id, content: `content of ${id} `.repeat(50) },
  ];
}

describe('microCompact dedupe key', () => {
  const padding = Array.from({ length: 6 }, (_, i) => readCall(`pad${i}`, { path: `/other${i}.ts` })).flat();

  it('同一文件不同范围 → 都保留', () => {
    const messages: any[] = [
      { role: 'user', content: 'go' },
      ...readCall('r1', { path: '/a.ts', start_line: 1, num_lines: 300 }),
      ...readCall('r2', { path: '/a.ts', start_line: 300, num_lines: 300 }),
      ...padding,
    ];
    const out = microCompact(messages, 1);
    const cleared = out.messages.filter((m: any) => m.role === 'tool' && String(m.content).startsWith('[Previous tool result cleared'));
    expect(cleared.map((m: any) => m.tool_call_id)).not.toContain('r1');
  });

  it('同一文件同一范围读两次 → 旧的清掉', () => {
    const messages: any[] = [
      { role: 'user', content: 'go' },
      ...readCall('r1', { path: '/a.ts' }),
      ...readCall('r2', { path: '/a.ts' }),
      ...padding,
    ];
    const out = microCompact(messages, 1);
    const cleared = out.messages.filter((m: any) => m.role === 'tool' && String(m.content).startsWith('[Previous tool result cleared'));
    expect(cleared.map((m: any) => m.tool_call_id)).toContain('r1');
  });
});
