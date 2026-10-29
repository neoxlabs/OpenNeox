/**
 * work E-05 接线验证 —— helper 测过还不够, 要确认「真的工具」在文件被占用时给出中文指引。
 *
 * 这里走 word_create 的真实工具入口 (不 mock fs): 目标 .docx 旁边放着 Office 的 `~$` 锁定文件,
 * 工具必须返回可执行提示, 并且原文件一个字节都不动。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wordCreateTool } from '../word/wordCreateTool.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-lock-wiring-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('word_create × 文件被占用', () => {
  it('Word 开着时返回「关掉 → 重试 / 另存」的中文提示, 且不覆盖原文件', async () => {
    const target = path.join(dir, 'report.docx');
    fs.writeFileSync(target, 'ORIGINAL');
    const lockFile = path.join(dir, '~$report.docx');
    fs.writeFileSync(lockFile, '');

    const raw = await wordCreateTool.function(
      { save_path: target, content: 'hello', overwrite: true },
      {} as any,
    );
    const payload = JSON.parse(raw as string);

    expect(payload.ok).toBeUndefined();
    expect(payload.error).toContain('文件被占用');
    expect(payload.error).toContain('Word');
    expect(payload.error).toContain('关掉');
    expect(payload.error).toContain('重试');
    expect(fs.readFileSync(target, 'utf8')).toBe('ORIGINAL');
  }, 20_000);

  it('关掉 Word (锁文件消失) 后重试即成功', async () => {
    const target = path.join(dir, 'ok.docx');
    fs.writeFileSync(target, 'ORIGINAL');
    const lockFile = path.join(dir, '~$ok.docx');
    fs.writeFileSync(lockFile, '');

    const blocked = JSON.parse(await wordCreateTool.function(
      { save_path: target, content: 'hello', overwrite: true },
      {} as any,
    ) as string);
    expect(blocked.error).toContain('文件被占用');

    fs.rmSync(lockFile);
    const ok = JSON.parse(await wordCreateTool.function(
      { save_path: target, content: 'hello', overwrite: true },
      {} as any,
    ) as string);

    expect(ok.ok).toBe(true);
    /* 真 .docx = zip, 开头是 PK */
    expect(fs.readFileSync(target).subarray(0, 2).toString('utf8')).toBe('PK');
  }, 20_000);
});
