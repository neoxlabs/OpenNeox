/**
 * 写后刷新读账本 — 行为锁
 *
 * 修的是: 写盘成功后原来无脑 invalidateReads(), 于是"改完接着改"这个最高频路径
 * 每次都要重读整文件 (读去重失效 + 行号桥接失效)。
 * 对照 Claude Code FileEditTool.ts:520 是 readFileState.set(改后内容) —— 刷新而非失效。
 *
 * 这里锁两件事:
 *   1. 整读过的文件, 写后账本仍然有效 (省掉重读)
 *   2. 只读过局部的文件, 写后**必须**失效 —— 不能把模型没看过的内容当成看过的,
 *      否则下次 readfile 会被去重成 stub, 藏起它从未见过的文本 (比原来的失效更糟)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordRead,
  findFreshRead,
  hasBeenRead,
  findCoveringRead,
  refreshReadsAfterWrite,
  invalidateReads,
  dropSessionLedger,
} from '../readLedger.js';

const P = '/tmp/ledger-test/a.ts';
const ORIG = 'line1\nline2\nline3\n';
const AFTER = 'line1\nCHANGED\nline3\n';

beforeEach(() => {
  dropSessionLedger('__default__');
});

describe('整读 → 写后刷新 (省掉重读)', () => {
  it('写后账本仍有效, 且内容是改后的', () => {
    recordRead(P, {
      rangeKey: 'FULL', content: ORIG, startLine: 1, lineCount: 3,
      mtimeMs: 1000, sizeBytes: ORIG.length, readAtTurn: 1,
    });
    refreshReadsAfterWrite(P, AFTER, 2000, AFTER.length);

    // 用新的 mtime/size 查 → 命中 (下一次 readfile 可以短路, 不重发全文)
    const hit = findFreshRead(P, 'FULL', 2000, AFTER.length);
    expect(hit).toBeDefined();
    expect(hit!.content).toBe(AFTER);
    expect(hit!.lineCount).toBe(3);
  });

  it('旧 mtime 不再命中 (版本戳确实更新了)', () => {
    recordRead(P, {
      rangeKey: 'FULL', content: ORIG, startLine: 1, lineCount: 3,
      mtimeMs: 1000, sizeBytes: ORIG.length, readAtTurn: 1,
    });
    refreshReadsAfterWrite(P, AFTER, 2000, AFTER.length);
    expect(findFreshRead(P, 'FULL', 1000, ORIG.length)).toBeUndefined();
  });

  it('连续编辑: 第二次 edit 的行号桥接仍能取到覆盖记录', () => {
    recordRead(P, {
      rangeKey: 'FULL', content: ORIG, startLine: 1, lineCount: 3,
      mtimeMs: 1000, sizeBytes: ORIG.length, readAtTurn: 1,
    });
    refreshReadsAfterWrite(P, AFTER, 2000, AFTER.length);
    // 改前这里会是 undefined → edit 报 need_old_string → 逼模型重读
    const cover = findCoveringRead(P, 2, 2);
    expect(cover).toBeDefined();
    expect(cover!.content).toBe(AFTER);
  });
});

describe('只读过局部 → 写后必须失效 (不许凭空造读证据)', () => {
  it('范围读记录被丢弃, 不会被刷成整读', () => {
    recordRead(P, {
      rangeKey: 'R:1-2', content: 'line1\nline2', startLine: 1, lineCount: 2,
      mtimeMs: 1000, sizeBytes: ORIG.length, readAtTurn: 1,
    });
    refreshReadsAfterWrite(P, AFTER, 2000, AFTER.length);
    expect(hasBeenRead(P)).toBe(false);
    expect(findFreshRead(P, 'FULL', 2000, AFTER.length)).toBeUndefined();
  });

  it('压根没读过 → 写后也不记 (不造证据)', () => {
    refreshReadsAfterWrite(P, AFTER, 2000, AFTER.length);
    expect(hasBeenRead(P)).toBe(false);
  });

  it('整读 + 范围读混存: 只留整读, 范围记录丢掉 (行号可能已漂)', () => {
    recordRead(P, {
      rangeKey: 'FULL', content: ORIG, startLine: 1, lineCount: 3,
      mtimeMs: 1000, sizeBytes: ORIG.length, readAtTurn: 1,
    });
    recordRead(P, {
      rangeKey: 'R:2-3', content: 'line2\nline3', startLine: 2, lineCount: 2,
      mtimeMs: 1000, sizeBytes: ORIG.length, readAtTurn: 1,
    });
    refreshReadsAfterWrite(P, AFTER, 2000, AFTER.length);
    expect(findFreshRead(P, 'FULL', 2000, AFTER.length)).toBeDefined();
    expect(findFreshRead(P, 'R:2-3', 2000, AFTER.length)).toBeUndefined();
  });
});

describe('invalidateReads 仍然可用 (stat 失败等保守退路)', () => {
  it('清得干净', () => {
    recordRead(P, {
      rangeKey: 'FULL', content: ORIG, startLine: 1, lineCount: 3,
      mtimeMs: 1000, sizeBytes: ORIG.length, readAtTurn: 1,
    });
    invalidateReads(P);
    expect(hasBeenRead(P)).toBe(false);
  });
});
