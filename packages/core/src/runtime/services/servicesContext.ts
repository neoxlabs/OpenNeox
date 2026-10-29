/**
 * servicesContext — 拼装"当前服务状态"给 system prompt / tool result preamble.
 *
 * 两个入口:
 *   buildServicesSnapshotForPrompt() — 进 system prompt, 一次性, 会被 prompt cache 缓住.
 *     首次拼装包括 "## Available services" 块 (RunConfig 列表 + 当前运行的进程),
 *     落 sessionServicesSnapshot map 给后续 turn 复用.
 *
 *   buildServicesStatusLine(processManager) — 短一行, tool result preamble 用.
 *     "[services: backend :8088 healthy(2m) · frontend :3000 running(45s) · 1 adhoc]"
 *     每次新鲜算, 工具内做 hash diff 决定要不要塞.
 *
 * 设计原则:
 *   · system prompt 部分稳定不变, 保 cache
 *   · tool preamble 短而精确, 反映当下
 */

import type { ProcessManager } from '@neoxlabs/platform/platform/processManager.js';

const MAX_ADHOC_LINES_IN_PROMPT = 3;
const MAX_TOTAL_LINES = 12;

export function buildServicesSnapshotForPrompt(
  processManager: ProcessManager,
): string {
  const running = processManager.getBackgroundRunning();
  if (running.length === 0) {
    /* 完全空的状态也注一段, 给 LLM 一份"工具语义"指南 — 它得知道 bash_output / bash_kill
     * 是干啥的, 以及 execute_shell(bg=true) 起来的进程是被跟踪的. */
    return [
      '## Running services',
      '',
      'No background processes running. When you `execute_shell(background=true)`',
      'to start a dev server / watcher, the process is auto-tracked:',
      '  · `bash_output(pid)` — tail logs',
      '  · `bash_kill(pid)` — graceful stop (SIGTERM)',
      '  · `service_scan` — list everything (Neox-managed + external)',
      '',
      'Port conflicts (EADDRINUSE) are auto-recovered when the stale pid belongs',
      'to the same command + cwd. External port owners surface as diagnostic info,',
      'NOT auto-killed.',
    ].join('\n');
  }

  const lines: string[] = ['## Running services', ''];
  const configured = running.filter(p => p.configId);
  const adhoc = running.filter(p => !p.configId);

  if (configured.length > 0) {
    lines.push('Configured (bound to RunConfig):');
    for (const p of configured.slice(0, MAX_TOTAL_LINES)) {
      const portPart = p.port ? ` :${p.port}` : '';
      const namePart = p.name ? ` (${p.name})` : '';
      lines.push(`  · pid=${p.pid}${namePart}${portPart} — config=${p.configId}`);
    }
  }
  if (adhoc.length > 0) {
    if (configured.length > 0) lines.push('');
    lines.push('Ad-hoc (anonymous, started via execute_shell bg=true):');
    for (const p of adhoc.slice(0, MAX_ADHOC_LINES_IN_PROMPT)) {
      const portPart = p.port ? ` :${p.port}` : '';
      const cmd = p.command.length > 60 ? p.command.slice(0, 57) + '...' : p.command;
      lines.push(`  · pid=${p.pid}${portPart} — ${cmd}`);
    }
    if (adhoc.length > MAX_ADHOC_LINES_IN_PROMPT) {
      lines.push(`  · (+${adhoc.length - MAX_ADHOC_LINES_IN_PROMPT} more, use service_scan to see all)`);
    }
  }
  lines.push('');
  lines.push('Manage with: `bash_output(pid)` (tail) · `bash_kill(pid)` (stop) · `service_scan` (list).');
  return lines.join('\n');
}

/**
 * 给 tool result preamble 用的一行摘要. 短 (< 200 字符), 信息密集.
 *   [services: backend :8088 healthy(2m) · frontend :3000 running(45s) · 1 adhoc]
 */
export function buildServicesStatusLine(processManager: ProcessManager): string {
  const running = processManager.getBackgroundRunning();
  if (running.length === 0) return '';

  const parts: string[] = [];
  const configured = running.filter(p => p.configId);
  const adhoc = running.filter(p => !p.configId);

  for (const p of configured.slice(0, 5)) {
    const uptimeSec = Math.floor((Date.now() - p.startTime.getTime()) / 1000);
    const uptime = uptimeSec < 60
      ? `${uptimeSec}s`
      : uptimeSec < 3600
        ? `${Math.floor(uptimeSec / 60)}m`
        : `${Math.floor(uptimeSec / 3600)}h${Math.floor((uptimeSec % 3600) / 60)}m`;
    const port = p.port ? ` :${p.port}` : '';
    const label = p.name || p.configId;
    parts.push(`${label}${port}(${uptime})`);
  }
  if (adhoc.length > 0) {
    parts.push(`${adhoc.length} adhoc`);
  }
  return `[services: ${parts.join(' · ')}]`;
}

/** 快速 hash 用于 diff 触发. 不需要密码学强度. */
export function hashServicesState(processManager: ProcessManager): string {
  const running = processManager.getBackgroundRunning();
  /* 仅 hash 影响显示的字段: pid + status + port + name + configId.
   * uptime 在变 (递增), 不进 hash, 否则每次必触发. */
  const sig = running
    .map(p => `${p.pid}|${p.status}|${p.port ?? ''}|${p.name ?? ''}|${p.configId ?? ''}`)
    .sort()
    .join(',');
  let h = 0;
  for (let i = 0; i < sig.length; i++) {
    h = ((h << 5) - h + sig.charCodeAt(i)) | 0;
  }
  return String(h);
}
