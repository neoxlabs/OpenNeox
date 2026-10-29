/**
 * PTY-based executor — 用 node-pty 给 subprocess 一个假 TTY。
 * 好处:`npm install` / `docker build` / `cargo build` 这些在非 TTY 下
 * 会关闭彩色 / 进度条的命令,在 PTY 下会正常流式吐 → bash_output 看得到。
 *
 * fallback:
 *   · node-pty 加载失败(测试环境没 rebuild / CI arch 不匹配)→ 返回 null,
 *     调用方继续走 execa 老路径,行为不变。
 *
 * 环境变量开关:
 *   · NEOX_DISABLE_PTY=1 — 强制走 execa 兜底路径(troubleshoot 用)
 */

import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { isPtyEnabled } from '@neoxlabs/platform/runtime/agentRuntimeConfig.js';
import { getWindowsShell } from '../powershell/powershellDetection.js';
import { buildMaybeSandboxedInvocation } from './osSandbox.js';

let cachedPty: any = null;
let cachedStatus: 'ok' | 'failed' | null = null;

function resolvePty(): any | null {
  // 通过 agentRuntimeConfig(env / config / default)判断是否禁用 —— 每次都读, 开关双向生效
  if (!isPtyEnabled()) return null;

  if (cachedStatus === 'ok') return cachedPty;
  if (cachedStatus === 'failed') return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedPty = require('node-pty');
    cachedStatus = 'ok';
    return cachedPty;
  } catch (err: any) {
    cachedStatus = 'failed';
    cliLogger.warn('PTY', `node-pty unavailable, falling back to execa: ${err?.message ?? err}`);
    return null;
  }
}

export function isPtyAvailable(): boolean {
  return resolvePty() !== null;
}

export interface PtyChildProcess {
  pid: number;
  onData: (fn: (data: string) => void) => void;
  onExit: (fn: (e: { exitCode: number; signal?: number }) => void) => void;
  kill: (signal?: string) => void;
  writeInput: (data: string) => void;
}

export interface PtySpawnOptions {
  command: string;
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

/**
 * 通过 PTY spawn 一个命令。拿不到 pty 时返回 null 让调用方 fallback 到 execa。
 */
export function spawnWithPty(opts: PtySpawnOptions): PtyChildProcess | null {
  const pty = resolvePty();
  if (!pty) return null;

  let shell: string;
  let shellArgs: string[];
  let sbCleanup: () => void = () => {};
  if (process.platform === 'win32') {
    const ws = getWindowsShell()!;
    shell = ws.shellPath;
    shellArgs = ws.isPowerShell
      ? ['-NoProfile', '-Command', `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;${opts.command}`]
      : ['/d', '/s', '/c', `chcp 65001>nul & ${opts.command}`];
  } else {
    const sbInv = buildMaybeSandboxedInvocation(opts.command, opts.cwd);
    if (sbInv.sandboxed) {
      shell = sbInv.cmd;
      shellArgs = sbInv.args;
      sbCleanup = sbInv.cleanup;
    } else {
      shell = process.env.SHELL || '/bin/bash';
      shellArgs = ['-lc', opts.command];
    }
  }

  try {
    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 30,
      cwd: opts.cwd,
      env: { ...opts.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });

    return {
      pid: ptyProcess.pid,
      onData: (fn) => ptyProcess.onData(fn),
      onExit: (fn) => ptyProcess.onExit((e: { exitCode: number; signal?: number }) => { sbCleanup(); fn(e); }),
      kill: (signal) => {
        try { ptyProcess.kill(signal); } catch { /* ignore */ }
      },
      writeInput: (data) => {
        try { ptyProcess.write(data); } catch { /* ignore */ }
      },
    };
  } catch (err: any) {
    cliLogger.warn('PTY', `spawn failed: ${err?.message ?? err}, falling back`);
    return null;
  }
}
