import { describe, it, expect } from 'vitest';
import { deriveProgress } from '../TeamPlanBoard';

const T = (state: string) => ({ id: 'x', title: 't', memberId: 'm', state } as any);

describe('deriveProgress', () => {
  it('缺 progress 时从 tasks 现算, 不是 0', () => {
    const tasks = [...Array(6)].map(() => T('done'))
      .concat([...Array(1)].map(() => T('running')))
      .concat([...Array(9)].map(() => T('pending')));
    const p = deriveProgress(tasks);
    expect(p.done).toBe(6);
    expect(p.total).toBe(16);
    expect(p.running).toBe(1);
  });

  it('failed 单独计, 不混进 done', () => {
    const p = deriveProgress([T('done'), T('failed'), T('failed'), T('pending')]);
    expect(p).toMatchObject({ done: 1, failed: 2, running: 0, total: 4 });
  });

  it('pct 按 done/total', () => {
    expect(deriveProgress([T('done'), T('done'), T('pending'), T('pending')]).pct).toBe(50);
  });

  it('空 tasks 不炸, pct=0', () => {
    expect(deriveProgress([])).toMatchObject({ done: 0, total: 0, pct: 0 });
  });

  it('全完成 = 100%', () => {
    expect(deriveProgress([T('done'), T('done')]).pct).toBe(100);
  });
});
