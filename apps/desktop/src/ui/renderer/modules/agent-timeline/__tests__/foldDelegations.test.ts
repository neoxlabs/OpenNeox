import { describe, it, expect } from 'vitest';
import { foldDelegations } from '../foldDelegations';
import type { Row } from '../timelineRows';

const del = (model: string, status: string, toolCount: number, records: number) => ({
  kind: 'single', step: { id: `d-${Math.random()}`, content: { type: 'delegation', model, status, toolCount, toolRecords: new Array(records).fill({ name: 'readfile', status: 'done' }) } },
}) as unknown as Row;
const plain = { kind: 'single', step: { id: 'r1', content: { type: 'file', file: 'a.js' } } } as unknown as Row;

describe('foldDelegations', () => {
  it('没有子 Agent → null (折叠行不挂签)', () => {
    expect(foldDelegations([plain])).toBeNull();
  });

  it('现行 HistoryCell 形态 (background_task · delegation); 后台 shell 不算子 Agent', () => {
    const cell = (variant: string, model?: string) => ({ kind: 'single', step: { kind: 'cell', id: `c-${variant}`, cell: { kind: 'background_task', variant, model, status: 'completed', toolUseCount: 0, toolRecords: new Array(7).fill({}) } } }) as unknown as Row;
    const t = foldDelegations([cell('delegation', 'deepseek-v4.1-flash'), cell('shell')])!;
    expect(t.count).toBe(1);
    expect(t.models).toEqual([{ model: 'deepseek-v4.1-flash', count: 1 }]);
    expect(t.steps).toBe(7);
  });

  it('按模型归并、按次数排序; 步数取 toolCount 与 toolRecords 的大者; 进嵌套 activity', () => {
    const rows = [
      plain,
      del('deepseek-v4.1-flash', 'completed', 0, 18),
      { kind: 'activity', id: 'a', rows: [del('deepseek-v4.1-flash', 'completed', 25, 3), del('gpt-6.1-sol', 'error', 4, 0)], opCount: 3, hasActive: false } as unknown as Row,
    ];
    const t = foldDelegations(rows)!;
    expect(t.count).toBe(3);
    expect(t.models).toEqual([{ model: 'deepseek-v4.1-flash', count: 2 }, { model: 'gpt-6.1-sol', count: 1 }]);
    expect(t.steps).toBe(18 + 25 + 4);
    expect(t.failed).toBe(1);
  });
});
