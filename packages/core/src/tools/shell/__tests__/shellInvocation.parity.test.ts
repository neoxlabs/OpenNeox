/**
 * FG/BG Win invocation 对等 — 同一真源 buildShellInvocation / buildPlatformDirectShell。
 */
import { describe, expect, it } from 'vitest';
import { execa } from 'execa';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPlatformDirectShell } from '@neoxlabs/sandbox';
import { buildShellInvocation, resolveExecaExitCode } from '../shellInvocation.js';

describe('shellInvocation 单一真源', () => {
  it('Win cmd: buildShellInvocation(false) 与 buildPlatformDirectShell 同源', () => {
    if (process.platform !== 'win32') return;
    const a = buildShellInvocation('echo hi', false);
    const b = buildPlatformDirectShell('echo hi');
    expect(a.cmd).toBe(b.program);
    expect(a.args).toEqual(b.args);
    expect(a.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
  });

  it('powershell.exe → 绝对路径 + -Command', () => {
    if (process.platform !== 'win32') return;
    const inv = buildShellInvocation('echo hi', 'powershell.exe');
    expect(/[\\/]/.test(inv.cmd) || inv.cmd.toLowerCase().includes('pwsh')).toBe(true);
    expect(inv.args[0]).toBe('-NoProfile');
    expect(inv.args[1]).toBe('-Command');
  });

  it.runIf(process.platform === 'win32')('cmd 分支标 windowsVerbatimArgs, PowerShell 分支不标', () => {
    const cmdInv = buildShellInvocation('echo hi', false);
    expect(cmdInv.windowsVerbatimArgs).toBe(true);

    const psInv = buildShellInvocation('echo hi', 'powershell.exe');
    expect(psInv.windowsVerbatimArgs).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('真跑: cmd 分支引号不被 execa 撕碎', async () => {
    /* 等价形态: git commit -m "a b c" 的引号必须整体到达。cmd 里 echo 会把引号原样打出,
     * verbatim 下得到 A "B C" D (cmd 自己配对), 非 verbatim 会得到 A \"B C\" D。 */
    const inv = buildShellInvocation('echo A "B C" D', false);
    const subprocess = execa(inv.cmd, inv.args, {
      cwd: process.cwd(),
      reject: false,
      timeout: 15000,
      stdin: 'ignore',
      ...(inv.windowsVerbatimArgs ? { windowsVerbatimArguments: true } : {}),
    });
    const r = await subprocess;
    expect(resolveExecaExitCode(r as any)).toBe(0);
    const out = (r.stdout || '').replace(/\r?\n/g, '');
    expect(out).toContain('B C');
    expect(out).not.toContain('\\"');
  });

  it.runIf(process.platform === 'win32')('真跑: cmd 里嵌套 powershell 的 $ 变量不再被吞', async () => {
    const inv = buildShellInvocation(
      'powershell -NoProfile -Command "$i=5; Write-Host (\'got \' + $i)"',
      false,
    );
    const subprocess = execa(inv.cmd, inv.args, {
      cwd: process.cwd(),
      reject: false,
      timeout: 15000,
      stdin: 'ignore',
      ...(inv.windowsVerbatimArgs ? { windowsVerbatimArguments: true } : {}),
    });
    const r = await subprocess;
    expect(resolveExecaExitCode(r as any), r.stderr || r.stdout).toBe(0);
    expect((r.stdout || '').replace(/\r?\n/g, '')).toContain('got 5');
  });

  it.runIf(process.platform === 'win32')('真跑: cmd 与 powershell 都能 echo + 写文件', async () => {
    const probe = path.join(os.tmpdir(), `_neox_inv_parity_${Date.now()}.txt`);
    try {
      fs.unlinkSync(probe);
    } catch { /* */ }

    async function run(inv: { cmd: string; args: string[] }) {
      let stdoutAcc = '';
      let stderrAcc = '';
      const subprocess = execa(inv.cmd, inv.args, {
        cwd: process.cwd(),
        reject: false,
        timeout: 15000,
        stdin: 'ignore',
      });
      subprocess.stdout?.on('data', (c) => { stdoutAcc += String(c); });
      subprocess.stderr?.on('data', (c) => { stderrAcc += String(c); });
      const r = await subprocess;
      return {
        exitCode: resolveExecaExitCode(r as any),
        stdout: stdoutAcc || r.stdout || '',
        stderr: stderrAcc || r.stderr || '',
      };
    }

    const echoCmd = buildShellInvocation('echo hello-parity', false);
    const echoRes = await run(echoCmd);
    expect(echoRes.exitCode).toBe(0);
    expect(echoRes.stdout.toLowerCase()).toContain('hello-parity');

    const writeCmd = buildShellInvocation(`echo probe_ok>${probe}`, false);
    const writeRes = await run(writeCmd);
    expect(writeRes.exitCode, writeRes.stderr || writeRes.stdout).toBe(0);
    expect(fs.existsSync(probe)).toBe(true);

    const ps = buildShellInvocation('Write-Output hello-ps', 'powershell.exe');
    const psRes = await run(ps);
    expect(psRes.exitCode).toBe(0);
    expect(psRes.stdout.toLowerCase()).toContain('hello-ps');
  }, 30_000);
});

describe('Win 解释器单一真源', () => {
  it.runIf(process.platform === 'win32')('不指定 shellOption 时, 跟 shellOption=true 拿到同一个 shell', () => {
    const implicit = buildShellInvocation('echo hi');
    const explicit = buildShellInvocation('echo hi', true);
    expect(implicit.cmd).toBe(explicit.cmd);
    expect(implicit.args).toEqual(explicit.args);
  });

  it.runIf(process.platform === 'win32')('不指定时跟 PTY 走的 getWindowsShell 一致', async () => {
    const { getWindowsShell } = await import('../../powershell/powershellDetection.js');
    const ws = getWindowsShell()!;
    const inv = buildShellInvocation('echo hi');
    expect(inv.cmd).toBe(ws.shellPath);
    if (ws.isPowerShell) {
      expect(inv.args[0]).toBe('-NoProfile');
      expect(inv.args[1]).toBe('-Command');
    } else {
      expect(inv.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    }
  });

  it.runIf(process.platform === 'win32')('显式 false 仍然强制 cmd —— 逃生门不能被顺手改掉', () => {
    const inv = buildShellInvocation('echo hi', false);
    expect(inv.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
  });

  it('非 Windows 不受影响: 仍走 login shell', () => {
    if (process.platform === 'win32') return;
    const inv = buildShellInvocation('echo hi');
    expect(inv.args).toContain('-lc');
  });
});
