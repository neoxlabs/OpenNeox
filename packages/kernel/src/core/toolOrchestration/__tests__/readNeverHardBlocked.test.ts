/** Read-only repetition is advisory even at HARD; state-changing tools remain
 * subject to hard loop blocking. */
import { describe, it, expect } from 'vitest';
import { createLoopAdapter } from '../adapters/loopAdapter';
import { LoopDetector } from '../../loopDetector';

const hammer = (d: LoopDetector, tool: string, args: Record<string, unknown>, n = 6) => {
  for (let i = 0; i < n; i++) d.record(tool, args, 'success');
};

describe('循环守卫 · 读 vs 写', () => {
  it('读重复到 HARD 也只给 advisory, 不 block', () => {
    const d = new LoopDetector();
    const gate = createLoopAdapter(d);
    const args = { path: 'a.ts' };
    hammer(d, 'readfile', args);
    const r = gate.check('readfile', args);
    expect(r.level).not.toBe('hard');
    /* 仍然要把话带到 —— 提示进 output, 用户那句进 userNotice */
    expect(r.message || r.userNotice).toBeTruthy();
  });

  it('搜索类同样不硬拦', () => {
    const d = new LoopDetector();
    const gate = createLoopAdapter(d);
    const args = { pattern: 'foo', path: '.' };
    hammer(d, 'search_files', args);
    expect(gate.check('search_files', args).level).not.toBe('hard');
  });

  it('对照: 有副作用的重复仍然硬拦', () => {
    const d = new LoopDetector();
    const gate = createLoopAdapter(d);
    const args = { command: 'rm -rf build' };
    hammer(d, 'execute_bash', args);
    expect(gate.check('execute_bash', args).level).toBe('hard');
  });
});
