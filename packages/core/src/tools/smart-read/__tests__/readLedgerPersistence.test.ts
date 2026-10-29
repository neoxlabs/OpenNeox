/**
 * VERIFY-09 — 读账本跨会话 (跨进程) 持久化
 *
 * 覆盖点:
 *   1. 落盘后清掉内存账本 → 能恢复 FULL / 范围读条目, checkCoherence 判 fresh
 *   2. 文件在两次进程之间被改过 → 恢复时丢弃 (宁可 unread/stale, 不可撒谎说 fresh)
 *   3. 文件被删 → 丢弃
 *   4. 不落盘任何内容 = 不产生文件 (没有会话上下文时)
 *   5. dropSessionLedger (会话结束) 会删掉落盘文件
 *   6. 超限内容条目整条丢弃, 不留下"有版本戳没内容"的假证据
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkCoherence,
  clearInMemoryLedger,
  dropSessionLedger,
  getFileReads,
  recordRead,
  runWithReadScope,
} from '../readLedger.js';
import { flushPending, ledgerPathForSession, loadPersisted, persistNow } from '../readLedgerStore.js';

let tmpDir: string;
let ledgerDir: string;
let filePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-ledger-'));
  ledgerDir = path.join(tmpDir, 'ledger');
  process.env.NEOX_READ_LEDGER_DIR = ledgerDir;
  filePath = path.join(tmpDir, 'a.ts');
  fs.writeFileSync(filePath, 'line1\nline2\nline3\n', 'utf-8');
  clearInMemoryLedger();
});

afterEach(() => {
  clearInMemoryLedger();
  delete process.env.NEOX_READ_LEDGER_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function statOf(p: string) {
  const st = fs.statSync(p);
  return { mtimeMs: st.mtimeMs, sizeBytes: st.size };
}

function recordFullRead(content: string, turn = 1) {
  const st = statOf(filePath);
  recordRead(filePath, {
    rangeKey: 'FULL',
    content,
    startLine: 1,
    lineCount: content.split('\n').length,
    mtimeMs: st.mtimeMs,
    sizeBytes: st.sizeBytes,
    readAtTurn: turn,
  });
}

describe('VERIFY-09 读账本跨会话持久化', () => {
  it('落盘 → 清内存 → 恢复后 checkCoherence 仍是 fresh, 内容可用于 edit 重定位', () => {
    runWithReadScope('sess-restart', () => {
      recordFullRead('line1\nline2\nline3\n');
      flushPending('sess-restart');   // 落盘是防抖的, 测试里显式刷
    });
    /* 模拟进程重启: 内存没了, 只剩盘上的快照 */
    clearInMemoryLedger();

    const st = statOf(filePath);
    runWithReadScope('sess-restart', () => {
      const coh = checkCoherence(filePath, st.mtimeMs, st.sizeBytes);
      expect(coh.state).toBe('fresh');
      const reads = getFileReads(filePath);
      expect(reads).toHaveLength(1);
      expect(reads[0].content).toBe('line1\nline2\nline3\n');
      expect(reads[0].rangeKey).toBe('FULL');
    });
  });

  it('范围读也能恢复 (从历史重建做不到这一类)', () => {
    const st = statOf(filePath);
    runWithReadScope('sess-range', () => {
      recordRead(filePath, {
        rangeKey: 'R:2-3',
        content: 'line2\nline3',
        startLine: 2,
        lineCount: 2,
        mtimeMs: st.mtimeMs,
        sizeBytes: st.sizeBytes,
        readAtTurn: 1,
      });
      flushPending('sess-range');
    });
    clearInMemoryLedger();

    runWithReadScope('sess-range', () => {
      const reads = getFileReads(filePath);
      expect(reads.map((r) => r.rangeKey)).toEqual(['R:2-3']);
      expect(reads[0].content).toBe('line2\nline3');
    });
  });

  it('两次进程之间文件被改过 → 恢复时丢弃该条 (不许说 fresh)', () => {
    runWithReadScope('sess-changed', () => {
      recordFullRead('line1\nline2\nline3\n');
      flushPending('sess-changed');
    });
    clearInMemoryLedger();

    /* 另一个进程 / 用户在编辑器里改了文件 */
    fs.writeFileSync(filePath, 'line1\nline2 CHANGED\nline3\n', 'utf-8');
    const st = statOf(filePath);

    runWithReadScope('sess-changed', () => {
      expect(getFileReads(filePath)).toHaveLength(0);
      /* 没读过 = unread, 这是安全状态: 模型手里那份可能过期 */
      expect(checkCoherence(filePath, st.mtimeMs, st.sizeBytes).state).toBe('unread');
    });
  });

  it('文件被删 → 恢复时丢弃', () => {
    runWithReadScope('sess-deleted', () => {
      recordFullRead('line1\nline2\nline3\n');
      flushPending('sess-deleted');
    });
    clearInMemoryLedger();
    fs.rmSync(filePath);

    runWithReadScope('sess-deleted', () => {
      expect(getFileReads(filePath)).toHaveLength(0);
    });
  });

  it('会话结束 (dropSessionLedger) 连落盘文件一起删', () => {
    runWithReadScope('sess-ended', () => {
      recordFullRead('line1\nline2\nline3\n');
      flushPending('sess-ended');
    });
    const p = ledgerPathForSession('sess-ended');
    expect(fs.existsSync(p)).toBe(true);

    dropSessionLedger('sess-ended');
    expect(fs.existsSync(p)).toBe(false);
  });

  it('超限内容条目整条丢弃 —— 不留"有版本戳没内容"的假证据', () => {
    const huge = 'x'.repeat(300 * 1024);
    persistNow('sess-huge', {
      [filePath]: [{
        rangeKey: 'FULL',
        content: huge,
        startLine: 1,
        lineCount: 1,
        mtimeMs: statOf(filePath).mtimeMs,
        sizeBytes: statOf(filePath).sizeBytes,
        readAtTurn: 1,
      }],
    });
    expect(loadPersisted('sess-huge')).toBeNull();
  });

  it('没有会话上下文 (__default__) 时不落盘', () => {
    /* 显式目录 = 显式要求持久化 (测试用), 所以要先摘掉它才能验默认行为 */
    delete process.env.NEOX_READ_LEDGER_DIR;
    recordRead(filePath, {
      rangeKey: 'FULL',
      content: 'line1\nline2\nline3\n',
      startLine: 1,
      lineCount: 3,
      ...statOf(filePath),
      readAtTurn: 1,
    } as any);
    expect(flushPending()).toBe(0);   // 没有待落盘 = 一条都没排进去
  });
});
