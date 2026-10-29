import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let TMP_HOME: string;
let WORK: string;
let ledgerDir: string;
let editMod: typeof import('../editFileTool.js');
let ledger: typeof import('../../smart-read/readLedger.js');
let store: typeof import('../../smart-read/readLedgerStore.js');

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_LEDGER_DIR = process.env.NEOX_READ_LEDGER_DIR;

const CONTENT = ['function a() {', '  return 1;', '}', ''].join('\n');
const FILE = 'src/a.ts';

beforeAll(async () => {
  TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-edit-restart-'));
  process.env.HOME = TMP_HOME;
  WORK = path.join(TMP_HOME, 'work');
  ledgerDir = path.join(TMP_HOME, 'ledger');
  fs.mkdirSync(path.join(WORK, 'src'), { recursive: true });
  process.env.NEOX_READ_LEDGER_DIR = ledgerDir;

  const cfg = await import('@neoxlabs/platform/utils/config.js');
  if (!cfg.getActiveConfigDir().startsWith(TMP_HOME)) {
    throw new Error(`配置目录未重定向到沙箱 (${cfg.getActiveConfigDir()}) — 中止`);
  }
  editMod = await import('../editFileTool.js');
  ledger = await import('../../smart-read/readLedger.js');
  store = await import('../../smart-read/readLedgerStore.js');
});

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_LEDGER_DIR === undefined) delete process.env.NEOX_READ_LEDGER_DIR;
  else process.env.NEOX_READ_LEDGER_DIR = ORIGINAL_LEDGER_DIR;
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function callEdit(args: Record<string, unknown>) {
  const tool = editMod.createEditFileTool({
    resolveWorkspacePath: (p?: string) => path.resolve(WORK, p || ''),
    formatDisplayPath: (p: string) => p,
  });
  return JSON.parse(await (tool as any).function(args));
}

describe('VERIFY-09 重启后 edit 诊断不退化成 unread', () => {
  it('读过 → 重启 → 抄错 old_string 时诊断仍是 stale/fresh 而不是 unread', async () => {
    const abs = path.join(WORK, FILE);
    fs.writeFileSync(abs, CONTENT, 'utf-8');
    const st = fs.statSync(abs);

    /* 模型读过这个文件 (readfile 的登记路径) */
    ledger.runWithReadScope('restart-session', () => {
      ledger.recordRead(abs, {
        rangeKey: 'FULL',
        content: CONTENT,
        startLine: 1,
        lineCount: 4,
        mtimeMs: st.mtimeMs,
        sizeBytes: st.size,
        readAtTurn: 1,
      });
    });
    store.flushPending('restart-session');

    /* ── 进程重启: 内存账本清空, 只剩盘上快照 ── */
    ledger.clearInMemoryLedger();

    const result = await ledger.runWithReadScope('restart-session', async () =>
      callEdit({ file_path: FILE, old_string: 'function a() {\n  return 999;\n}', new_string: 'x' }));

    expect(result.status).toBe('error');
    expect(result.error).toBe('string_not_found');
    /* 关键断言: 不能是"你还没读过" —— 它读过, 只是抄错了 */
    expect(result.metadata?.coherence).toBe('fresh');
    expect(JSON.stringify(result)).not.toContain('还没读过');
    expect(JSON.stringify(result)).toContain('你读过');
  });

  it('没读过 (空账本) 时仍然是 unread —— 不因持久化而变乐观', async () => {
    const abs = path.join(WORK, 'src/b.ts');
    fs.writeFileSync(abs, CONTENT, 'utf-8');
    ledger.clearInMemoryLedger();

    const result = await ledger.runWithReadScope('fresh-session', async () =>
      callEdit({ file_path: 'src/b.ts', old_string: 'function a() {\n  return 999;\n}', new_string: 'x' }));

    expect(JSON.stringify(result)).toContain('unread');
  });
});
