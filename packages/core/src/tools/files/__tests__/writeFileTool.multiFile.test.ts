import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let TMP_HOME: string;
let WORK: string;
let writeMod: typeof import('../writeFileTool.js');

const ORIGINAL_HOME = process.env.HOME;

beforeAll(async () => {
  TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-multi-write-test-'));
  process.env.HOME = TMP_HOME;
  WORK = path.join(TMP_HOME, 'work');
  fs.mkdirSync(WORK, { recursive: true });

  const cfg = await import('@neoxlabs/platform/utils/config.js');
  if (!cfg.getActiveConfigDir().startsWith(TMP_HOME)) {
    throw new Error(`配置目录未重定向到沙箱 (${cfg.getActiveConfigDir()}) — 中止`);
  }
  writeMod = await import('../writeFileTool.js');
});

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function callWrite(args: Record<string, unknown>) {
  const tool = writeMod.createWriteFileTool({ resolveWorkspacePath: (p?: string) => path.resolve(WORK, p || '') });
  return JSON.parse(await (tool as any).function(args));
}

describe('write_file files=[...]', () => {
  it('一次写多个文件, 全部落盘', async () => {
    const r = await callWrite({ files: [
      { file_path: 'm/a.js', content: 'export const a = 1;\n' },
      { file_path: 'm/test/a.test.js', content: "import './a.js';\n" },
    ] });
    expect(r.status).toBe('success');
    expect(r.summary).toMatch(/2 files written/);
    expect(fs.readFileSync(path.join(WORK, 'm/a.js'), 'utf-8')).toBe('export const a = 1;\n');
    expect(fs.existsSync(path.join(WORK, 'm/test/a.test.js'))).toBe(true);
  });

  it('其中一个失败 (空内容会清空已有文件) → 其余照写, 结果点名哪个失败', async () => {
    fs.mkdirSync(path.join(WORK, 'n'), { recursive: true });
    fs.writeFileSync(path.join(WORK, 'n/keep.js'), 'precious\n');
    const r = await callWrite({ files: [
      { file_path: 'n/keep.js', content: '' },
      { file_path: 'n/new.js', content: 'ok\n' },
    ] });
    expect(r.status).toBe('error');
    expect(r.summary).toMatch(/1\/2 files written/);
    expect(fs.readFileSync(path.join(WORK, 'n/keep.js'), 'utf-8')).toBe('precious\n');
    expect(fs.readFileSync(path.join(WORK, 'n/new.js'), 'utf-8')).toBe('ok\n');
  });

  it('单文件调用不受影响', async () => {
    const r = await callWrite({ file_path: 'single.txt', content: 'hi\n' });
    expect(r.status).toBe('success');
    expect(r.summary).toMatch(/File created: single.txt/);
  });
});
