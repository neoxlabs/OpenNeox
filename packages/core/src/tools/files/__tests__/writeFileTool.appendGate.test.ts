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
  TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-appendgate-test-'));
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

function makeTool() {
  return writeMod.createWriteFileTool({
    resolveWorkspacePath: (p?: string) => path.resolve(WORK, p || ''),  });
}

async function callWrite(args: Record<string, unknown>) {
  const tool = makeTool();
  return JSON.parse(await (tool as any).function(args));
}

describe('write_file append 歧义窗口闸门', () => {
  it('append 之后漏 mode 的写被拒绝, 文件内容一个字节不动', async () => {
    const rel = 'gate/report.html';
    const abs = path.join(WORK, rel);

    const r1 = await callWrite({ file_path: rel, content: 'SEG1\n' });
    expect(r1.status).toBe('success');
    const r2 = await callWrite({ file_path: rel, content: 'SEG2\n', mode: 'append' });
    expect(r2.status).toBe('success');

    /* 事故重演: 第三段漏 mode */
    const r3 = await callWrite({ file_path: rel, content: 'SEG3\n' });
    expect(r3.status).toBe('error');
    expect(String(r3.error)).toMatch(/mode/i);

    await expect(fsp.readFile(abs, 'utf-8')).resolves.toBe('SEG1\nSEG2\n');
  });

  it('被拒后显式 append 重发 → 正常追加', async () => {
    const rel = 'gate/report.html';
    const abs = path.join(WORK, rel);
    const r = await callWrite({ file_path: rel, content: 'SEG3\n', mode: 'append' });
    expect(r.status).toBe('success');
    await expect(fsp.readFile(abs, 'utf-8')).resolves.toBe('SEG1\nSEG2\nSEG3\n');
  });

  it('显式 overwrite 不被闸门拦 —— 闸门管"忘了说", 不管"不许重写"', async () => {
    const rel = 'gate/rewrite.html';
    const abs = path.join(WORK, rel);
    await callWrite({ file_path: rel, content: 'A\n' });
    await callWrite({ file_path: rel, content: 'B\n', mode: 'append' });
    const r = await callWrite({ file_path: rel, content: 'FULL\n', mode: 'overwrite' });
    expect(r.status).toBe('success');
    await expect(fsp.readFile(abs, 'utf-8')).resolves.toBe('FULL\n');
  });

  it('上一笔不是 append (普通覆盖) 时, 漏 mode 照常放行', async () => {
    const rel = 'gate/plain.md';
    await callWrite({ file_path: rel, content: 'v1\n' });
    const r = await callWrite({ file_path: rel, content: 'v2\n' });
    expect(r.status).toBe('success');
  });

  it('幂等去重按 (mode, checksum) 判 — overwrite 过的内容再 append 不会被误吞', async () => {
    const rel = 'gate/dedupe.txt';
    const abs = path.join(WORK, rel);
    await callWrite({ file_path: rel, content: 'SAME\n' });
    const r = await callWrite({ file_path: rel, content: 'SAME\n', mode: 'append' });
    expect(r.status).toBe('success');
    await expect(fsp.readFile(abs, 'utf-8')).resolves.toBe('SAME\nSAME\n');
  });
});
