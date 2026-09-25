import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let TMP_HOME: string;
let WORK: string;
let writeMod: typeof import('../writeFileTool.js');

const ORIGINAL_HOME = process.env.HOME;

beforeAll(async () => {
  TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-idem-disk-test-'));
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
  const tool = writeMod.createWriteFileTool({
    resolveWorkspacePath: (p?: string) => path.resolve(WORK, p || ''),  });
  return JSON.parse(await (tool as any).function(args));
}

describe('write_file 幂等窗口以磁盘为准', () => {
  it('文件在幂等窗口内被删掉 → 重写必须真的落盘, 不能报 already_done', async () => {
    const rel = 'idem/a.txt';
    const abs = path.join(WORK, rel);

    const r1 = await callWrite({ file_path: rel, content: 'hello\n' });
    expect(r1.status).toBe('success');
    await expect(fsp.readFile(abs, 'utf-8')).resolves.toBe('hello\n');

    await fsp.rm(abs);
    expect(fs.existsSync(abs)).toBe(false);

    /* 同一个路径 + 同一份内容, 仍在 5 分钟窗口内 —— 以前这里返回 already_done */
    const r2 = await callWrite({ file_path: rel, content: 'hello\n' });
    expect(r2.status).not.toBe('already_done');
    await expect(fsp.readFile(abs, 'utf-8')).resolves.toBe('hello\n');
  });

  it('文件还在时仍然走幂等, 不做无谓的重复写', async () => {
    const rel = 'idem/b.txt';
    const r1 = await callWrite({ file_path: rel, content: 'same\n' });
    expect(r1.status).toBe('success');
    const r2 = await callWrite({ file_path: rel, content: 'same\n' });
    expect(r2.status).toBe('already_done');
  });
});
