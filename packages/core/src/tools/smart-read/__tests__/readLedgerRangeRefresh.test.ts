/**
 * 写后按改动区间刷新范围读记录
 *
 * 修的是: 只读过局部的文件, 写完把该文件读证据**一把清空** → "读一段 → 改一刀 →
 * 接着改" 每次都被打回重读整文件 (edit 报 file_not_read)。
 *
 * 新规则只保留能证明「模型确实知道当前内容」的三种情形, 其余照旧丢弃:
 *   1. 整段在改动之前 —— 内容没变、行号没漂
 *   2. 整段包住改动 —— 模型看过这段, 改动又是它自己下的手
 *   3. 整段在改动之后 —— 内容没变, 整体平移
 * 部分重叠一律丢 —— 留着等于把模型没见过的文本当成见过的 (比作废更糟)。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordRead,
  getFileReads,
  findCoveringRead,
  hasBeenRead,
  refreshReadsAfterWrite,
  dropSessionLedger,
} from '../readLedger.js';

const P = '/tmp/ledger-range-test/a.ts';
/** 10 行文件 */
const mk = (lines: string[]) => lines.join('\n') + '\n';
const ORIG = mk(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10']);

function recordRange(startLine: number, endLine: number, content: string, size = ORIG.length) {
  recordRead(P, {
    rangeKey: `R:${startLine}-${endLine}`,
    content,
    startLine,
    lineCount: endLine - startLine + 1,
    mtimeMs: 1000,
    sizeBytes: size,
    readAtTurn: 1,
  });
}

beforeEach(() => dropSessionLedger('__default__'));

describe('不传改前内容 → 保持老行为 (保守作废)', () => {
  it('范围记录仍然全丢', () => {
    recordRange(1, 3, 'L1\nL2\nL3');
    refreshReadsAfterWrite(P, mk(['L1', 'X', 'L3']), 2000, 20);
    expect(hasBeenRead(P)).toBe(false);
  });
});

describe('情形 1: 整段在改动之前 → 原样保留', () => {
  it('读 1-3, 改第 8 行 → 记录还在且内容不变', () => {
    recordRange(1, 3, 'L1\nL2\nL3');
    const after = mk(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'CHANGED', 'L9', 'L10']);
    refreshReadsAfterWrite(P, after, 2000, after.length, 0, ORIG);

    const reads = getFileReads(P);
    expect(reads).toHaveLength(1);
    expect(reads[0].content).toBe('L1\nL2\nL3');
    expect(reads[0].startLine).toBe(1);
    /* 版本戳必须跟到新的 mtime/size, 否则下一轮被判 stale */
    expect(reads[0].mtimeMs).toBe(2000);
  });
});

describe('情形 2: 整段包住改动 → 按行数增量重切片', () => {
  it('等行替换: 读 2-5, 改第 3 行 → 内容刷新为改后文本', () => {
    recordRange(2, 5, 'L2\nL3\nL4\nL5');
    const after = mk(['L1', 'L2', 'X3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10']);
    refreshReadsAfterWrite(P, after, 2000, after.length, 0, ORIG);

    const reads = getFileReads(P);
    expect(reads).toHaveLength(1);
    expect(reads[0].content).toBe('L2\nX3\nL4\nL5');
    expect(reads[0].lineCount).toBe(4);
  });

  it('增行: 读 2-5, 第 3 行变两行 → 范围伸到 2-6, key 同步更新', () => {
    recordRange(2, 5, 'L2\nL3\nL4\nL5');
    const after = mk(['L1', 'L2', 'X3a', 'X3b', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10']);
    refreshReadsAfterWrite(P, after, 2000, after.length, 0, ORIG);

    const reads = getFileReads(P);
    expect(reads).toHaveLength(1);
    expect(reads[0].rangeKey).toBe('R:2-6');
    expect(reads[0].content).toBe('L2\nX3a\nX3b\nL4\nL5');
    expect(reads[0].lineCount).toBe(5);
  });

  it('连续编辑: 第二刀的行号桥接能取到覆盖记录 (不再被打回重读)', () => {
    recordRange(2, 5, 'L2\nL3\nL4\nL5');
    const after = mk(['L1', 'L2', 'X3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10']);
    refreshReadsAfterWrite(P, after, 2000, after.length, 0, ORIG);

    const cover = findCoveringRead(P, 4, 4);
    expect(cover).toBeDefined();
    expect(cover!.content).toContain('X3');
  });
});

describe('情形 3: 整段在改动之后 → 行号平移', () => {
  it('读 8-10, 第 2 行拆成两行 → 平移到 9-11', () => {
    recordRange(8, 10, 'L8\nL9\nL10');
    const after = mk(['L1', 'L2a', 'L2b', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10']);
    refreshReadsAfterWrite(P, after, 2000, after.length, 0, ORIG);

    const reads = getFileReads(P);
    expect(reads).toHaveLength(1);
    expect(reads[0].rangeKey).toBe('R:9-11');
    expect(reads[0].startLine).toBe(9);
    expect(reads[0].content).toBe('L8\nL9\nL10');  // 内容确实没变
  });
});

describe('部分重叠 → 必须丢 (不许把没看过的当看过的)', () => {
  it('读 1-5, 改动跨 4-7 → 记录丢弃', () => {
    recordRange(1, 5, 'L1\nL2\nL3\nL4\nL5');
    const after = mk(['L1', 'L2', 'L3', 'Y4', 'Y5', 'Y6', 'Y7', 'L8', 'L9', 'L10']);
    refreshReadsAfterWrite(P, after, 2000, after.length, 0, ORIG);
    expect(hasBeenRead(P)).toBe(false);
  });

  it('整读存在时只留 FULL, 范围记录不并存', () => {
    recordRead(P, {
      rangeKey: 'FULL', content: ORIG, startLine: 1, lineCount: 10,
      mtimeMs: 1000, sizeBytes: ORIG.length, readAtTurn: 1,
    });
    recordRange(2, 3, 'L2\nL3');
    const after = mk(['L1', 'L2', 'X3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10']);
    refreshReadsAfterWrite(P, after, 2000, after.length, 0, ORIG);

    const reads = getFileReads(P);
    expect(reads).toHaveLength(1);
    expect(reads[0].rangeKey).toBe('FULL');
    expect(reads[0].content).toBe(after);
  });
});

describe('边界', () => {
  it('等价写入 (内容没变) → 记录原样保留, 只刷版本戳', () => {
    recordRange(2, 4, 'L2\nL3\nL4');
    refreshReadsAfterWrite(P, ORIG, 2000, ORIG.length, 0, ORIG);
    const reads = getFileReads(P);
    expect(reads).toHaveLength(1);
    expect(reads[0].mtimeMs).toBe(2000);
  });

  it('文件被大幅截短, 平移后越界 → 丢弃而不是造假', () => {
    recordRange(8, 10, 'L8\nL9\nL10');
    const after = mk(['L1', 'L2']);
    refreshReadsAfterWrite(P, after, 2000, after.length, 0, ORIG);
    expect(hasBeenRead(P)).toBe(false);
  });
});
