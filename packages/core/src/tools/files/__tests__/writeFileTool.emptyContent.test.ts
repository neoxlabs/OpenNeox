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
  TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-empty-write-test-'));
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

describe('write_file empty content', () => {
  it('creates a new empty file', async () => {
    const r = await callWrite({ file_path: 'data/.gitkeep', content: '' });
    expect(r.status).toBe('success');
    expect(fs.existsSync(path.join(WORK, 'data/.gitkeep'))).toBe(true);
  });

  it('refuses to blank out an existing non-empty file', async () => {
    const abs = path.join(WORK, 'keep.txt');
    await fsp.writeFile(abs, 'important\n');
    const r = await callWrite({ file_path: 'keep.txt', content: '   ' });
    expect(r.status).toBe('error');
    await expect(fsp.readFile(abs, 'utf-8')).resolves.toBe('important\n');
  });
});
