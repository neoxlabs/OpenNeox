/**
 * Process Command Handlers
 * Handles all process management CLI commands
 */

import prompts from 'prompts';
import { processManager } from '@neoxlabs/platform/platform/processManager.js';
import { formatProcessDuration } from '../utils/index.js';
import { colors } from '../constants.js';
import { cliPrintln } from '../utils/output.js';
import { L } from '../i18n/index.js';

/**
 * Process command context (like StatisticCommandContext)
 */
export interface ProcessCommandContext {
  outputLines?: (lines: string[]) => void;
  clearOutputLines?: () => void;
  /** 界面里的确认菜单。prompts() 跟 Ink 抢 stdin, 提示画不出来, 等于 /kill 永远被当取消 */
  promptSelect?: (question: string, choices: Array<{ label: string; value: string; description?: string }>, defaultValue?: string) => Promise<string>;
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

/** 确认: 有界面菜单走菜单, 没有 (纯命令行) 才用 prompts */
async function confirmKill(ctx: ProcessCommandContext | undefined, message: string): Promise<boolean> {
  if (ctx?.promptSelect) {
    try {
      const choice = await ctx.promptSelect(message, [
        { label: L('取消', 'Cancel'), value: 'no' },
        { label: L('终止', 'Kill'), value: 'yes' },
      ], 'no');
      return choice === 'yes';
    } catch {
      return false;
    }
  }
  const { confirm } = await prompts({ type: 'confirm', name: 'confirm', message, initial: false });
  return !!confirm;
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
  const title = bold(L('后台命令', 'Background commands'));
  lines.push('');
  if (running.length === 0) {
    lines.push(`  ${title}  ${colors.dim(L('没有在跑的', 'none running'))}`);
    lines.push(colors.dim(L('  让模型"放后台跑"就会出现在这里; 运行中也可以在底栏按 tab 查看',
      '  Anything the model runs in the background shows up here; while it runs, tab in the bottom bar shows it too')));
    lines.push('');
    outputToUI(ctx, lines);
    return;
  }

  lines.push(`  ${title}  ${colors.dim(L(`${running.length} 个在跑`, `${running.length} running`))}`);
  running.forEach(proc => {
    const durationStr = formatProcessDuration(Date.now() - proc.startTime.getTime());
    const cmdDisplay = proc.command.length > 60 ? proc.command.substring(0, 59) + '…' : proc.command;
    lines.push(`  ${colors.dim(String(proc.pid).padEnd(7))}${cmdDisplay}  ${colors.dim(durationStr)}`);
  });
  lines.push(colors.dim(L('  /kill <pid> 结束一个 · /kill all 全部结束', '  /kill <pid> stops one · /kill all stops all')));
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
      colors.error(L('  用法: /kill <pid> 或 /kill all', '  Usage: /kill <pid> or /kill all')),
      colors.dim(L('  /ps 查看在跑的后台命令', '  /ps lists running background commands')),
      '',
    ];
    outputToUI(ctx, lines);
    return;
  }

  // Refresh process status
  processManager.refreshStatus();

  const cancelled = () => outputToUI(ctx, [colors.dim(L('  已取消', '  Cancelled')), '']);

  if (pidArg.toLowerCase() === 'all') {
    // Kill all background processes
    const running = processManager.getBackgroundRunning();
    if (running.length === 0) {
      outputToUI(ctx, ['', colors.info(L('  没有运行中的后台进程', '  No background processes running')), '']);
      return;
    }

    const lines: string[] = [];
    lines.push('');
    lines.push(colors.warning(L(`  即将终止 ${running.length} 个后台进程:`, `  About to stop ${running.length} background processes:`)));
    running.forEach(proc => {
      lines.push(colors.dim(`    PID ${proc.pid}: ${proc.command.substring(0, 40)}...`));
    });
    lines.push('');
    outputToUI(ctx, lines);

    if (await confirmKill(ctx, L('确认终止所有后台进程?', 'Stop all background processes?'))) {
      const result = processManager.killAll(true);
      const resultLines = [''];
      resultLines.push(colors.success(L(`  ✓ 已终止 ${result.killed} 个进程`, `  ✓ ${result.killed} stopped`)));
      if (result.failed > 0) {
        resultLines.push(colors.warning(L(`  ⚠ ${result.failed} 个进程终止失败`, `  ⚠ ${result.failed} couldn’t be stopped`)));
      }
      resultLines.push('');
      outputToUI(ctx, resultLines);
    } else {
      cancelled();
    }
    return;
  }

  // Kill specific PID
  const pid = parseInt(pidArg, 10);
  if (isNaN(pid)) {
    outputToUI(ctx, ['', colors.error(`  ${L('无效的 PID', 'Invalid PID')}: ${pidArg}`), '']);
    return;
  }

  const proc = processManager.get(pid);
  if (!proc) {
    // Process may not be in manager, try to kill directly
    try {
      process.kill(pid, 0); // Check if process exists
      outputToUI(ctx, ['', colors.warning(L(`  PID ${pid} 不在进程管理器中，尝试直接终止...`, `  PID ${pid} isn’t one of ours — trying to stop it directly...`))]);

      if (await confirmKill(ctx, L(`确认终止 PID ${pid}?`, `Stop PID ${pid}?`))) {
        process.kill(pid, 'SIGTERM');
        outputToUI(ctx, [colors.success(L(`  ✓ 已发送 SIGTERM 到 PID ${pid}`, `  ✓ Sent SIGTERM to PID ${pid}`)), '']);
      } else {
        cancelled();
      }
      return;
    } catch {
      outputToUI(ctx, ['', colors.error(L(`  进程 ${pid} 不存在`, `  Process ${pid} doesn’t exist`)), '']);
      return;
    }
  }

  if (proc.status !== 'running') {
    outputToUI(ctx, ['', colors.info(L(`  进程 ${pid} 已经结束 (状态: ${proc.status})`, `  Process ${pid} already ended (${proc.status})`)), '']);
    return;
  }

  const infoLines = [
    '',
    colors.warning(L('  即将终止进程:', '  About to stop:')),
    colors.dim(`    PID: ${proc.pid}`),
    colors.dim(`    ${L('命令', 'Command')}: ${proc.command}`),
    colors.dim(`    ${L('类型', 'Type')}: ${proc.background ? L('后台', 'background') : L('同步', 'foreground')}`),
    '',
  ];
  outputToUI(ctx, infoLines);

  if (await confirmKill(ctx, L('确认终止此进程?', 'Stop this process?'))) {
    const success = proc.background
      ? processManager.killProcessGroup(pid)
      : processManager.kill(pid, 'SIGTERM', true);

    if (success) {
      outputToUI(ctx, ['', colors.success(L(`  ✓ 已终止进程 ${pid}`, `  ✓ Stopped ${pid}`)), '']);
    } else {
      outputToUI(ctx, ['', colors.error(L(`  ✗ 无法终止进程 ${pid}`, `  ✗ Couldn’t stop ${pid}`)), '']);
    }
  } else {
    cancelled();
  }
}
