/**
 * PowerShell Detection — 发现并验证系统上的 PowerShell
 *
 * 优先 pwsh (PowerShell Core 7+)，回退 powershell.exe (Windows PowerShell 5.1)
 * 参考 Claude Code: powershellDetection.ts
 */

import { execFileSync } from 'child_process';

let _cachedPath: string | null | undefined;
let _cachedEdition: 'core' | 'desktop' | null | undefined;

// ============================================================================
// PowerShell 路径发现
// ============================================================================

/**
 * 在系统上查找可用的 PowerShell 可执行文件
 *
 * 优先级:
 * 1. pwsh (PowerShell Core 7+) — 跨平台，推荐
 * 2. powershell.exe (Windows PowerShell 5.1) — Windows 内置
 */
export function findPowerShell(): string | null {
  if (_cachedPath !== undefined) return _cachedPath;

  // 尝试 pwsh (PowerShell Core 7+)
  const pwshPath = probePowerShell('pwsh');
  if (pwshPath) {
    _cachedPath = pwshPath;
    return pwshPath;
  }

  // Windows 回退到 powershell.exe
  if (process.platform === 'win32') {
    const psPath = probePowerShell('powershell.exe');
    if (psPath) {
      _cachedPath = psPath;
      return psPath;
    }
  }

  // Linux/macOS 尝试常见安装路径
  const knownPaths = [
    '/opt/microsoft/powershell/7/pwsh',
    '/usr/bin/pwsh',
    '/usr/local/bin/pwsh',
    '/snap/bin/pwsh',
  ];
  for (const p of knownPaths) {
    try {
      execFileSync(p, ['--version'], { timeout: 5000, stdio: 'pipe' });
      _cachedPath = p;
      return p;
    } catch { /* continue */ }
  }

  _cachedPath = null;
  return null;
}

/**
 * 检测 PowerShell 版本 (Core 7+ vs Desktop 5.1)
 *
 * 不启动进程 — 根据可执行文件名推断:
 * - pwsh / pwsh.exe → 'core' (支持 &&, ||, ?:, ??)
 * - powershell / powershell.exe → 'desktop' (无链式操作符)
 */
export function getPowerShellEdition(): 'core' | 'desktop' | null {
  if (_cachedEdition !== undefined) return _cachedEdition;

  const psPath = findPowerShell();
  if (!psPath) {
    _cachedEdition = null;
    return null;
  }

  const basename = psPath.split(/[/\\]/).pop()?.toLowerCase() ?? '';
  if (basename.startsWith('pwsh')) {
    _cachedEdition = 'core';
  } else if (basename.startsWith('powershell')) {
    _cachedEdition = 'desktop';
  } else {
    _cachedEdition = null;
  }
  return _cachedEdition;
}

// ============================================================================
// Windows shell 单一真源 (审计)
// ============================================================================

export interface WindowsShellInfo {
  /** 是否 PowerShell (true) 还是 cmd (false) */
  isPowerShell: boolean;
  /** 实际可执行文件路径 (pwsh / powershell.exe / cmd.exe) */
  shellPath: string;
  /** PowerShell 版本: core=pwsh7+(支持 &&), desktop=5.1(不支持 &&) */
  edition: 'core' | 'desktop' | null;
  /** 命令链式连接 (&& / ||) 是否可用: cmd 可 / pwsh core 可 / powershell desktop 5.1 不可(必须 ;) */
  supportsChaining: boolean;
}

let _cachedWindowsShell: WindowsShellInfo | null | undefined;

/**
 * Windows shell 单一真源 —— 执行端 (buildShellInvocation) 与环境信息注入 (buildEnvironmentInfo) 必须
 * 共用此函数, 保证【告诉 agent 的 shell】==【实际执行的 shell】。
 *
 * Windows defaults to PowerShell only when pwsh (Core 7+) is available;
 * otherwise it falls back to cmd.exe.
 * NEOX_FORCE_CMD=1 强制回 cmd。非 Windows 返回 null。
 *
 * Windows PowerShell 5.1 is not the default because its syntax and startup
 * cost do not match the shell contract; the dedicated PowerShell tool still
 * provides PowerShell semantics.
 */
export function getWindowsShell(): WindowsShellInfo | null {
  if (process.platform !== 'win32') return null;
  if (_cachedWindowsShell !== undefined) return _cachedWindowsShell;
  const forceCmd = process.env.NEOX_FORCE_CMD === '1' || process.env.NEOX_FORCE_CMD === 'true';
  /* 只探 pwsh, 不再用 findPowerShell() —— 它会把 powershell.exe 5.1 当兜底, 5.1 启动 156ms 且
   * 不支持 &&, 当默认 shell 是负收益 (见上方注释)。execute_powershell 工具仍走 findPowerShell,
   * 需要 5.1 语义时它照常可用。 */
  const pwshPath = forceCmd ? null : probePowerShell('pwsh');
  if (pwshPath) {
    _cachedWindowsShell = {
      isPowerShell: true,
      shellPath: pwshPath,
      edition: 'core',
      supportsChaining: true, // pwsh 7+ 支持 &&
    };
  } else {
    _cachedWindowsShell = {
      isPowerShell: false,
      shellPath: process.env.ComSpec || 'cmd.exe',
      edition: null,
      supportsChaining: true, // cmd 支持 &&
    };
  }
  return _cachedWindowsShell;
}

/**
 * PowerShell 工具是否应该启用
 *
 * 条件: Windows 原生 或 环境变量 NEOX_POWERSHELL_TOOL=1
 */
export function isPowerShellToolEnabled(): boolean {
  // 显���启用
  if (process.env.NEOX_POWERSHELL_TOOL === '1' || process.env.NEOX_POWERSHELL_TOOL === 'true') {
    return true;
  }
  // 显式禁用
  if (process.env.NEOX_POWERSHELL_TOOL === '0' || process.env.NEOX_POWERSHELL_TOOL === 'false') {
    return false;
  }
  // Windows 默认启用
  return process.platform === 'win32';
}

/**
 * 重置缓存 (测试用)
 */
export function resetDetectionCache(): void {
  _cachedPath = undefined;
  _cachedEdition = undefined;
  _cachedWindowsShell = undefined;
}

// ============================================================================
// 内部辅助
// ============================================================================

function probePowerShell(name: string): string | null {
  try {
    const result = execFileSync(
      process.platform === 'win32' ? 'where' : 'which',
      [name],
      { timeout: 5000, stdio: 'pipe', encoding: 'utf-8' }
    );
    const path = result.trim().split('\n')[0]?.trim();
    if (path) return path;
  } catch { /* not found */ }
  return null;
}
