/**
 * Win 前台 shell 解析回归 — 不许再把裸 powershell.exe 丢进 PATH 碰运气。
 */
import { describe, expect, it } from 'vitest';
import { resolveWindowsShellExecutable } from '../shellInvocation.js';

describe('resolveWindowsShellExecutable', () => {
  it('powershell.exe → 绝对路径 (含 powershell 或 pwsh)', () => {
    const { exe, isPowerShell } = resolveWindowsShellExecutable('powershell.exe');
    expect(isPowerShell).toBe(true);
    if (process.platform === 'win32') {
      expect(/[\\/]/.test(exe) || exe.toLowerCase().includes('pwsh')).toBe(true);
      expect(exe.toLowerCase()).not.toBe('powershell.exe');
    }
  });

  it('cmd.exe → ComSpec', () => {
    const { exe, isPowerShell } = resolveWindowsShellExecutable('cmd.exe');
    expect(isPowerShell).toBe(false);
    if (process.platform === 'win32') {
      expect(exe.toLowerCase()).toContain('cmd.exe');
      if (process.env.ComSpec) {
        expect(exe).toBe(process.env.ComSpec);
      }
    }
  });

  it('已是绝对路径则原样保留', () => {
    const abs = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const { exe, isPowerShell } = resolveWindowsShellExecutable(abs);
    expect(isPowerShell).toBe(true);
    expect(exe).toBe(abs);
  });
});
