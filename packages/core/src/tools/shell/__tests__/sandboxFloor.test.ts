/**
 * The sandbox-floor integration test executes a real command on macOS to
 * verify that guarded modes cannot write outside the workspace. Linux uses
 * bwrap and may skip when the runtime is unavailable.
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runWithSandboxFloor } from '../sandboxFloor.js';
import { shouldUseOsSandbox, buildMaybeSandboxedInvocation } from '../osSandbox.js';

const execFileAsync = promisify(execFile);

/** 在给定 cwd 下跑一条命令, 走跟 execute_shell 同一条 invocation 构建路径。 */
async function runShell(command: string, cwd: string): Promise<{ sandboxed: boolean; ok: boolean }> {
  const inv = buildMaybeSandboxedInvocation(command, cwd);
  try {
    await execFileAsync(inv.cmd, inv.args, { cwd });
    return { sandboxed: inv.sandboxed, ok: true };
  } catch {
    return { sandboxed: inv.sandboxed, ok: false };
  } finally {
    inv.cleanup();
  }
}

const onMac = process.platform === 'darwin';

describe('sandboxFloor', () => {
  it('地板只在包住的调用链里可见', async () => {
    const { getSandboxFloor } = await import('../sandboxFloor.js');
    expect(getSandboxFloor()).toBeUndefined();
    await runWithSandboxFloor({ mode: 'work', reason: 't' }, () => {
      expect(getSandboxFloor()?.mode).toBe('work');
    });
    expect(getSandboxFloor()).toBeUndefined();
  });

  it('地板强制打开 OS 强制 (默认 config 下 OS 沙盒是关的)', async () => {
    /* 前置事实: 默认配置下没人开 OS 沙盒 —— 这正是需要地板的原因。 */
    const baseline = shouldUseOsSandbox();
    await runWithSandboxFloor({ mode: 'work', reason: 't' }, () => {
      expect(shouldUseOsSandbox()).toBe(true);
    });
    /* 出了地板恢复原状 (code 模式行为零变化)。 */
    expect(shouldUseOsSandbox()).toBe(baseline);
  });

  it.runIf(onMac)('地板下: 工作区内可写, 工作区外被内核拒', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'neox-ws-'));
    const inside = path.join(ws, 'ok.txt');
    /* 不能拿 tmpdir 当"工作区外" —— /private/tmp 是策略里**显式**的可写根 (脚本要落临时文件)。
     * 真正的越界目标要挑用户家目录下的普通位置。 */
    const outside = path.join(process.env.HOME ?? '', `__neox_sandbox_probe_${Date.now()}.txt`);
    try {
      await runWithSandboxFloor({ mode: 'work', reason: 't' }, async () => {
        const inRes = await runShell(`printf x > "${inside}"`, ws);
        expect(inRes.sandboxed, 'seatbelt 应当真的挂上了').toBe(true);
        expect(inRes.ok).toBe(true);
        expect(existsSync(inside)).toBe(true);

        const outRes = await runShell(`printf x > "${outside}"`, ws);
        expect(outRes.ok, '工作区外的写必须失败').toBe(false);
        expect(existsSync(outside), '工作区外不该出现文件').toBe(false);
      });
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  }, 120_000);

  it.runIf(onMac)('地板下: 密钥护栏生效 —— ~/.neox 写不进去', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'neox-ws-'));
    const target = path.join(process.env.HOME ?? '', '.neox', '__sandbox_probe.txt');
    try {
      await runWithSandboxFloor({ mode: 'work', reason: 't' }, async () => {
        const res = await runShell(`printf x > "${target}"`, ws);
        expect(res.ok).toBe(false);
        expect(existsSync(target)).toBe(false);
      });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 120_000);
});
