/**
 * bash_output — 读取后台 shell 进程的输出
 *
 * Agent 在收到 <background-task-notification> 后(或主动查看长运行进程)
 * 通过此工具拉取 pid 对应的 stdout/stderr 缓冲。
 *
 * 三种使用模式:
 *   1) 快照模式(默认): 立刻返回当前缓冲区
 *   2) block 模式: 阻塞直到进程退出或 timeout
 *   3) wait_for_pattern 模式: 阻塞直到 stdout 命中 regex 或 timeout(适合等 dev server 启动)
 *
 * 支持 since_line 偏移以便增量读取,避免反复拿到同一段旧输出。
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import type { TrackedProcess, ProcessManager } from '@neoxlabs/platform/platform/processManager.js';
import { getToolServices } from '../runtimeToolServices.js';
import { stripAnsi } from './ansiStrip.js';
import { getBackgroundTaskNotifier } from '../../runtime/shell/backgroundTaskNotifier.js';

interface BashOutputArgs {
  pid: number;
  /** 从第 N 行开始读(0-based)。不传默认从 0 开始,全量读。 */
  since_line?: number;
  /** 读取最多多少行(含),默认 500,上限 5000。 */
  max_lines?: number;
  /** 阻塞模式: 等到进程退出或 timeout。默认 false。 */
  block?: boolean;
  /** 阻塞超时(毫秒)。block 或 wait_for_pattern 启用时生效,默认 30000,上限 600000。 */
  timeout?: number;
  /** 等待 stdout 命中此 regex(JS regex 字符串)再返回。命中或 timeout 都会返回。 */
  wait_for_pattern?: string;
}

const DEFAULT_MAX_LINES = 500;
const HARD_MAX_LINES = 5000;
const DEFAULT_TIMEOUT_MS = 30000;
const HARD_MAX_TIMEOUT_MS = 600000;
const POLL_INTERVAL_MS = 200;
type WaitOutcome = 'exited' | 'pattern_matched' | 'timeout' | 'steered' | 'cancelled';

export const bashOutputTool: Tool = {
  name: 'bash_output',
  description: `Read stdout/stderr buffer of a background shell process started with execute_shell(background=true).

Three modes:
- **Snapshot (default)**: returns current buffer immediately
- **Block** (block=true): waits until the process exits or timeout
- **Wait for pattern** (wait_for_pattern="..."): waits until stdout matches the regex (e.g. "ready on .+localhost") or timeout — perfect for "wait until dev server is up"

Use this when:
- You received a <background-task-notification> tag telling you a pid finished → snapshot mode
- You want to wait for a specific output line (e.g. "Server listening on...") → wait_for_pattern
- You want to block until a finite task truly exits → block=true. Never wait for a dev server to exit; use a snapshot or wait_for_pattern for readiness.

Parameters:
- pid (required): OS process id returned from execute_shell(background=true)
- since_line (optional): read from line N (0-based) instead of the beginning. Use the returned next_line_cursor from a previous call for incremental reading.
- max_lines (optional): cap the number of returned lines (default ${DEFAULT_MAX_LINES}, max ${HARD_MAX_LINES}).
- block (optional): wait until process exits or timeout. Default false.
- timeout (optional): wait timeout in ms (used with block or wait_for_pattern). Default ${DEFAULT_TIMEOUT_MS}, max ${HARD_MAX_TIMEOUT_MS}.
- wait_for_pattern (optional): a JS regex string. Returns when stdout matches.

Returns JSON with: { pid, status, exit_code, total_lines, returned_lines, next_line_cursor, content, wait_outcome? }.

wait_outcome (only present when block or wait_for_pattern was used):
- "exited" — process exited (block mode hit)
- "pattern_matched" — wait_for_pattern matched
- "timeout" — wait timed out, process still running
- "steered" — user inserted a message; observation ended, process left running
- "cancelled" — caller stopped observing, process left running

Note: the process buffer holds the most recent ${HARD_MAX_LINES} output lines. If you care about the very beginning of a long log, capture output early.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true,
  aliases: ['BashOutput', 'bash-output', 'TaskOutput', 'shell_output'],

  parameters: {
    type: 'object',
    properties: {
      pid: {
        type: 'number',
        description: 'The OS process id of the background shell task',
      },
      since_line: {
        type: 'number',
        description: 'Read from line N (0-based). Defaults to 0.',
      },
      max_lines: {
        type: 'number',
        description: `Max lines to return (default ${DEFAULT_MAX_LINES}, hard cap ${HARD_MAX_LINES}).`,
      },
      block: {
        type: 'boolean',
        description: 'Block until the process exits or timeout fires. Default false.',
      },
      timeout: {
        type: 'number',
        description: `Timeout (ms) for block / wait_for_pattern. Default ${DEFAULT_TIMEOUT_MS}, max ${HARD_MAX_TIMEOUT_MS}.`,
      },
      wait_for_pattern: {
        type: 'string',
        description: 'JS regex (string form). Returns as soon as stdout matches it.',
      },
    },
    required: ['pid'],
  },

  async function(args: BashOutputArgs, context): Promise<string> {
    const pid = Number(args?.pid);
    if (!Number.isFinite(pid) || pid <= 0) {
      return JSON.stringify({ error: `Invalid pid: ${args?.pid}` });
    }
    const since = Math.max(0, Math.floor(Number(args?.since_line ?? 0)));
    const requestedCap = Math.floor(Number(args?.max_lines ?? DEFAULT_MAX_LINES));
    const cap = Math.max(1, Math.min(requestedCap || DEFAULT_MAX_LINES, HARD_MAX_LINES));
    const block = args?.block === true;
    const requestedTimeout = Math.floor(Number(args?.timeout ?? DEFAULT_TIMEOUT_MS));
    const timeout = Math.max(0, Math.min(requestedTimeout || DEFAULT_TIMEOUT_MS, HARD_MAX_TIMEOUT_MS));
    const waitPattern = typeof args?.wait_for_pattern === 'string' && args.wait_for_pattern.length > 0
      ? args.wait_for_pattern
      : null;

    const services = getToolServices();
    const pm = services.processManager;
    const proc = pm.get(pid);
    if (!proc) {
      return JSON.stringify({
        pid,
        error: `No tracked process with pid=${pid}. It may have been cleaned up already.`,
      });
    }

    let waitOutcome: WaitOutcome | null = null;

    // 编译 regex(失败直接退化到非 wait 模式)
    let regex: RegExp | null = null;
    if (waitPattern) {
      try {
        regex = new RegExp(waitPattern);
      } catch (err: any) {
        return JSON.stringify({
          pid,
          error: `Invalid wait_for_pattern regex: ${err?.message || String(err)}`,
        });
      }
    }

    // 如果需要等(block / wait_for_pattern), 先看进程是否已经退出 / pattern 已经命中, 再决定 sleep
    if (block || regex) {
      const matched = await waitFor({
        pm,
        proc,
        regex,
        block,
        timeoutMs: timeout,
        signal: context?.signal,
        shouldYieldToSteering: context?.shouldYieldToSteering,
      });
      waitOutcome = matched.outcome;
    }

    // getOutput returns lines joined by \n; split back for indexing
    // 剥 ANSI 给 LLM(PTY 下会有颜色/进度条控制码;UI 原样保留彩色渲染)
    const rawOutput = stripAnsi(pm.getOutput(pid) || '');
    const allLines = rawOutput ? rawOutput.split('\n') : [];
    const totalLines = allLines.length;

    const slice = allLines.slice(since, since + cap);
    const nextCursor = since + slice.length;

    // 重新拿一遍 proc, 因为 wait 期间 status/exit_code 可能更新, 进程也可能已被 setTimeout 清理掉
    const procNow = pm.get(pid) ?? proc;
    if (procNow.status !== 'running') {
      try { getBackgroundTaskNotifier().acknowledgeExit(pid); } catch { /* 通知器不可用不影响读输出 */ }
    }

    const truncatedFromHead = totalLines >= HARD_MAX_LINES && since === 0;
    /* P0-4: 服务治理元信息 — 让 LLM 一眼看出这个 pid 是哪个服务 (有 name/configId/port). */
    const display = pm.snapshotForDisplay(pid);
    const payload: Record<string, unknown> = {
      pid,
      command: procNow.command,
      display_name: display?.display_name,
      config_id: procNow.configId,
      port: procNow.port,
      uptime_sec: display?.uptime_sec,
      status: procNow.status,
      exit_code: procNow.exitCode,
      background: procNow.background,
      total_lines: totalLines,
      returned_lines: slice.length,
      next_line_cursor: nextCursor,
      truncated_from_head: truncatedFromHead,
      content: slice.join('\n'),
    };
    if (waitOutcome) payload.wait_outcome = waitOutcome;
    /* P0-6: services preamble — 状态变化时塞一行进 payload, 给 LLM 全局视图. */
    const preamble = pm.consumeServicesPreambleIfChanged();
    if (preamble) payload.services_status = preamble;
    // 落盘日志路径 — LLM 想看完整(超出 ring buffer 的)输出可以用 readfile 读
    if (procNow.logFilePath) {
      payload.log_file_path = procNow.logFilePath;
      if (truncatedFromHead) {
        payload.hint = `Output truncated to last ${HARD_MAX_LINES} lines. Full log on disk at log_file_path — read with readfile if you need the head.`;
      }
    }

    return JSON.stringify(payload);
  },
};

/**
 * 等进程退出 / pattern 命中 / timeout 三选一.
 *
 * 实现策略:
 *   - 监听 'process:exit' (markCompleted 触发) — 主路径, 准实时
 *   - 同时跑 polling 兜底(应对 PTY 异常退出 + 防 markCompleted 漏发)
 *   - 命中 pattern 用 polling(200ms)读 outputBuffer
 *   - timeout 用 setTimeout
 */
async function waitFor(opts: {
  pm: ProcessManager;
  proc: TrackedProcess;
  regex: RegExp | null;
  block: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  shouldYieldToSteering?: () => boolean;
}): Promise<{ outcome: WaitOutcome }> {
  const { pm, proc, regex, block, timeoutMs, signal, shouldYieldToSteering } = opts;
  if (signal?.aborted) return { outcome: 'cancelled' };
  if (shouldYieldToSteering?.()) return { outcome: 'steered' };

  // 已经退出 → 立刻返回
  if (proc.status !== 'running') {
    return { outcome: 'exited' };
  }
  // 已经匹配 → 立刻返回
  if (regex && checkPattern(pm, proc.pid, regex)) {
    return { outcome: 'pattern_matched' };
  }

  return new Promise((resolve) => {
    let settled = false;

    const settle = (outcome: WaitOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      pm.off('process:exit', onExit);
      signal?.removeEventListener('abort', onAbort);
      resolve({ outcome });
    };

    const onExit = (p: TrackedProcess) => {
      if (p.pid === proc.pid) settle('exited');
    };
    const onAbort = () => settle('cancelled');

    const poller = setInterval(() => {
      if (settled) return;
      if (shouldYieldToSteering?.()) {
        settle('steered');
        return;
      }
      const p = pm.get(proc.pid);
      // 进程已被 cleanup 删掉 → 视为 exited
      if (!p) {
        settle('exited');
        return;
      }
      if (p.status !== 'running') {
        settle('exited');
        return;
      }
      if (regex && checkPattern(pm, proc.pid, regex)) {
        settle('pattern_matched');
      }
    }, POLL_INTERVAL_MS);

    const timer = setTimeout(() => settle('timeout'), timeoutMs);

    if (block) {
      pm.on('process:exit', onExit);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function checkPattern(pm: ProcessManager, pid: number, regex: RegExp): boolean {
  const out = pm.getOutput(pid);
  if (!out) return false;
  return regex.test(stripAnsi(out));
}
