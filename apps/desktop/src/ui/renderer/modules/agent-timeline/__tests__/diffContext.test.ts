import { describe, test, expect } from 'vitest';
import { spliceContext, previewSlice, WRITE_PREVIEW_LINES } from '../cells/DiffView';
import type { DiffLine } from '../types';

/* edit_file 的 diff 里只有被替换的旧串/新串, 一行上下文都没有。
 * spliceContext 拿改完之后的文件全文, 用**新增行**做锚点把上下文补回来 —— 不能信 hunk 的
 * startLine, 一次改多处时后面几处的行号早被前面的增删推移了。 */
const file = Array.from({ length: 20 }, (_, i) => `Line ${String(i + 1).padStart(2, '0')}`);

function mk(kind: DiffLine['kind'], text: string, no?: number): DiffLine {
  return { kind, text, oldNo: no, newNo: no };
}

describe('spliceContext', () => {
  test('单处改动: 上下各补 pad 行; 头部只剩 2 行就直接显示不折带子', () => {
    const edited = [...file];
    edited[4] = 'Line 05 [MODIFIED]';
    const lines: DiffLine[] = [mk('del', 'Line 05', 5), mk('add', 'Line 05 [MODIFIED]', 5)];
    const out = spliceContext(lines, edited, 2)!;
    expect(out).not.toBeNull();
    /* 头部只剩 Line 01/02 两行 —— 折成带子不省空间, 直接显示 */
    expect(out.map((l) => l.kind))
      .toEqual(['ctx', 'ctx', 'ctx', 'ctx', 'del', 'add', 'ctx', 'ctx', 'gap']);
    expect(out.filter((l) => l.kind === 'ctx').map((l) => l.text))
      .toEqual(['Line 01', 'Line 02', 'Line 03', 'Line 04', 'Line 06', 'Line 07']);
  });

  test('两处改动: 中间那段折成一条 gap', () => {
    const edited = [...file];
    edited[4] = 'Line 05 [MODIFIED]';
    edited[15] = 'Line 16 [MODIFIED]';
    const lines: DiffLine[] = [
      mk('del', 'Line 05', 5), mk('add', 'Line 05 [MODIFIED]', 5),
      { kind: 'hunk', text: '@@ -16 +16 @@' },
      mk('del', 'Line 16', 16), mk('add', 'Line 16 [MODIFIED]', 16),
    ];
    const out = spliceContext(lines, edited, 2)!;
    const gaps = out.filter((l) => l.kind === 'gap');
    /* 头部 (2 行) 和尾部 (2 行) 都不够 3 行, 直接显示; 只有中间那段折成带子 */
    expect(gaps).toHaveLength(1);
    /* 覆盖第 8..13 行 (第 7 行是上一处的尾 ctx, 第 14 行是下一处的头 ctx) */
    expect({ from: gaps[0]!.oldNo, to: gaps[0]!.newNo }).toEqual({ from: 8, to: 13 });
    /* 上下文不会把改动行再重复渲染一遍 */
    expect(out.filter((l) => l.kind === 'ctx').map((l) => l.text))
      .not.toContain('Line 05 [MODIFIED]');
  });

  test('锚不到就返回 null —— 宁可只显示改动行也不猜内容', () => {
    const lines: DiffLine[] = [mk('del', 'Line 05', 5), mk('add', '这行文件里根本没有', 5)];
    expect(spliceContext(lines, file, 2)).toBeNull();
  });

  test('后一处改动的行号被前面的增删推移时仍能锚住', () => {
    /* 前面插了两行, 原本的第 16 行现在落在第 18 行 —— 信 startLine 就会错位 */
    const edited = [...file.slice(0, 5), '插入 A', '插入 B', ...file.slice(5)];
    edited[17] = 'Line 16 [MODIFIED]';
    const lines: DiffLine[] = [
      mk('add', '插入 A', 6), mk('add', '插入 B', 7),
      { kind: 'hunk', text: '@@ -16 +16 @@' },
      mk('del', 'Line 16', 16), mk('add', 'Line 16 [MODIFIED]', 16),
    ];
    const out = spliceContext(lines, edited, 1)!;
    const ctxAround = out.filter((l) => l.kind === 'ctx').map((l) => l.text);
    expect(ctxAround).toContain('Line 15');
    expect(ctxAround).toContain('Line 17');
  });
});

/* 新建文件的卡默认只给前一屏 —— write_file 一次写 44 行就平铺 44 行绿色, 一张卡吃掉半屏。 */
describe('previewSlice — 新建文件的收起', () => {
  const mkAdds = (n: number): DiffLine[] =>
    Array.from({ length: n }, (_, i) => ({ kind: 'add', text: `line ${i + 1}`, newNo: i + 1 }));

  test('行数不超过额度时原样返回, 不插带子', () => {
    const rows = previewSlice(mkAdds(WRITE_PREVIEW_LINES), WRITE_PREVIEW_LINES);
    expect(rows).toHaveLength(WRITE_PREVIEW_LINES);
    expect(rows.some((l) => l.kind === 'more')).toBe(false);
  });

  test('超额时只留前 N 行 + 一条带子, 带子写剩余行数', () => {
    const rows = previewSlice(mkAdds(44), 12);
    expect(rows).toHaveLength(13);
    expect(rows[12]!.kind).toBe('more');
    expect(rows[12]!.newNo).toBe(32);
    /* 前 12 行必须是原样的头部, 不能挑着显示 */
    expect(rows.slice(0, 12).map((l) => l.text)).toEqual(mkAdds(12).map((l) => l.text));
  });

  test('逐批展开: 每次多放一批, 最后一批放完带子消失', () => {
    const all = mkAdds(300);
    const step1 = previewSlice(all, 12);
    expect(step1[step1.length - 1]!.newNo).toBe(288);
    const step2 = previewSlice(all, 212);
    expect(step2[step2.length - 1]!.newNo).toBe(88);
    const step3 = previewSlice(all, 412);
    expect(step3.some((l) => l.kind === 'more')).toBe(false);
    expect(step3).toHaveLength(300);
  });

  test('原数组不被改坏 (previewSlice 里 push 的是副本)', () => {
    const all = mkAdds(20);
    previewSlice(all, 5);
    expect(all).toHaveLength(20);
    expect(all.some((l) => l.kind === 'more')).toBe(false);
  });
});
