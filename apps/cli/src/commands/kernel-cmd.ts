/**
 * /kernel CLI Command — Agent OS 诊断面板
 *
 * 用法：
 *   /kernel — 显示总览
 *   /kernel processes — 显示进程表
 *   /kernel interrupts — 显示中断统计
 *   /kernel scheduler — 显示调度器状态
 *   /kernel bus — 显示消息总线统计
 *   /kernel perception — 显示感知系统统计
 *   /kernel context — 显示上下文虚拟化状态
 *   /kernel cognition — 显示认知系统统计
 */

import chalk from 'chalk';
import { cliPrintln } from '../utils/output.js';

function outputToUI(ctx: { outputLines?: (lines: string[]) => void }, lines: string[]): void {
  if (ctx.outputLines) {
    ctx.outputLines(lines);
  } else {
    lines.forEach(line => cliPrintln(line));
  }
}

export interface KernelCommandContext {
  /** 获取 kernel 诊断数据 */
  getKernelDiagnostics: () => any | null;
  colors: {
    highlight: (s: string) => string;
    info: (s: string) => string;
    dim: (s: string) => string;
    success: (s: string) => string;
    warning: (s: string) => string;
    error: (s: string) => string;
  };
  logInfo: (title: string, detail: string) => void;
  outputLines?: (lines: string[]) => void;
}

export async function handleKernelCommand(ctx: KernelCommandContext, subcommand?: string): Promise<void> {
  const diagnostics = ctx.getKernelDiagnostics();
  const { colors } = ctx;

  if (!diagnostics) {
    ctx.logInfo('Kernel', 'Agent OS Kernel is not active. It will activate on the next session.');
    return;
  }

  const sub = (subcommand || '').trim().toLowerCase();

  switch (sub) {
    case 'process':
    case 'processes':
    case 'ps':
      renderProcesses(ctx, diagnostics);
      break;
    case 'interrupt':
    case 'interrupts':
    case 'int':
      renderInterrupts(ctx, diagnostics);
      break;
    case 'scheduler':
    case 'sched':
      renderScheduler(ctx, diagnostics);
      break;
    case 'bus':
    case 'messagebus':
      renderMessageBus(ctx, diagnostics);
      break;
    case 'perception':
    case 'perc':
      renderPerception(ctx, diagnostics);
      break;
    case 'context':
    case 'ctx':
      renderContext(ctx, diagnostics);
      break;
    case 'cognition':
    case 'cog':
      renderCognition(ctx, diagnostics);
      break;
    default:
      renderOverview(ctx, diagnostics);
      break;
  }
}

// =============================================================================
// Renderers
// =============================================================================

function renderOverview(ctx: KernelCommandContext, diag: any): void {
  const { colors } = ctx;
  const sys = diag.system || {};
  const sched = diag.scheduler || {};
  const bus = diag.messageBus || {};
  const intCtrl = diag.interrupts || {};
  const perc = diag.perception || {};
  const ctxStats = diag.context || {};
  const procs = diag.processes || [];

  const uptimeMs = sys.bootedAt ? Date.now() - sys.bootedAt : 0;
  const uptimeStr = formatUptime(uptimeMs);

  const lines: string[] = [];
  lines.push('');
  lines.push(colors.highlight('  Agent OS Kernel — Dashboard'));
  lines.push('');
  lines.push(colors.dim('  ┌─ System ───────────────────────────────────────┐'));
  lines.push(colors.dim('  │') + `  Uptime:     ${colors.info(uptimeStr)}`);
  lines.push(colors.dim('  │') + `  Ticks:      ${colors.info(String(sys.tickCount || 0))}`);
  lines.push(colors.dim('  │') + `  Processes:  ${colors.info(String(sys.activeProcessCount || 0))} active`);
  lines.push(colors.dim('  │') + `  Shutting:   ${sys.shuttingDown ? colors.warning('Yes') : colors.success('No')}`);
  lines.push(colors.dim('  └──────────────────────────────────────────────────┘'));
  lines.push('');
  lines.push(colors.dim('  ┌─ Scheduler ────────────────────────────────────┐'));
  lines.push(colors.dim('  │') + `  Running:    ${colors.info(String(sched.runningCount || 0))} / ${sched.maxConcurrent || '?'}`);
  lines.push(colors.dim('  │') + `  Ready:      ${colors.info(String(sched.readyCount || 0))}`);
  lines.push(colors.dim('  │') + `  Queues:     RT=${sched.queueCounts?.realtime || 0}  Fair=${sched.queueCounts?.fair || 0}  Batch=${sched.queueCounts?.batch || 0}`);
  lines.push(colors.dim('  │') + `  Scheduled:  ${colors.info(String(sched.totalScheduled || 0))}  Preemptions: ${sched.totalPreemptions || 0}`);
  lines.push(colors.dim('  └──────────────────────────────────────────────────┘'));
  lines.push('');
  lines.push(colors.dim('  ┌─ Interrupts ──────────────────────────────────┐'));
  lines.push(colors.dim('  │') + `  Raised:   ${colors.info(String(intCtrl.raised || 0))}  Handled: ${intCtrl.handled || 0}  Masked: ${intCtrl.masked || 0}  Deferred: ${intCtrl.deferred || 0}`);
  lines.push(colors.dim('  └──────────────────────────────────────────────────┘'));
  lines.push('');
  lines.push(colors.dim('  ┌─ MessageBus ──────────────────────────────────┐'));
  lines.push(colors.dim('  │') + `  Published: ${colors.info(String(bus.published || 0))}  Delivered: ${bus.delivered || 0}  Dead: ${bus.deadLettered || 0}  Dedup: ${bus.deduplicated || 0}`);
  lines.push(colors.dim('  └──────────────────────────────────────────────────┘'));
  lines.push('');
  lines.push(colors.dim('  ┌─ Perception ──────────────────────────────────┐'));
  lines.push(colors.dim('  │') + `  Total:    ${colors.info(String(perc.totalPerceptions || 0))}  Promoted: ${perc.promoted || 0}  Filtered: ${perc.filtered || 0}`);
  lines.push(colors.dim('  └──────────────────────────────────────────────────┘'));
  lines.push('');
  lines.push(colors.dim('  ┌─ Context Virtualizer ────────────────────────┐'));
  lines.push(colors.dim('  │') + `  L0 Hits: ${ctxStats.l0Hits || 0}  L1: ${ctxStats.l1Hits || 0}  L2: ${ctxStats.l2Hits || 0}  L3: ${ctxStats.l3Hits || 0}`);
  lines.push(colors.dim('  │') + `  Evictions: ${ctxStats.evictions || 0}  Promotions: ${ctxStats.promotions || 0}  Demotions: ${ctxStats.demotions || 0}`);
  lines.push(colors.dim('  └──────────────────────────────────────────────────┘'));

  if (procs.length > 0) {
    lines.push('');
    lines.push(colors.dim('  ┌─ Processes ─────────────────────────────────┐'));
    for (const p of procs.slice(0, 8)) {
      const stateIcon = getStateIcon(p.state);
      const pidShort = p.pid.length > 16 ? p.pid.substring(0, 16) + '…' : p.pid;
      const taskShort = (p.task || '').substring(0, 30);
      lines.push(colors.dim('  │') + `  ${stateIcon} ${colors.info(pidShort.padEnd(18))} ${p.role.padEnd(8)} ${taskShort}`);
    }
    if (procs.length > 8) {
      lines.push(colors.dim('  │') + colors.dim(`  ... and ${procs.length - 8} more`));
    }
    lines.push(colors.dim('  └──────────────────────────────────────────────────┘'));
  }

  lines.push('');
  lines.push(colors.dim('  Subcommands: /kernel [ps|int|sched|bus|perc|ctx|cog]'));
  lines.push('');

  outputToUI(ctx, lines);
}

function renderProcesses(ctx: KernelCommandContext, diag: any): void {
  const { colors } = ctx;
  const procs: any[] = diag.processes || [];

  const lines: string[] = [];
  lines.push('');
  lines.push(colors.highlight('  Agent OS — Process Table'));
  lines.push('');

  if (procs.length === 0) {
    lines.push(colors.dim('  No active processes'));
  } else {
    lines.push(colors.dim('  PID                  ROLE        STATE        TASK'));
    lines.push(colors.dim('  ─────────────────────────────────────────────────────────────'));
    for (const p of procs) {
      const stateIcon = getStateIcon(p.state);
      const pid = (p.pid || '').padEnd(20);
      const role = (p.role || '').padEnd(10);
      const state = `${stateIcon} ${(p.state || '').padEnd(10)}`;
      const task = (p.task || '').substring(0, 35);
      lines.push(`  ${colors.info(pid)} ${role} ${state} ${task}`);
    }
  }
  lines.push('');
  outputToUI(ctx, lines);
}

function renderInterrupts(ctx: KernelCommandContext, diag: any): void {
  const { colors } = ctx;
  const stats = diag.interrupts || {};
  const masks = diag.system?.interruptMasks || [];

  const lines: string[] = [];
  lines.push('');
  lines.push(colors.highlight('  Agent OS — Interrupt Controller'));
  lines.push('');
  lines.push(`  Raised:    ${colors.info(String(stats.raised || 0))}`);
  lines.push(`  Handled:   ${colors.info(String(stats.handled || 0))}`);
  lines.push(`  Masked:    ${stats.masked || 0}`);
  lines.push(`  Deferred:  ${stats.deferred || 0}`);

  if (masks.length > 0) {
    lines.push('');
    lines.push(colors.warning('  Active Masks:'));
    for (const m of masks) {
      lines.push(colors.dim(`    Level ${m.level}: ${m.reason} (since ${new Date(m.maskedAt).toLocaleTimeString()})`));
    }
  }

  lines.push('');
  outputToUI(ctx, lines);
}

function renderScheduler(ctx: KernelCommandContext, diag: any): void {
  const { colors } = ctx;
  const sched = diag.scheduler || {};

  const lines: string[] = [];
  lines.push('');
  lines.push(colors.highlight('  Agent OS — Scheduler'));
  lines.push('');
  lines.push(`  Running:      ${colors.info(String(sched.runningCount || 0))} / ${sched.maxConcurrent || '?'}`);
  lines.push(`  Ready Queue:  ${colors.info(String(sched.readyCount || 0))}`);
  lines.push(`  Realtime:     ${sched.queueCounts?.realtime || 0}`);
  lines.push(`  Fair:         ${sched.queueCounts?.fair || 0}`);
  lines.push(`  Batch:        ${sched.queueCounts?.batch || 0}`);
  lines.push('');
  lines.push(`  Total Scheduled:  ${colors.info(String(sched.totalScheduled || 0))}`);
  lines.push(`  Total Preempts:   ${sched.totalPreemptions || 0}`);
  lines.push('');
  outputToUI(ctx, lines);
}

function renderMessageBus(ctx: KernelCommandContext, diag: any): void {
  const { colors } = ctx;
  const bus = diag.messageBus || {};

  const lines: string[] = [];
  lines.push('');
  lines.push(colors.highlight('  Agent OS — Message Bus'));
  lines.push('');
  lines.push(`  Published:    ${colors.info(String(bus.published || 0))}`);
  lines.push(`  Delivered:    ${colors.info(String(bus.delivered || 0))}`);
  lines.push(`  Expired:      ${bus.expired || 0}`);
  lines.push(`  Deduplicated: ${bus.deduplicated || 0}`);
  lines.push(`  Dead Letters: ${bus.deadLettered || 0}`);
  lines.push('');
  outputToUI(ctx, lines);
}

function renderPerception(ctx: KernelCommandContext, diag: any): void {
  const { colors } = ctx;
  const perc = diag.perception || {};

  const lines: string[] = [];
  lines.push('');
  lines.push(colors.highlight('  Agent OS — Perception Manager'));
  lines.push('');
  lines.push(`  Total:     ${colors.info(String(perc.totalPerceptions || 0))}`);
  lines.push(`  Promoted:  ${colors.success(String(perc.promoted || 0))}  (high priority)`);
  lines.push(`  Filtered:  ${colors.dim(String(perc.filtered || 0))}  (low priority)`);

  if (perc.byType && Object.keys(perc.byType).length > 0) {
    lines.push('');
    lines.push(colors.dim('  By Type:'));
    for (const [type, count] of Object.entries(perc.byType)) {
      lines.push(`    ${type.padEnd(15)} ${count}`);
    }
  }

  lines.push('');
  outputToUI(ctx, lines);
}

function renderContext(ctx: KernelCommandContext, diag: any): void {
  const { colors } = ctx;
  const ctxStats = diag.context || {};

  const lines: string[] = [];
  lines.push('');
  lines.push(colors.highlight('  Agent OS — Context Virtualizer'));
  lines.push('');
  lines.push('  Cache Hits:');
  lines.push(`    L0 (Active):   ${colors.info(String(ctxStats.l0Hits || 0))}`);
  lines.push(`    L1 (Hot):      ${ctxStats.l1Hits || 0}`);
  lines.push(`    L2 (Warm):     ${ctxStats.l2Hits || 0}`);
  lines.push(`    L3 (Cold):     ${ctxStats.l3Hits || 0}`);
  lines.push('');
  lines.push('  Operations:');
  lines.push(`    Evictions:     ${ctxStats.evictions || 0}`);
  lines.push(`    Promotions:    ${ctxStats.promotions || 0}`);
  lines.push(`    Demotions:     ${ctxStats.demotions || 0}`);
  lines.push('');
  outputToUI(ctx, lines);
}

function renderCognition(ctx: KernelCommandContext, diag: any): void {
  const { colors } = ctx;
  const cog = diag.cognition || {};

  const lines: string[] = [];
  lines.push('');
  lines.push(colors.highlight('  Agent OS — Cognition Loop'));
  lines.push('');

  if (cog.s1Total !== undefined) {
    lines.push('  System 1 (Fast Rules):');
    lines.push(`    Total:   ${colors.info(String(cog.s1Total || 0))}`);
    lines.push(`    Matched: ${colors.success(String(cog.s1Matched || 0))}`);
    lines.push(`    No Match: ${cog.s1NoMatch || 0}`);
    lines.push('');
    lines.push('  System 2 (Deep Think):');
    lines.push(`    Total:   ${cog.s2Total || 0}`);
    lines.push(`    Success: ${cog.s2Success || 0}`);
    lines.push(`    Errors:  ${cog.s2Error || 0}`);
  } else {
    lines.push(colors.dim('  Cognition loop not yet initialized'));
  }

  lines.push('');
  outputToUI(ctx, lines);
}

// =============================================================================
// Helpers
// =============================================================================

function getStateIcon(state: string): string {
  const icons: Record<string, string> = {
    created: chalk.gray('○'),
    ready: chalk.yellow('●'),
    running: chalk.green('●'),
    streaming: chalk.cyan('●'),
    tool_call: chalk.magenta('●'),
    paused: chalk.gray('●'),
    blocked: chalk.red('●'),
    waiting: chalk.yellow('○'),
    completed: chalk.green('✓'),
    error: chalk.red('✗'),
    zombie: chalk.gray('✗'),
  };
  return icons[state] || chalk.gray('○');
}

function formatUptime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}
