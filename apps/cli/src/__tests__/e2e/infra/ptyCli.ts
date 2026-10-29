import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IPty } from 'node-pty';
import { CLI_COMMAND, CLI_PREFIX_ARGS, REPO_ROOT } from './repo.js';
import type { CliWorkspace } from './workspace.js';
import { printable } from './ansi.js';

export interface PtyCliOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  /** 启动完成的标记; 默认等到输出安静 700ms */
  readyPattern?: RegExp;
  readyTimeoutMs?: number;
}

export interface PtyCli {
  readonly pid: number;
  output(): string;
  mark(): number;
  since(mark: number): string;
  send(text: string): void;
  sendLine(text: string, settleMs?: number): Promise<void>;
  sendEscape(): Promise<void>;
  resize(cols: number, rows: number): void;
  waitFor(pattern: RegExp, opts?: { timeoutMs?: number; from?: number }): Promise<string>;
  waitQuiet(opts?: { quietMs?: number; timeoutMs?: number }): Promise<void>;
  waitExit(timeoutMs?: number): Promise<{ exitCode: number | null; signal: number | null }>;
  alive(): boolean;
  exitCode(): number | null;
  kill(signal?: string): void;
}

const KEY_SEQUENCES = {
  esc: '\x1b',
  enter: '\r',
  ctrlC: '\x03',
  up: '\x1b[A',
  down: '\x1b[B',
  ctrlL: '\x0c',
};

/**
 * 用真实伪终端驱动交互模式 (`neox` 无参数).
 * 断言一律基于去掉 ANSI 后的文本; 宽度检查用 ansi.ts 的 maxLineWidth.
 */
export async function spawnPtyCli(ws: CliWorkspace, opts: PtyCliOptions = {}): Promise<PtyCli> {
  const ptyMod: any = await import('node-pty');
  const spawn = ptyMod.spawn ?? ptyMod.default?.spawn;
  if (typeof spawn !== 'function') throw new Error('node-pty 不可用');

  const env = { ...ws.env, ...(opts.env || {}) };
  const termOptions = {
    name: 'xterm-256color',
    cols: opts.cols ?? 100,
    rows: opts.rows ?? 40,
    cwd: opts.cwd ?? ws.cwd,
    env,
  };

  const doSpawn = (): IPty => spawn(CLI_COMMAND, CLI_PREFIX_ARGS, termOptions);

  let child: IPty;
  try {
    child = doSpawn();
  } catch (err) {
    if (!/posix_spawnp failed/i.test(String((err as Error)?.message))) throw err;
    const helper = join(REPO_ROOT, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    if (!existsSync(helper)) throw err;
    chmodSync(helper, 0o755);
    child = doSpawn();
  }

  let buffer = '';
  let lastDataAt = Date.now();
  let exitInfo: { exitCode: number | null; signal: number | null } | null = null;
  const dataListeners = new Set<() => void>();

  child.onData((data) => {
    buffer += data;
    lastDataAt = Date.now();
    for (const listener of [...dataListeners]) listener();
  });
  child.onExit(({ exitCode, signal }) => {
    exitInfo = { exitCode, signal: signal ?? null };
    lastDataAt = Date.now();
    for (const listener of [...dataListeners]) listener();
  });

  const since = (mark: number): string => buffer.slice(mark);

  const waitFor = (pattern: RegExp, waitOpts: { timeoutMs?: number; from?: number } = {}): Promise<string> => {
    const timeoutMs = waitOpts.timeoutMs ?? 20_000;
    const from = waitOpts.from ?? 0;
    return new Promise<string>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const check = () => {
        const text = since(from);
        const match = pattern.exec(text);
        if (match) { cleanup(); resolve(text); return true; }
        return false;
      };
      const onData = () => { check(); };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        dataListeners.delete(onData);
      };
      if (check()) return;
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`PTY 等 ${pattern} 超时 (${timeoutMs}ms)\n--- 最近输出 ---\n${printable(since(Math.max(0, buffer.length - 4000)))}`));
      }, timeoutMs);
      dataListeners.add(onData);
    });
  };

  const waitQuiet = (waitOpts: { quietMs?: number; timeoutMs?: number } = {}): Promise<void> => {
    const quietMs = waitOpts.quietMs ?? 600;
    const timeoutMs = waitOpts.timeoutMs ?? 20_000;
    const started = Date.now();
    return new Promise<void>((resolve, reject) => {
      const tick = () => {
        if (exitInfo) { resolve(); return; }
        const idleFor = Date.now() - lastDataAt;
        if (idleFor >= quietMs) { resolve(); return; }
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`PTY 等待安静超时 (${timeoutMs}ms)\n--- 最近输出 ---\n${printable(buffer.slice(-4000))}`));
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  };

  const waitExit = (timeoutMs = 20_000): Promise<{ exitCode: number | null; signal: number | null }> => {
    if (exitInfo) return Promise.resolve(exitInfo);
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (exitInfo) { resolve(exitInfo); return; }
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`PTY 等待退出超时 (${timeoutMs}ms)\n--- 最近输出 ---\n${printable(buffer.slice(-4000))}`));
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  };

  const send = (text: string): void => {
    child.write(text);
    lastDataAt = Date.now();
  };

  const sendLine = async (text: string, settleMs = 250): Promise<void> => {
    send(text);
    await new Promise((r) => setTimeout(r, settleMs));
    send('\r');
  };

  const sendEscape = async (): Promise<void> => {
    send(KEY_SEQUENCES.esc);
    await new Promise((r) => setTimeout(r, 80));
  };

  const cli: PtyCli = {
    pid: child.pid,
    output: () => buffer,
    mark: () => buffer.length,
    since,
    send,
    sendLine,
    sendEscape,
    resize: (cols, rows) => {
      child.resize(cols, rows);
      lastDataAt = Date.now();
    },
    waitFor,
    waitQuiet,
    waitExit,
    alive: () => exitInfo === null,
    exitCode: () => exitInfo?.exitCode ?? null,
    kill: (signal = 'SIGTERM') => {
      try { child.kill(signal); } catch { /* already gone */ }
    },
  };

  const readyPattern = opts.readyPattern ?? /neox|Neox|Ask anything|approval/i;
  await waitFor(readyPattern, { timeoutMs: opts.readyTimeoutMs ?? 40_000 });
  await waitQuiet({ quietMs: 1200, timeoutMs: opts.readyTimeoutMs ?? 40_000 });
  if (!cli.alive()) {
    throw new Error(`交互模式启动后立刻退出 (exit=${cli.exitCode()})\n--- 输出 ---\n${printable(buffer)}`);
  }

  /* 启动后的第一个 Enter 会被吞 (early input capture / 首帧动画期间), 不预热的话
   * 第一条真实输入 (尤其模型任务) 停在输入框里不提交. 空 Enter 无副作用. */
  cli.send('\r');
  await cli.waitQuiet({ quietMs: 500, timeoutMs: 10_000 });

  return cli;
}

export { KEY_SEQUENCES };
