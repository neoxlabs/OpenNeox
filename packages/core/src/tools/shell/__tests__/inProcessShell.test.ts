/**
 * In-process shell smoke test — SH1.
 *
 * 真起 child_process / pty 跑命令, 验证基本生命周期 + callback 时序。
 * 跨平台跑用 echo / sleep 普通命令。
 */

import { describe, expect, test, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startInProcessShell,
  getActiveInProcessShellPids,
  killInProcessShell,
} from '../inProcessShell.js';

/* win 适配: cmd 没有 sleep 命令 (`sleep 0.3` 直接报错退出),
 * 长进程/延时改用临时 node 脚本 —— win/unix 语义一致。 */
let tempFiles: string[] = [];
afterEach(() => {
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch { /* */ }
  }
  tempFiles = [];
});
function tempNodeScript(code: string): string {
  const f = path.join(os.tmpdir(), `neox-sleep-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(f, code);
  tempFiles.push(f);
  return f;
}

describe('in-process shell — smoke', () => {
  test('foreground: echo 完整 output + 正确 exit code', async () => {
    const handle = startInProcessShell(
      { command: 'echo "hello world"', cwd: process.cwd() },
    );
    const result = await handle.result;
    expect(result.success).toBe(true);
    expect(result.background).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('hello world');
    /* 真完成后应该不在 active 表里 */
    expect(getActiveInProcessShellPids()).not.toContain(handle.pid);
  });

  test('foreground: exit non-zero → success=false', async () => {
    const handle = startInProcessShell(
      { command: 'exit 42', cwd: process.cwd() },
    );
    const result = await handle.result;
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(42);
  });

  test('onStarted callback 在子进程起来后立即调', async () => {
    let startedPid = -1;
    const handle = startInProcessShell(
      { command: 'echo hi', cwd: process.cwd() },
      { onStarted: (pid) => { startedPid = pid; } },
    );
    await handle.result;
    expect(startedPid).toBeGreaterThan(0);
    expect(startedPid).toBe(handle.pid);
  });

  test('onStream callback 收到 stdout', async () => {
    const chunks: string[] = [];
    const handle = startInProcessShell(
      { command: 'echo line1; echo line2', cwd: process.cwd() },
      { onStream: (chunk) => chunks.push(chunk.outputDelta) },
    );
    await handle.result;
    const combined = chunks.join('');
    expect(combined).toContain('line1');
    expect(combined).toContain('line2');
  });

  test('background: 起来立即 ack, 进程继续跑 → onBackgroundExit', async () => {
    let backgroundExitCode = -999;
    const handle = startInProcessShell(
      {
        command: `node ${tempNodeScript("setTimeout(()=>process.exit(0),300)")}`,
        cwd: process.cwd(),
        background: true,
        collectMs: 50,
      },
      {
        onBackgroundExit: (_pid, exitCode) => { backgroundExitCode = exitCode; },
      },
    );
    /* result 应该在 ~50ms (collectMs) 后 resolve, 而不是 300ms (命令真完成) */
    const startMs = Date.now();
    const result = await handle.result;
    const elapsed = Date.now() - startMs;
    expect(result.background).toBe(true);
    expect(result.success).toBe(true);
    expect(result.pid).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(250); // 不会卡到 300ms

    /* Wait for the child to exit because that is when onBackgroundExit fires.
     * Polling avoids timing-dependent assertions under parallel test load. */
    const deadline = Date.now() + 5000;
    while (backgroundExitCode === -999 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(backgroundExitCode).toBe(0);
    expect(getActiveInProcessShellPids()).not.toContain(handle.pid);
  });

  test('kill: SIGTERM 后子进程退出 (PTY 模式 exitCode 可能 0, 关键是真退出)', async () => {
    const handle = startInProcessShell(
      { command: `node ${tempNodeScript("setTimeout(()=>{},30000)")}`, cwd: process.cwd() },
    );
    /* 50ms 后 kill */
    const startMs = Date.now();
    setTimeout(() => handle.kill(), 50);
    await handle.result;
    const elapsed = Date.now() - startMs;
    /* sleep 30 真跑会要 30s, kill 后应该在 < 3s 内退出 */
    expect(elapsed).toBeLessThan(3000);
    expect(getActiveInProcessShellPids()).not.toContain(handle.pid);
  });

  test('killInProcessShell(pid) 也能 kill 注册了 pid 的 shell', async () => {
    const handle = startInProcessShell(
      { command: `node ${tempNodeScript("setTimeout(()=>{},30000)")}`, cwd: process.cwd() },
    );
    /* 等 50ms 让 pid 注册 */
    await new Promise((r) => setTimeout(r, 50));
    const pid = handle.pid!;
    expect(getActiveInProcessShellPids()).toContain(pid);
    const killed = killInProcessShell(pid);
    expect(killed).toBe(true);
    await handle.result;
  });
});
