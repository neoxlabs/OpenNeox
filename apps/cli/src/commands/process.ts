/**
 * Process Command Handlers
 * Handles all process management CLI commands
 */

import prompts from 'prompts';
import { processManager } from '@neoxlabs/platform/platform/processManager.js';
import { formatProcessDuration } from '../utils/index.js';
import { colors } from '../constants.js';
import { cliPrintln } from '../utils/output.js';

/**
 * Process command context (like StatisticCommandContext)
 */
export interface ProcessCommandContext {
  outputLines?: (lines: string[]) => void;
  clearOutputLines?: () => void;
}

function outputToUI(ctx: ProcessCommandContext | undefined, lines: string[]): void {
  if (ctx?.outputLines) {
    // Ink UI: Use commandOutput system
    ctx.outputLines(lines);
  } else {
    // CLI output: Use cliPrintln
    lines.forEach(line => cliPrintln(line));
  }
}

/**
 * Handle /processes or /ps command - display process list
 */
export async function handleProcessesCommand(ctx?: ProcessCommandContext, subCmd?: string): Promise<void> {
  if (ctx?.clearOutputLines) {
    ctx.clearOutputLines();
  }

  // Refresh process status
  processManager.refreshStatus();

  const running = processManager.getBackgroundRunning();

  const lines: string[] = [];

  const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
  lines.push('');
  if (running.length === 0) {
    lines.push(`  ${bold('后台命令')}  ${colors.dim('没有在跑的')}`);
    lines.push(colors.dim('  让模型"放后台跑"就会出现在这里; 运行中也可以在底栏按 tab 查看'));
    lines.push('');
    outputToUI(ctx, lines);
    return;
  }

  lines.push(`  ${bold('后台命令')}  ${colors.dim(`${running.length} 个在跑`)}`);
  running.forEach(proc => {
    const durationStr = formatProcessDuration(Date.now() - proc.startTime.getTime());
    const cmdDisplay = proc.command.length > 60 ? proc.command.substring(0, 59) + '…' : proc.command;
    lines.push(`  ${colors.dim(String(proc.pid).padEnd(7))}${cmdDisplay}  ${colors.dim(durationStr)}`);
  });
  lines.push(colors.dim('  /kill <pid> 结束一个 · /kill all 全部结束'));
  lines.push('');

  outputToUI(ctx, lines);
}

/**
 * Handle /kill command - kill process by PID or kill all
 */
export async function handleKillCommand(ctx?: ProcessCommandContext, pidArg?: string): Promise<void> {
  if (ctx?.clearOutputLines) {
    ctx.clearOutputLines();
  }

  if (!pidArg) {
    const lines = [
      '',
      colors.error('  用法: /kill <pid> 或 /kill all'),
      colors.dim('  使用 /processes 查看运行中的进程'),
      '',
    ];
    outputToUI(ctx, lines);
    return;
  }

  // Refresh process status
  processManager.refreshStatus();

  if (pidArg.toLowerCase() === 'all') {
    // Kill all background processes
    const running = processManager.getBackgroundRunning();
    if (running.length === 0) {
      outputToUI(ctx, ['', colors.info('  没有运行中的后台进程'), '']);
      return;
    }

    const lines: string[] = [];
    lines.push('');
    lines.push(colors.warning(`  即将终止 ${running.length} 个后台进程:`));
    running.forEach(proc => {
      lines.push(colors.dim(`    PID ${proc.pid}: ${proc.command.substring(0, 40)}...`));
    });
    lines.push('');
    outputToUI(ctx, lines);

    const { confirm } = await prompts({
      type: 'confirm',
      name: 'confirm',
      message: '确认终止所有后台进程?',
      initial: false,
    });

    if (confirm) {
      const result = processManager.killAll(true);
      const resultLines = [''];
      resultLines.push(colors.success(`  ✓ 已终止 ${result.killed} 个进程`));
      if (result.failed > 0) {
        resultLines.push(colors.warning(`  ⚠ ${result.failed} 个进程终止失败`));
      }
      resultLines.push('');
      outputToUI(ctx, resultLines);
    } else {
      outputToUI(ctx, [colors.dim('  已取消')]);
    }
    return;
  }

  // Kill specific PID
  const pid = parseInt(pidArg, 10);
  if (isNaN(pid)) {
    outputToUI(ctx, ['', colors.error(`  无效的 PID: ${pidArg}`), '']);
    return;
  }

  const proc = processManager.get(pid);
  if (!proc) {
    // Process may not be in manager, try to kill directly
    try {
      process.kill(pid, 0); // Check if process exists
      outputToUI(ctx, ['', colors.warning(`  PID ${pid} 不在进程管理器中，尝试直接终止...`)]);

      const { confirm } = await prompts({
        type: 'confirm',
        name: 'confirm',
        message: `确认终止 PID ${pid}?`,
        initial: false,
      });

      if (confirm) {
        process.kill(pid, 'SIGTERM');
        outputToUI(ctx, [colors.success(`  ✓ 已发送 SIGTERM 到 PID ${pid}`), '']);
      } else {
        outputToUI(ctx, [colors.dim('  已取消'), '']);
      }
      return;
    } catch {
      outputToUI(ctx, ['', colors.error(`  进程 ${pid} 不存在`), '']);
      return;
    }
  }

  if (proc.status !== 'running') {
    outputToUI(ctx, ['', colors.info(`  进程 ${pid} 已经结束 (状态: ${proc.status})`), '']);
    return;
  }

  const infoLines = [
    '',
    colors.warning(`  即将终止进程:`),
    colors.dim(`    PID: ${proc.pid}`),
    colors.dim(`    命令: ${proc.command}`),
    colors.dim(`    类型: ${proc.background ? '后台' : '同步'}`),
    '',
  ];
  outputToUI(ctx, infoLines);

  const { confirm } = await prompts({
    type: 'confirm',
    name: 'confirm',
    message: '确认终止此进程?',
    initial: false,
  });

  if (confirm) {
    const success = proc.background
      ? processManager.killProcessGroup(pid)
      : processManager.kill(pid, 'SIGTERM', true);

    if (success) {
      outputToUI(ctx, ['', colors.success(`  ✓ 已终止进程 ${pid}`), '']);
    } else {
      outputToUI(ctx, ['', colors.error(`  ✗ 无法终止进程 ${pid}`), '']);
    }
  } else {
    outputToUI(ctx, [colors.dim('  已取消')]);
  }
}
