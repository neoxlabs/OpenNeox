import { describe, test, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startInProcessShell } from '../inProcessShell';

/**
 * Foreground output is capped at 64KB, preserves both head and tail, and
 * reports the omitted middle section.
 */

const CAP_ENV = 'NEOX_SHELL_OUTPUT_CAP_BYTES';
let tempFiles: string[] = [];
afterEach(() => {
  delete process.env[CAP_ENV];
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch { /* */ }
  }
  tempFiles = [];
});

/* win 适配: cmd 会剥 `node -e "..."` 的双引号 (SyntaxError), 噪音生成
 * 改用临时脚本文件跑 —— win/unix 语义一致。 */
function tempNodeScript(code: string): string {
  const f = path.join(os.tmpdir(), `neox-cap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(f, code);
  tempFiles.push(f);
  return f;
}

async function run(command: string) {
  const h = startInProcessShell({ command, cwd: process.cwd() });
  return h.result;
}

describe('输出超限: 保头也保尾', () => {
  test('结尾那行必须活下来 (这条就是 wc -l 的 total)', async () => {
    process.env[CAP_ENV] = '2048';
    /* 先吐一大堆噪音, 最后一行才是答案 */
    const r = await run(`node ${tempNodeScript("for(let i=0;i<4000;i++)console.log('noise line '+i);console.log('TOTAL=12345')")}`);
    expect(r.output).toContain('TOTAL=12345');          /* ← 旧实现在这里丢掉答案 */
    expect(r.output).toContain('noise line 0');         /* 开头也要在 */
    expect(r.output).toMatch(/中间省略/);                /* 必须明说丢了中间 */
  }, 30_000);

  test('没超限时输出一字不动, 不加任何提示', async () => {
    const r = await run(`node ${tempNodeScript("console.log('short output')")}`);
    expect(r.output).toContain('short output');
    expect(r.output).not.toMatch(/中间省略|truncated/);
  }, 20_000);

  test('超限不再杀掉进程 —— 命令要能正常跑完拿到退出码', async () => {
    process.env[CAP_ENV] = '2048';
    const r = await run(`node ${tempNodeScript("for(let i=0;i<3000;i++)console.log('x'.repeat(50));process.exit(0)")}`);
    expect(r.exitCode).toBe(0);        /* 旧实现 killChild → 非 0 / 被信号打断 */
    expect(r.success).toBe(true);
  }, 30_000);

  test('省略提示要报出命令的真实总输出量, 别让模型把首尾当全部', async () => {
    process.env[CAP_ENV] = '2048';
    const r = await run(`node ${tempNodeScript("for(let i=0;i<3000;i++)console.log('y'.repeat(50))")}`);
    const m = r.output.match(/命令共输出 (\d+)B/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThan(100_000);   /* 3000 × 51B ≈ 153KB */
  }, 30_000);

  test('默认上限降到 64KB (旧值 256KB 在 128k 窗口上是半个窗口)', async () => {
    const { DEFAULT_OUTPUT_CAP_BYTES } = await import('../inProcessShell');
    expect(DEFAULT_OUTPUT_CAP_BYTES).toBe(64 * 1024);
  });
});
