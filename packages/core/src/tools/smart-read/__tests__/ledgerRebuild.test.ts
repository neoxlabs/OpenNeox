/**
 * 会话恢复重建读账本 — 行为锁
 *
 * "账本必须镜像上下文"的第三面:
 *     面1 子 agent   上下文 fork   → 克隆账本   (按 session 分账, 天然满足)
 *     面2 压缩       内容被挤掉     → 作废账本   (findEvictedReadPaths)
 *     面3 进程重启   历史从库恢复   → 重建账本   (本文件)
 *
 *  第三面是 Neox 独有的 —— 兼容格式 是单会话进程模型, 纯内存账本没问题。
 * 采用 兼容格式 恰好会漏掉它。
 *
 * 这里锁的核心是**安全底线**: 历史里没有读取时的 mtime/size, 所以判据是"磁盘现内容
 * 是否原样出现在当时展示给模型的输出里"。文件变过一律**不重建** —— 宁可多一次读,
 * 绝不让账本比事实更乐观 (那等于重新引入"诊断撒谎")。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { rebuildReadLedgerFromHistory } from '../ledgerRebuild.js';
import { checkCoherence, hasBeenRead, dropSessionLedger, findCoveringRead } from '../readLedger.js';
import { formatLinesWithNumbers } from '../utils.js';

const ORIG = 'export function f() {\n  const x = 1;\n  return x;\n}\n';
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-rebuild-'));
  dropSessionLedger('__default__');
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 造一份跟 readfile 真实输出同格式的"当时展示内容" (带表头 + 行号) */
function shownOutput(content: string): string {
  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return `✓ 读取\n▸ 共 ${lines.length} 行\n━━━━\n` + formatLinesWithNumbers(lines, 1);
}

function history(filePath: string, shownContent: string, extraArgs: Record<string, unknown> = {}): any[] {
  return [
    { role: 'user', content: 'read it' },
    {
      role: 'assistant', content: '',
      tool_calls: [{
        id: 'c1', type: 'function',
        function: { name: 'readfile', arguments: JSON.stringify({ file_path: filePath, ...extraArgs }) },
      }],
    },
    { role: 'tool', content: shownOutput(shownContent), tool_call_id: 'c1' },
  ];
}

const resolve = (p: string) => p;

describe('文件未变 → 可以重建', () => {
  it('重建后诊断为 fresh (省掉一次重读)', async () => {
    const f = path.join(dir, 'a.ts');
    fs.writeFileSync(f, ORIG);
    const r = await rebuildReadLedgerFromHistory(history(f, ORIG), resolve);
    expect(r.restored).toBe(1);
    const st = fs.statSync(f);
    expect(checkCoherence(f, st.mtimeMs, st.size).state).toBe('fresh');
  });
});

describe('安全底线 — 不许比事实更乐观 (任何放宽都要先看这些)', () => {
  it('文件在读之后被改过 → 拒绝重建成 fresh, 诊断为 stale (读过, 但手里那份过期)', async () => {
    const f = path.join(dir, 'b.ts');
    fs.writeFileSync(f, ORIG.replace('const x = 1;', 'const x = 999;'));
    const r = await rebuildReadLedgerFromHistory(history(f, ORIG), resolve);
    expect(r.restored).toBe(0);
    const st = fs.statSync(f);
    expect(checkCoherence(f, st.mtimeMs, st.size).state).toBe('stale');
  });

  it('文件已被删 → 跳过且不抛', async () => {
    const f = path.join(dir, 'gone.ts');
    const r = await rebuildReadLedgerFromHistory(history(f, ORIG), resolve);
    expect(r.restored).toBe(0);
    expect(hasBeenRead(f)).toBe(false);
  });

  it('范围读 → 不重建成 fresh (没法跟整文件内容比对), 但也不是 unread', async () => {
    const f = path.join(dir, 'c.ts');
    fs.writeFileSync(f, ORIG);
    const r = await rebuildReadLedgerFromHistory(history(f, ORIG, { start_line: 2, end_line: 3 }), resolve);
    expect(r.restored).toBe(0);
    const st = fs.statSync(f);
    expect(checkCoherence(f, st.mtimeMs, st.size).state).toBe('stale');
    expect(findCoveringRead(f, 2, 3)).toBeUndefined();
  });

  it('pattern/symbol 定位读 → 同样跳过', async () => {
    const f = path.join(dir, 'd.ts');
    fs.writeFileSync(f, ORIG);
    const r = await rebuildReadLedgerFromHistory(history(f, ORIG, { symbol: 'f' }), resolve);
    expect(r.restored).toBe(0);
  });

  it('非读工具的历史 → 不参与重建', async () => {
    const f = path.join(dir, 'e.ts');
    fs.writeFileSync(f, ORIG);
    const h = history(f, ORIG);
    h[1].tool_calls[0].function.name = 'execute_shell';
    const r = await rebuildReadLedgerFromHistory(h, resolve);
    expect(r.restored).toBe(0);
  });

  it('没有任何读历史 → 空结果, 不做无用功', async () => {
    const r = await rebuildReadLedgerFromHistory([{ role: 'user', content: 'hi' }], resolve);
    expect(r).toEqual({ restored: 0, skipped: 0 });
  });

  it('没读过也没写过的文件 → 仍是 unread', async () => {
    const f = path.join(dir, 'other.ts');
    const g = path.join(dir, 'never.ts');
    fs.writeFileSync(f, ORIG);
    fs.writeFileSync(g, ORIG);
    await rebuildReadLedgerFromHistory(history(f, ORIG), resolve);
    const st = fs.statSync(g);
    expect(checkCoherence(g, st.mtimeMs, st.size).state).toBe('unread');
    expect(hasBeenRead(g)).toBe(false);
  });
});

/**
 *  Restored sessions preserve read and write evidence for multi-file reads and files
 * written by the model, so edit diagnostics do not confuse restored context with an unread file.
 */
describe('重启恢复: 多文件读 / 自己写的文件', () => {
  it('paths=[...] 一次读多个 → 按分段逐个重建', async () => {
    const a = path.join(dir, 'm1.ts');
    const b = path.join(dir, 'm2.ts');
    const B = 'export const b = 2;\n';
    fs.writeFileSync(a, ORIG);
    fs.writeFileSync(b, B);
    const h = [
      { role: 'user', content: 'read' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'm', type: 'function', function: { name: 'readfile', arguments: JSON.stringify({ paths: [a, b] }) } }] },
      { role: 'tool', tool_call_id: 'm', content: `══════ ${a} ══════\n${shownOutput(ORIG)}\n\n══════ ${b} ══════\n${shownOutput(B)}` },
    ];
    const r = await rebuildReadLedgerFromHistory(h, resolve);
    expect(r.restored).toBe(2);
    for (const f of [a, b]) {
      const st = fs.statSync(f);
      expect(checkCoherence(f, st.mtimeMs, st.size).state).toBe('fresh');
    }
  });

  it('write_file 写的全文跟磁盘一致 → fresh; 之后又被改过 → stale', async () => {
    const same = path.join(dir, 'w1.py');
    const changed = path.join(dir, 'w2.py');
    fs.writeFileSync(same, 'print(1)\n');
    fs.writeFileSync(changed, 'print(3)\n');
    const h = [
      { role: 'user', content: 'write' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'w1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ file_path: same, content: 'print(1)\n' }) } },
        { id: 'w2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ file_path: changed, content: 'print(2)\n' }) } },
      ] },
      { role: 'tool', tool_call_id: 'w1', content: 'ok' },
      { role: 'tool', tool_call_id: 'w2', content: 'ok' },
    ];
    await rebuildReadLedgerFromHistory(h, resolve);
    const s1 = fs.statSync(same);
    expect(checkCoherence(same, s1.mtimeMs, s1.size).state).toBe('fresh');
    const s2 = fs.statSync(changed);
    expect(checkCoherence(changed, s2.mtimeMs, s2.size).state).toBe('stale');
  });
});
