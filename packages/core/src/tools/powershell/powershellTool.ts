/**
 * PowerShell Tool — Windows 原生 PowerShell 执行工具
 *
 * 参考 Claude Code: PowerShellTool.tsx
 *
 * 独立于 execute_shell (Bash)，提供:
 * - PowerShell 特定的 prompt / description
 * - PowerShell 安全守卫 (cmdlet 级别)
 * - Git 内部路径保护
 * - 沙箱模式白名单
 * - 破坏性命令警告
 * - pwsh (Core 7+) / powershell.exe (Desktop 5.1) 版本适配
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import type { PlatformLogger, PlatformServices } from '@neoxlabs/platform/platform/services.js';
import type { ProcessManager } from '@neoxlabs/platform/platform/processManager.js';
import type { TerminalExecutor } from '../terminal/executorRegistry.js';
import { markToolFailure as fail } from '@neoxlabs/kernel/core/types/toolResult.js';
import type { ShellOutputStreamPayload } from '../shell/shellWorkerClient.js';
import type { BackgroundTaskCallback } from '../shell/shellUiCallbacks.js';
import { findPowerShell, getPowerShellEdition } from './powershellDetection.js';
import { buildPowerShellToolDescription } from './powershellPrompt.js';
import { validatePowerShellForSandbox, warnPowerShellBackgroundSyntax, preCheckPowerShellCommand } from './powershellGuards.js';
import { analyzePowerShellSecurity } from './powershellSecurity.js';

// ============================================================================
// PowerShell 命令超时表
// ============================================================================

const PS_COMMAND_TIMEOUT_MAP: Record<string, number> = {
  // 快速 (10s)
  'Get-Content': 10_000, 'Get-ChildItem': 10_000, 'Get-Item': 10_000,
  'Get-Location': 10_000, 'Set-Location': 10_000, 'Get-Process': 10_000,
  'Get-Service': 10_000, 'Get-Date': 10_000, 'Get-Host': 10_000,
  'Test-Path': 10_000, 'Write-Output': 10_000, 'Write-Host': 10_000,
  'Get-Member': 10_000, 'Get-Command': 10_000, 'Get-Alias': 10_000,
  'Get-Variable': 10_000, 'Get-History': 10_000,
  // 文件操作 (30s)
  'Set-Content': 30_000, 'New-Item': 30_000, 'Remove-Item': 30_000,
  'Copy-Item': 30_000, 'Move-Item': 30_000, 'Rename-Item': 30_000,
  'Out-File': 30_000, 'Add-Content': 30_000,
  // 搜索 (60s)
  'Select-String': 60_000, 'Where-Object': 60_000, 'ForEach-Object': 60_000,
  // 网络 (60s)
  'Invoke-WebRequest': 60_000, 'Invoke-RestMethod': 60_000,
  'Test-Connection': 60_000, 'Test-NetConnection': 60_000,
  // 启动/进程 (30s)
  'Start-Process': 30_000, 'Stop-Process': 10_000,
  // 压缩 (120s)
  'Compress-Archive': 120_000, 'Expand-Archive': 120_000,
  // 系统信息 (30s)
  'Get-ComputerInfo': 30_000, 'Get-HotFix': 30_000, 'systeminfo': 30_000,
  // 包管理 (300s)
  'Install-Module': 300_000, 'Install-Package': 300_000,
  choco: 300_000, winget: 300_000, scoop: 300_000,
  dotnet: 300_000, nuget: 300_000,
};

function inferPsCommandTimeout(command: string): number {
  const firstToken = command.trim().split(/\s+/)[0];
  if (!firstToken) return 120_000;

  // 直接匹配
  if (PS_COMMAND_TIMEOUT_MAP[firstToken]) return PS_COMMAND_TIMEOUT_MAP[firstToken];

  // 大小写不敏感匹配
  const lower = firstToken.toLowerCase();
  for (const [key, val] of Object.entries(PS_COMMAND_TIMEOUT_MAP)) {
    if (key.toLowerCase() === lower) return val;
  }

  return 120_000;
}

// ============================================================================
// 长运行命令自动检测
// ============================================================================

const PS_LONG_RUNNING_PATTERNS = [
  /\bnpm\s+run\s+(dev|start|serve|watch)\b/,
  /\byarn\s+(dev|start|serve|watch)\b/,
  /\bpnpm\s+(dev|start|serve|watch)\b/,
  /\bdotnet\s+(run|watch)\b/,
  /\biisexpress\b/,
  /\bStart-Process\b.*-NoNewWindow/i,
  /\bwhile\s*\(\s*\$true\s*\)/i,
];

// ============================================================================
// PowerShell 调用构建
// ============================================================================

function buildPowerShellInvocation(command: string): { shell: string; args: string[] } {
  const psPath = findPowerShell();
  if (!psPath) {
    throw new Error('PowerShell not found. Install pwsh (PowerShell Core 7+) or ensure powershell.exe is available.');
  }

  return {
    shell: psPath,
    args: ['-NoProfile', '-NonInteractive', '-Command', command],
  };
}

// ============================================================================
// 工具创建
// ============================================================================

interface CreatePowerShellToolDeps {
  getWorkspaceRoot: () => string;
  getSandboxEnabled: () => boolean;
  getToolLogger: () => PlatformLogger;
  getToolServices: () => PlatformServices;
  getTerminalExecutor: () => TerminalExecutor | null;
  getShellOutputStreamCallback: () => ((payload: ShellOutputStreamPayload) => void) | null;
  getBackgroundTaskCallback: () => BackgroundTaskCallback | null;
  runForegroundShellCommand: (args: {
    command: string;
    workspaceRoot: string;
    shellOption: string | boolean;
    signal?: AbortSignal;
    services: PlatformServices;
    emitShellStream: (payload: {
      output: string;
      outputDelta?: string;
      elapsed: number;
      isComplete?: boolean;
      exitCode?: number;
    }) => void;
    timeoutMs?: number;
  }) => Promise<string>;
  runBackgroundShellCommand: (args: {
    command: string;
    workspaceRoot: string;
    shellOption: string | boolean;
    signal?: AbortSignal;
    services: PlatformServices;
    logger: PlatformLogger;
    getBackgroundTaskCallback: () => BackgroundTaskCallback | null;
  }) => Promise<string>;
}

export function createPowerShellTool({
  getWorkspaceRoot,
  getSandboxEnabled,
  getToolLogger,
  getToolServices,
  getShellOutputStreamCallback,
  getBackgroundTaskCallback,
  runForegroundShellCommand,
  runBackgroundShellCommand,
}: CreatePowerShellToolDeps): Tool {
  const edition = getPowerShellEdition();
  const editionLabel = edition === 'desktop' ? 'Windows PowerShell 5.1' : 'PowerShell Core 7+';

  return {
    name: 'PowerShell',
    description: buildPowerShellToolDescription(),
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The PowerShell command to execute',
        },
        timeout: {
          type: 'number',
          description: 'Optional timeout in milliseconds (max 600000ms / 10 minutes). Auto-inferred from command type if not specified.',
        },
        description: {
          type: 'string',
          description: 'Clear, concise description of what this command does in active voice.',
        },
        run_in_background: {
          type: 'boolean',
          description: 'Set to true to run this command in the background. Use for long-running processes (servers, watchers, installs).',
        },
      },
      required: ['command'],
    },

    async function(
      { command, timeout: _timeout, description: _desc, run_in_background: _bg = false },
      context,
    ) {
      const logger = getToolLogger();
      const services = getToolServices();
      let background = _bg;

      // 1. 检查 PowerShell 可用性
      const psPath = findPowerShell();
      if (!psPath) {
        return fail(`✗ PowerShell 不可用\n\n未在系统上找到 pwsh 或 powershell.exe。\n请安装 PowerShell Core: https://aka.ms/powershell\n\n或使用 execute_shell (Bash) 工具代替。`);
      }

      // 2. 沙箱验证
      const sandboxError = validatePowerShellForSandbox(command, getSandboxEnabled());
      if (sandboxError) return sandboxError;

      // 3. 安全预检查
      const securityResult = analyzePowerShellSecurity(command);
      if (securityResult.behavior === 'deny') {
        return `🚫 PowerShell 命令被拒绝: ${securityResult.reason}`;
      }
      // 'ask' 的情况 — 记录警告但继续 (由权限系统处理)
      if (securityResult.behavior === 'ask') {
        logger.warn('POWERSHELL', `安全警告: ${securityResult.reason} — command: ${command.slice(0, 80)}`);
      }

      // 4. 破坏性命令警告
      const warning = preCheckPowerShellCommand(command);
      if (warning) {
        logger.warn('POWERSHELL', warning);
      }

      const workspaceRoot = getWorkspaceRoot();
      const signal = context?.signal;
      const shellStreamToolId = `ps_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const emitShellStream = (payload: {
        output: string;
        outputDelta?: string;
        elapsed: number;
        isComplete?: boolean;
        exitCode?: number;
      }) => {
        getShellOutputStreamCallback()?.({
          toolId: shellStreamToolId,
          command,
          output: payload.output,
          outputDelta: payload.outputDelta,
          elapsed: payload.elapsed,
          isComplete: payload.isComplete,
          exitCode: payload.exitCode,
        });
      };

      // 5. 后台语法警告
      warnPowerShellBackgroundSyntax(command, background, logger);

      // 6. 自动检测长运行命令
      if (!background && PS_LONG_RUNNING_PATTERNS.some(p => p.test(command))) {
        logger.info('POWERSHELL', `⚡ Auto-promoting to background: "${command.slice(0, 60)}..."`);
        background = true;
      }

      // 7. PowerShell 调用路径 (用 psPath 作为 shellOption)
      const shellOption = psPath;

      // 8. 执行
      if (!background) {
        const MAX_TIMEOUT_MS = 600_000;
        const dynamicTimeout = inferPsCommandTimeout(command);
        const effectiveTimeout = _timeout
          ? Math.min(Math.max(_timeout, 1000), MAX_TIMEOUT_MS)
          : dynamicTimeout;

        logger.info('POWERSHELL', `[${editionLabel}] Timeout: ${effectiveTimeout}ms — ${command.slice(0, 60)}`);

        return runForegroundShellCommand({
          command,
          workspaceRoot,
          shellOption,
          signal,
          services,
          emitShellStream,
          timeoutMs: effectiveTimeout,
        });
      }

      // 后台执行
      return runBackgroundShellCommand({
        command,
        workspaceRoot,
        shellOption,
        signal,
        services,
        logger,
        getBackgroundTaskCallback,
      });
    },
  };
}
