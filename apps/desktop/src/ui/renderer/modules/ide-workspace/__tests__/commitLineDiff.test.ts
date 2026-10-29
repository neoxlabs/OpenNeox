import { describe, it, expect } from 'vitest';
import { computeCommitDiff } from '../commitLineDiff';

const lines = (n: number, tag = 'x') => Array.from({ length: n }, (_, i) => `${tag}-line-${i}`);

describe('computeCommitDiff', () => {
  it('两边一样 → identical, 不出行', () => {
    const s = 'a\nb\nc\n';
    const d = computeCommitDiff(s, s);
    expect(d.identical).toBe(true);
    expect(d.rows).toHaveLength(0);
  });

  it('改一行 → 一删一加, 上下文保留', () => {
    const a = 'p\nq\nOLD\nr\ns\n';
    const b = 'p\nq\nNEW\nr\ns\n';
    const d = computeCommitDiff(a, b);
    expect(d.add).toBe(1);
    expect(d.del).toBe(1);
    expect(d.rows.find((r) => r.kind === 'del')?.text).toBe('OLD');
    expect(d.rows.find((r) => r.kind === 'add')?.text).toBe('NEW');
    /* 上下文行两侧行号都在 */
    const ctx = d.rows.find((r) => r.kind === 'ctx' && r.text === 'q')!;
    expect(ctx.oldNo).toBe(2);
    expect(ctx.newNo).toBe(2);
  });

  it('行号是 1-based 且指向各自的文件', () => {
    const a = 'a\nb\nc\n';
    const b = 'a\nINS\nb\nc\n';
    const d = computeCommitDiff(a, b);
    const ins = d.rows.find((r) => r.kind === 'add')!;
    expect(ins.text).toBe('INS');
    expect(ins.newNo).toBe(2);
    expect(ins.oldNo).toBeUndefined();
  });

  it('远离改动的大段未改动被折叠成 gap', () => {
    const base = lines(200);
    const a = base.join('\n');
    const b = [...base.slice(0, 100), 'INSERTED', ...base.slice(100)].join('\n');
    const d = computeCommitDiff(a, b);
    expect(d.add).toBe(1);
    expect(d.del).toBe(0);
    const gaps = d.rows.filter((r) => r.kind === 'gap');
    expect(gaps.length).toBeGreaterThan(0);
    /* 200 行的文件不该逐行铺出来 */
    expect(d.rows.length).toBeLessThan(20);
  });

  it('二进制不按文本渲染', () => {
    const d = computeCommitDiff('a\u0000b', 'c\u0000d');
    expect(d.binary).toBe(true);
    expect(d.rows).toHaveLength(0);
  });

  it('大文件 + 散点改动: 不许退化成整文件删+加', () => {
    const N = 6000;
    const orig: string[] = [];
    for (let i = 0; i < N; i++) orig.push(`  --token-${i}: value ${i};`);
    const mod = orig.slice();
    const touched = 145;
    for (let k = 0; k < touched; k++) {
      const i = Math.floor((k * N) / touched);
      mod[i] = `  --token-${i}: value ${i} CHANGED;`;
    }
    const t0 = Date.now();
    const d = computeCommitDiff(orig.join('\n'), mod.join('\n'));
    const ms = Date.now() - t0;

    expect(d.add).toBe(touched);
    expect(d.del).toBe(touched);
    /* 退化版本会给出 6000 —— 差三个数量级, 闸卡在中间足够宽的地方 */
    expect(d.add).toBeLessThan(300);
    /* 渲染端算的, 不能让人等 */
    expect(ms).toBeLessThan(3000);
  });

  it('一段里没有唯一行时仍然出得来 (退回 LCS)', () => {
    /* 全是重复行 —— patience 找不到锚点 */
    const a = ['}', '}', '}', '}', '}'].join('\n');
    const b = ['}', '}', '}'].join('\n');
    const d = computeCommitDiff(a, b);
    expect(d.del).toBe(2);
    expect(d.add).toBe(0);
  });

  it('整文件替换: 旧的全删, 新的全加', () => {
    const d = computeCommitDiff(lines(30, 'old').join('\n'), lines(30, 'new').join('\n'));
    expect(d.del).toBe(30);
    expect(d.add).toBe(30);
  });
});
