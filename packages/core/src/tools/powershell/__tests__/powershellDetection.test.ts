/**
 * getWindowsShell 默认 shell 策略回归 (效率审计)。
 *
 * 策略: Windows 默认只有 pwsh (Core 7+) 才用 PowerShell;
 *       只有 powershell.exe 5.1 → 回落 cmd.exe (5.1 每条命令启动 ~156ms, 是 cmd 的 17 倍, 且不支持 &&)。
 *       执行端 (buildShellInvocation) 与环境注入 (buildEnvironmentInfo) 同源走此函数。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { getWindowsShell, resetDetectionCache } from '../powershellDetection.js';

const { mockExecFileSync } = vi.hoisted(() => ({ mockExecFileSync: vi.fn() }));

vi.mock('node:child_process', () => ({ execFileSync: mockExecFileSync }));

const ORIG_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!;

function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: p });
}

describe('getWindowsShell (win32 默认 shell 策略)', () => {
  beforeEach(() => {
    resetDetectionCache();
    mockExecFileSync.mockReset();
    setPlatform('win32');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', ORIG_PLATFORM);
    delete process.env.NEOX_FORCE_CMD;
  });

  it('win32 装了 pwsh → PowerShell core (&& 可用)', () => {
    mockExecFileSync.mockReturnValue('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
    const ws = getWindowsShell();
    expect(ws).not.toBeNull();
    expect(ws!.isPowerShell).toBe(true);
    expect(ws!.edition).toBe('core');
    expect(ws!.supportsChaining).toBe(true);
    expect(ws!.shellPath.toLowerCase()).toContain('pwsh.exe');
  });

  it('win32 只有 powershell.exe 5.1 → 回落 cmd (不再把 5.1 当默认)', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('where pwsh: not found');
    });
    const ws = getWindowsShell();
    expect(ws).not.toBeNull();
    expect(ws!.isPowerShell).toBe(false);
    expect(ws!.edition).toBeNull();
    expect(ws!.supportsChaining).toBe(true);
    expect(ws!.shellPath.toLowerCase()).toContain('cmd.exe');
  });

  it('NEOX_FORCE_CMD=1 强制 cmd, 即使装了 pwsh', () => {
    process.env.NEOX_FORCE_CMD = '1';
    mockExecFileSync.mockReturnValue('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
    const ws = getWindowsShell();
    expect(ws!.isPowerShell).toBe(false);
    expect(ws!.shellPath.toLowerCase()).toContain('cmd.exe');
    // 强制 cmd 时不该去探测 pwsh
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('非 win32 → null', () => {
    setPlatform('darwin');
    const ws = getWindowsShell();
    expect(ws).toBeNull();
  });
});
