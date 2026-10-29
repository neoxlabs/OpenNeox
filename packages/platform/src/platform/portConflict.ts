/**
 * portConflict — 启动 bg 进程后, 进程秒退且输出含 EADDRINUSE 时, 自动诊断 + 自愈.
 *
 * 决策树 (全部在工具内部, LLM 不感知):
 *   1. 解析 error msg / output 提取被占的 port
 *   2. 查 ProcessManager.findByPort(port) — Neox 跟踪的占用者
 *      ├─ 同 cwd + 同 command 的旧 pid (zombie / 没清干净) → kill 并 retry
 *      ├─ 同 workspace 内别的 Neox 服务 → 不动它, 返回 conflict-other-neox-service
 *      └─ 没找到 → 走 3
 *   3. 用 lsof / ss 查外部进程占用
 *      ├─ 找到 → 返回 conflict-external (附 pid+cmd+user 信息给 LLM)
 *      └─ 没找到 → port 已释放但仍 EADDRINUSE (罕见 race), 返回 conflict-stale
 */

import { execa } from 'execa';
import type { ProcessManager } from './processManager.js';

const EADDR_PATTERNS = [
  /EADDRINUSE/i,
  /address already in use/i,
  /port.*in use/i,
  /listen.*EADDRINUSE/i,
];

/** 判断输出里有没有"端口被占"信号. 不仅匹配 EADDRINUSE, 也匹配中文 / 各 framework 自定义文案 */
export function detectEAddrInUse(output: string): boolean {
  if (!output) return false;
  return EADDR_PATTERNS.some(p => p.test(output));
}

/** 从输出里抽出被占的端口号. 找不到返 undefined. */
export function extractConflictPort(output: string): number | undefined {
  if (!output) return undefined;

  // pattern 1: EADDRINUSE: address already in use :::3000
  // pattern 2: EADDRINUSE: address already in use 0.0.0.0:8088
  // pattern 3: bind: address already in use (port 3000)
  // pattern 4: port 3000 is already in use
  // pattern 5: listen EADDRINUSE 127.0.0.1:3000
  const candidates: RegExp[] = [
    /EADDRINUSE[^]*?:(\d{2,5})\b/i,
    /address already in use[^]*?[:\(]\s*(?:port\s+)?(\d{2,5})\b/i,
    /port[\s:]+(\d{2,5})[^]*?in use/i,
    /:(\d{2,5})\b[^]*?already in use/i,
  ];
  for (const re of candidates) {
    const m = output.match(re);
    if (m) {
      const port = parseInt(m[1], 10);
      if (port > 0 && port < 65536) return port;
    }
  }
  return undefined;
}

/** 用 lsof 查谁在监听某端口 (跨 Neox 之外). 返回 { pid, command } 或 undefined. */
export async function findExternalPortOwner(port: number): Promise<{ pid: number; command: string } | undefined> {
  // macOS / Linux: lsof -nP -iTCP:<port> -sTCP:LISTEN -F pc
  try {
    const result = await execa('lsof', [
      '-nP',
      `-iTCP:${port}`,
      '-sTCP:LISTEN',
      '-F', 'pc',
    ], { timeout: 1500, reject: false });
    if (result.exitCode === 0 && result.stdout) {
      /* -F pc 输出:
       *   p12345
       *   cnode
       * 一个进程一组. 取第一组. */
      let pid: number | undefined;
      let command: string | undefined;
      for (const line of result.stdout.split('\n')) {
        if (line.startsWith('p')) {
          pid = parseInt(line.slice(1), 10);
        } else if (line.startsWith('c') && command === undefined) {
          command = line.slice(1);
        }
        if (pid !== undefined && command !== undefined) break;
      }
      if (pid !== undefined && command !== undefined) return { pid, command };
    }
  } catch {
    /* lsof 不可用, 走 ss fallback */
  }

  if (process.platform === 'linux') {
    try {
      const result = await execa('ss', ['-tlnp', `sport = :${port}`], {
        timeout: 1500, reject: false,
      });
      if (result.exitCode === 0 && result.stdout) {
        // 行: LISTEN ... users:(("node",pid=12345,fd=20))
        const m = result.stdout.match(/users:\(\("([^"]+)",pid=(\d+)/);
        if (m) return { pid: parseInt(m[2], 10), command: m[1] };
      }
    } catch { /* skip */ }
  }
  return undefined;
}

/** 端口冲突诊断结果. 一律包含 port, 其它字段表示如何处理. */
export type ConflictDiagnosis =
  | { kind: 'no-conflict' }
  | { kind: 'same-cmd-cwd-zombie'; port: number; staleId: number; staleCommand: string }
  | { kind: 'other-neox-service'; port: number; ownerPid: number; ownerCommand: string; ownerConfigId?: string; ownerName?: string }
  | { kind: 'external'; port: number; ownerPid: number; ownerCommand: string }
  | { kind: 'stale-no-owner'; port: number };

export async function diagnosePortConflict(
  processManager: ProcessManager,
  port: number,
  intendedCommand: string,
  intendedCwd: string,
): Promise<ConflictDiagnosis> {
  /* 1) Neox 自己跟踪的进程里看 */
  const tracked = processManager.findByPort(port);
  if (tracked) {
    const sameCmdCwd = tracked.command.trim().replace(/\s+/g, ' ')
      === intendedCommand.trim().replace(/\s+/g, ' ')
      && tracked.cwd.replace(/\/+$/, '') === intendedCwd.replace(/\/+$/, '');
    if (sameCmdCwd) {
      return {
        kind: 'same-cmd-cwd-zombie',
        port,
        staleId: tracked.pid,
        staleCommand: tracked.command,
      };
    }
    return {
      kind: 'other-neox-service',
      port,
      ownerPid: tracked.pid,
      ownerCommand: tracked.command,
      ownerConfigId: tracked.configId,
      ownerName: tracked.name,
    };
  }

  /* 2) 外部进程? */
  const ext = await findExternalPortOwner(port);
  if (ext) {
    return {
      kind: 'external',
      port,
      ownerPid: ext.pid,
      ownerCommand: ext.command,
    };
  }

  /* 3) port 已释放但 EADDRINUSE 信号还在 (race / OS TIME_WAIT) */
  return { kind: 'stale-no-owner', port };
}

/** 把诊断转成给 LLM 看的明确说明 (短 / 可操作). */
export function formatConflictDiagnosis(d: ConflictDiagnosis, intendedCommand: string): string {
  if (d.kind === 'no-conflict') return '';
  const lines: string[] = [`Port ${('port' in d) ? d.port : '?'} conflict detected:`];
  switch (d.kind) {
    case 'same-cmd-cwd-zombie':
      lines.push(
        `  · Same command + cwd, stale pid=${d.staleId} (likely leftover from previous run)`,
        `  · Auto-killed and retried — see new pid above.`,
      );
      break;
    case 'other-neox-service':
      lines.push(
        `  · Port held by pid=${d.ownerPid}${d.ownerName ? ` (${d.ownerName})` : ''} — another Neox-managed service`,
        `    command: ${d.ownerCommand.slice(0, 80)}${d.ownerCommand.length > 80 ? '...' : ''}`,
        `    config:  ${d.ownerConfigId ?? '(ad-hoc, no RunConfig)'}`,
        `  · NOT auto-killed (different workspace / service). Options:`,
        `    1. bash_kill(pid=${d.ownerPid}) and re-run`,
        `    2. Run on a different port (e.g. PORT=3001 ${intendedCommand.slice(0, 40)}...)`,
      );
      break;
    case 'external':
      lines.push(
        `  · Port held by pid=${d.ownerPid} (process: ${d.ownerCommand}) — external, NOT Neox-managed`,
        `  · Will NOT auto-kill an external process.`,
        `  · Tell the user: pid=${d.ownerPid} (${d.ownerCommand}) is using port ${d.port}.`,
        `    They can close it themselves, or run on a different port.`,
      );
      break;
    case 'stale-no-owner':
      lines.push(
        `  · No process found holding port ${d.port} (likely OS TIME_WAIT or race).`,
        `  · Wait a few seconds and retry, or use a different port.`,
      );
      break;
  }
  return lines.join('\n');
}
