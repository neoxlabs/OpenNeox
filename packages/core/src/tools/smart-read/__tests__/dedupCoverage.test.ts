/**
 * 读/搜去重的覆盖面 — 行为锁
 *
 * Read and search reuse are based on current content and coverage. A new tool result
 * may be reused without rewriting earlier history; write epochs invalidate only the
 * affected search evidence.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordRead,
  findFreshRead,
  recordSearch,
  findFreshSearch,
  bumpWorkspaceEpoch,
  dropSessionLedger,
} from '../readLedger.js';

const PATH = '/repo/src/Foo.vue';
const entry = (rangeKey: string, startLine: number, lineCount: number) => ({
  rangeKey, content: 'x', startLine, lineCount, mtimeMs: 1000, sizeBytes: 500, readAtTurn: 1,
});

describe('读去重: 范围覆盖', () => {
  beforeEach(() => dropSessionLedger('__default__'));

  it('同范围 + 版本未变 → 命中 (原有行为不变)', () => {
    recordRead(PATH, entry('L:1-400', 1, 400));
    expect(findFreshRead(PATH, 'L:1-400', 1000, 500)).toBeTruthy();
  });

  it('文件变了 → 不命中', () => {
    recordRead(PATH, entry('L:1-400', 1, 400));
    expect(findFreshRead(PATH, 'L:1-400', 2000, 500)).toBeUndefined();
    expect(findFreshRead(PATH, 'L:1-400', 1000, 999)).toBeUndefined();
  });

  it('要的区间被上次更大的一次读完整包含 → 命中 (旧判据这里 miss)', () => {
    recordRead(PATH, entry('L:1-400', 1, 400));
    expect(findFreshRead(PATH, 'L:50-120', 1000, 500, { start: 50, end: 120 })).toBeTruthy();
  });

  it('只是相交、有没见过的行 → 必须真读', () => {
    recordRead(PATH, entry('L:1-400', 1, 400));
    expect(findFreshRead(PATH, 'L:300-500', 1000, 500, { start: 300, end: 500 })).toBeUndefined();
  });

  it('整读过 → 任何子区间都命中', () => {
    recordRead(PATH, entry('FULL', 1, 900));
    expect(findFreshRead(PATH, 'L:700-800', 1000, 500, { start: 700, end: 800 })).toBeTruthy();
  });
});

describe('搜索去重: 按写入内容失效', () => {
  beforeEach(() => dropSessionLedger('__default__'));

  const KEY = 'q1';
  /* filesWithMatches 是 **display 路径** (formatDisplayPath 出来的相对路径),
   * matchedPaths 才是绝对路径 —— 失效判定只能用后者。两者混用会让判据①恒不成立
   * (自审揪出: 显示路径 'src/A.ts' 永远等不上写入回报的 '/repo/src/A.ts')。 */
  const record = () => recordSearch(KEY, 3, ['src/A.ts'], {
    pattern: 'renderTimelineRow',
    matchedPaths: ['/repo/src/A.ts'],
  });

  it('期间没写过 → 命中', () => {
    record();
    expect(findFreshSearch(KEY)).toBeTruthy();
  });

  it('写的是不相干文件、内容里也没这个模式 → 仍然命中 (旧判据这里全废)', () => {
    record();
    bumpWorkspaceEpoch('/repo/src/B.ts', 'export const unrelated = 1;');
    expect(findFreshSearch(KEY)).toBeTruthy();
  });

  it('写的文件本来就在命中列表里 → 作废', () => {
    record();
    bumpWorkspaceEpoch('/repo/src/A.ts', 'whatever');
    expect(findFreshSearch(KEY)).toBeUndefined();
  });

  it('新写入的内容里出现了这个模式 → 作废 (可能多出新匹配)', () => {
    record();
    bumpWorkspaceEpoch('/repo/src/C.ts', 'function renderTimelineRow() {}');
    expect(findFreshSearch(KEY)).toBeUndefined();
  });

  it('写入内容未知 (shell 命令 / 二进制) → 保守作废', () => {
    record();
    bumpWorkspaceEpoch();
    expect(findFreshSearch(KEY)).toBeUndefined();
  });

  it('display 路径不参与判定 — 只认绝对路径 (混用会让判据恒不成立)', () => {
    record();
    /* 'src/A.ts' 是 display 形式, 不该被当成命中文件; 但它的绝对形式该被认出来 */
    bumpWorkspaceEpoch('/repo/src/A.ts', '内容里没有那个模式');
    expect(findFreshSearch(KEY)).toBeUndefined();
  });

  it('没记模式的老条目 → 保守作废, 绝不给可能过期的结果', () => {
    recordSearch('q2', 1, ['src/A.ts']);
    bumpWorkspaceEpoch('/repo/src/B.ts', 'nothing relevant');
    expect(findFreshSearch('q2')).toBeUndefined();
  });
});
