
import { execa, type ExecaChildProcess } from 'execa';
import { createRequire } from 'node:module';
import { getShellEnv } from '@neoxlabs/platform/platform/shellEnv.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { isPtyEnabled } from '@neoxlabs/platform/runtime/agentRuntimeConfig.js';
import { processManager } from '@neoxlabs/platform/platform/processManager.js';
import { buildMaybeSandboxedInvocation } from './osSandbox.js';
import { decodeShellChunk } from './winOutputDecode.js';

/* 懒加载 node-pty — 跟 daemon 一样. native binding 缺失时降级 execa */
type IPty = {
  pid?: number;
  cols?: number;
  rows?: number;
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (evt: { exitCode: number }) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
};
type PtyMod = { spawn: (cmd: string, args: string[], opts: any) => IPty };
let cachedPty: PtyMod | null | undefined = undefined;
let ptySpawnBroken = false;

function loadPty(): PtyMod | null {
  if (!isPtyEnabled()) return null;
  if (ptySpawnBroken) return null;
  if (cachedPty !== undefined) return cachedPty;
  try {
    const nodeRequire = createRequire(import.meta.url);
    cachedPty = nodeRequire('node-pty') as PtyMod;
  } catch (err: any) {
    cachedPty = null;
    cliLogger.warn('IN_PROC_SHELL', `node-pty unavailable, falling back to execa: ${err?.message ?? err}`);
  }
  return cachedPty;
}

export const DEFAULT_OUTPUT_CAP_BYTES = 64 * 1024;
/** 头部占比 —— 剩下留给尾部。命令的"我在干什么"在开头, "结果是什么"在结尾, 两头都得留。 */
const HEAD_SHARE = 0.6;
/**
 * 无论如何都要停下来的硬限。改成保尾之后不能一到 cap 就杀进程 (那样永远拿不到尾),
 * 但也不能让 `yes` 这种无限输出把内存吃光 —— 超过这个量直接杀。
 */
const HARD_KILL_BYTES = 16 * 1024 * 1024;

function getOutputCapBytes(): number {
  const env = Number(process.env.NEOX_SHELL_OUTPUT_CAP_BYTES);
  if (Number.isFinite(env) && env >= 1024) return Math.min(8 * 1024 * 1024, Math.floor(env));
  return DEFAULT_OUTPUT_CAP_BYTES;
}
function truncationNotice(label: string, cap: number, total: number): string {
  return `\n[${label} truncated: cap ${cap}B reached, total ${total}B]\n`;
}
/** 中段省略的提示 —— 必须说清丢了多少, 否则模型会把首尾当成完整输出去推理。 */
function middleNotice(dropped: number, total: number): string {
  return `\n… [中间省略 ${dropped}B, 命令共输出 ${total}B —— 已保留开头与结尾] …\n`;
}

// ════════════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════════════

export interface InProcessShellPayload {
  command: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  background?: boolean;
  collectMs?: number;
  cols?: number;
  rows?: number;
}

export interface InProcessShellCallbacks {
  onStarted?: (pid: number) => void;
  onStream?: (chunk: {
    output: string;
    outputDelta: string;
    elapsed: number;
    isComplete: boolean;
    exitCode?: number;
    truncated?: boolean;
  }) => void;
  /** background=true 路径下, 进程真退出时单独通知 (background ack 不算退出). */
  onBackgroundExit?: (pid: number, exitCode: number) => void;
}

export interface InProcessShellResult {
  success: boolean;
  output: string;
  background: boolean;
  pid?: number;
  exitCode?: number;
}

export interface InProcessShellHandle {
  pid?: number;
  result: Promise<InProcessShellResult>;
  kill: () => void;
  writeStdin: (data: string) => boolean;
  resize: (cols: number, rows: number) => boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// 全局 pid → handle 注册表 (替代 daemon 的 socket pid 表)
// ════════════════════════════════════════════════════════════════════════════

const activeHandles = new Map<number, InProcessShellHandle>();

export function sendStdinToInProcessShell(pid: number, data: string): boolean {
  const h = activeHandles.get(pid);
  return h ? h.writeStdin(data) : false;
}
export function resizeInProcessShell(pid: number, cols: number, rows: number): boolean {
  const h = activeHandles.get(pid);
  return h ? h.resize(cols, rows) : false;
}
export function killInProcessShell(pid: number): boolean {
  const h = activeHandles.get(pid);
  if (!h) return false;
  h.kill();
  return true;
}
export function getActiveInProcessShellPids(): number[] {
  return [...activeHandles.keys()];
}

// ════════════════════════════════════════════════════════════════════════════
// 主函数
// ════════════════════════════════════════════════════════════════════════════

export function startInProcessShell(
  payload: InProcessShellPayload,
  callbacks: InProcessShellCallbacks = {},
): InProcessShellHandle {
  const start = Date.now();
  const cap = getOutputCapBytes();
  let outputBuf = '';
  let capped = false;
  let resolved = false;
  /* 超限后继续收集的**尾部滚动窗口**。旧实现一到 cap 就只留开头并杀掉进程,
   * 而 `find | xargs wc -l` 这类命令最有用的 total 恰恰在最后一行 —— 丢的正是答案。 */
  let tailBuf = '';
  let totalBytes = 0;
  const headCap = Math.floor(cap * HEAD_SHARE);
  const tailCap = cap - headCap;

  /** 交给上层的最终输出: 头 + 省略提示 + 尾。没超限时就是原始输出。 */
  const composeOutput = (): string => {
    if (!capped) return outputBuf;
    const dropped = Math.max(0, totalBytes - Buffer.byteLength(outputBuf, 'utf8') - Buffer.byteLength(tailBuf, 'utf8'));
    return outputBuf + middleNotice(dropped, totalBytes) + tailBuf;
  };

  let resolveResult!: (r: InProcessShellResult) => void;
  const resultPromise = new Promise<InProcessShellResult>((res) => { resolveResult = res; });

  const ptyMod = loadPty();
  const useExeca = !ptyMod;

  let ptyProc: IPty | null = null;
  let subprocess: ExecaChildProcess<string> | null = null;
  let pid = 0;

  const killChild = () => {
    if (pid > 0) {
      try { processManager.killProcessGroup(pid, 'SIGTERM', 'user'); } catch {}
    }
    try {
      if (ptyProc) ptyProc.kill('SIGTERM');
      if (subprocess) subprocess.kill('SIGTERM');
    } catch {}
    setTimeout(() => {
      try {
        if (ptyProc) ptyProc.kill('SIGKILL');
        if (subprocess) subprocess.kill('SIGKILL');
      } catch {}
    }, 1500).unref?.();
  };

  const pushStream = (delta: string, isComplete: boolean, exitCode?: number) => {
    const deltaBytes = Buffer.byteLength(delta, 'utf8');
    if (capped) {
      /* 已超限: 头部定格, 继续把输出喂进尾部滚动窗口, 这样命令结束时还能拿到最后几行。
       * 不再往 UI 推 delta (那会刷屏), 但**不杀进程** —— 杀了就永远没有尾。 */
      totalBytes += deltaBytes;
      tailBuf += delta;
      const overflow = Buffer.byteLength(tailBuf, 'utf8') - tailCap;
      if (overflow > 0) tailBuf = tailBuf.slice(Math.ceil(overflow / 2));   /* 粗粒度裁剪, 宁可多留 */
      if (totalBytes > HARD_KILL_BYTES) killChild();                        /* 无限输出的兜底 */
      return;
    }
    totalBytes += deltaBytes;

    if (payload.background && outputBuf.length + deltaBytes > cap) {
      outputBuf = outputBuf.slice(-Math.floor(cap / 2)) + delta;
      callbacks.onStream?.({
        output: outputBuf,
        outputDelta: delta,
        elapsed: Math.floor((Date.now() - start) / 1000),
        isComplete,
        exitCode,
      });
      return;
    }

    if (!payload.background && outputBuf.length + deltaBytes > headCap) {
      const remaining = Math.max(0, headCap - outputBuf.length);
      const headPart = delta.slice(0, remaining);
      outputBuf += headPart;
      outputBuf += truncationNotice('shell stdout/stderr', headCap, totalBytes);
      capped = true;
      tailBuf = delta.slice(remaining);
      callbacks.onStream?.({
        output: outputBuf,
        outputDelta: headPart,
        elapsed: Math.floor((Date.now() - start) / 1000),
        isComplete,
        exitCode,
        truncated: true,
      });
      return;
    }
    outputBuf += delta;
    callbacks.onStream?.({
      output: outputBuf,
      outputDelta: delta,
      elapsed: Math.floor((Date.now() - start) / 1000),
      isComplete,
      exitCode,
    });
  };

  const finishWith = (exitCode: number, error?: any) => {
    if (resolved) return;
    resolved = true;
    pushStream(error ? `[error] ${error?.message ?? error}` : '', true, exitCode);
    resolveResult({
      success: !error && exitCode === 0,
      /* 头 + 省略提示 + 尾 —— 结果行几乎总在最后, 只给开头等于没答案 */
      output: composeOutput(),
      background: false,
      pid,
      exitCode,
    });
    if (pid > 0) activeHandles.delete(pid);
  };

  const sbInv = buildMaybeSandboxedInvocation(payload.command, payload.cwd);

  /* PTY 主路径 */
  if (!useExeca && ptyMod) {
    try {
      ptyProc = ptyMod.spawn(sbInv.cmd, sbInv.args, {
        cwd: payload.cwd,
        env: { ...getShellEnv(), ...(payload.env as Record<string, string>) },
        cols: Math.max(20, ((payload.cols ?? 120) | 0) || 120),
        rows: Math.max(3, ((payload.rows ?? 30) | 0) || 30),
        name: 'xterm-256color',
      });
      pid = ptyProc.pid ?? 0;
      callbacks.onStarted?.(pid);
      ptyProc.onData((data) => pushStream(String(data), false));
      ptyProc.onExit(({ exitCode }) => {
        sbInv.cleanup();
        const code = exitCode ?? 0;
        if (payload.background && resolved) {
          if (pid > 0) {
            callbacks.onBackgroundExit?.(pid, code);
            activeHandles.delete(pid);
          }
        } else {
          finishWith(code);
        }
      });
    } catch (err: any) {
      /* pty 起不来 → 标记判死 + 落回 execa, 不再把整条命令判失败 (见 ptySpawnBroken 注释)。 */
      ptySpawnBroken = true;
      ptyProc = null;
      cliLogger.warn('IN_PROC_SHELL', `pty spawn 失败, 本次及后续改走 execa: ${err?.message ?? err}`);
    }
  }

  if (!ptyProc && sbInv.sandboxed) {
    /* execa fallback (node-pty 不可用) · 沙盒开: spawn 沙盒程序, 不再 shell:true */
    try {
      subprocess = execa(sbInv.cmd, sbInv.args, {
        shell: false,
        cwd: payload.cwd,
        reject: false,
        env: { ...getShellEnv(), ...(payload.env as Record<string, string>) } as any,
        stdio: ['pipe', 'pipe', 'pipe'],
        /* win cmd 分支: 引号原样交给 cmd (见 ShellInvocation.windowsVerbatimArgs) */
        ...(sbInv.windowsVerbatimArgs ? { windowsVerbatimArguments: true } : {}),
      });
      pid = subprocess.pid ?? 0;
      callbacks.onStarted?.(pid);
      subprocess.stdout?.on('data', (d) => pushStream(decodeShellChunk(d), false));
      subprocess.stderr?.on('data', (d) => pushStream(decodeShellChunk(d), false));
      subprocess.on('close', (code) => {
        sbInv.cleanup();
        const c = code ?? 0;
        if (payload.background && resolved) {
          if (pid > 0) {
            callbacks.onBackgroundExit?.(pid, c);
            activeHandles.delete(pid);
          }
        } else {
          finishWith(c);
        }
      });
      subprocess.on('error', (err) => { sbInv.cleanup(); finishWith(-1, err); });
      void subprocess.catch((err: any) => { sbInv.cleanup(); finishWith(-1, err); });
    } catch (err: any) {
      sbInv.cleanup();
      finishWith(-1, err);
      return makeStubHandle(resultPromise);
    }
  } else if (!ptyProc) {
    try {
      subprocess = execa(sbInv.cmd, sbInv.args, {
        shell: false,
        cwd: payload.cwd,
        reject: false,
        env: { ...getShellEnv(), ...(payload.env as Record<string, string>) } as any,
        stdio: ['pipe', 'pipe', 'pipe'],
        /* win cmd 分支: 引号原样交给 cmd (见 ShellInvocation.windowsVerbatimArgs) */
        ...(sbInv.windowsVerbatimArgs ? { windowsVerbatimArguments: true } : {}),
      });
      pid = subprocess.pid ?? 0;
      void subprocess.catch((err: any) => { finishWith(-1, err); });
      callbacks.onStarted?.(pid);
      subprocess.stdout?.on('data', (d) => pushStream(decodeShellChunk(d), false));
      subprocess.stderr?.on('data', (d) => pushStream(decodeShellChunk(d), false));
      subprocess.on('close', (code) => {
        const c = code ?? 0;
        if (payload.background && resolved) {
          if (pid > 0) {
            callbacks.onBackgroundExit?.(pid, c);
            activeHandles.delete(pid);
          }
        } else {
          finishWith(c);
        }
      });
      subprocess.on('error', (err) => finishWith(-1, err));
    } catch (err: any) {
      finishWith(-1, err);
      return makeStubHandle(resultPromise);
    }
  }

  /* background ack — 起来后立刻或延迟 (collectMs) resolve, 进程继续跑 */
  if (payload.background) {
    const ackDelay = Math.max(0, payload.collectMs ?? 0);
    const sendAck = () => {
      if (resolved) return;
      resolved = true;
      resolveResult({
        success: true,
        output: outputBuf,
        background: true,
        pid,
      });
    };
    if (ackDelay === 0) {
      /* 立即 ack 还是稍等一下让 callbacks.onStarted 走完更安全 */
      setTimeout(sendAck, 0).unref?.();
    } else {
      setTimeout(sendAck, ackDelay).unref?.();
    }
  }

  const handle: InProcessShellHandle = {
    pid,
    result: resultPromise,
    kill: killChild,
    writeStdin: (data) => {
      try {
        if (ptyProc) { ptyProc.write(data); return true; }
        if (subprocess?.stdin) { subprocess.stdin.write(data); return true; }
      } catch {}
      return false;
    },
    resize: (cols, rows) => {
      try {
        if (ptyProc) { ptyProc.resize(Math.max(20, cols | 0), Math.max(3, rows | 0)); return true; }
      } catch {}
      return false;
    },
  };
  if (pid > 0) activeHandles.set(pid, handle);
  return handle;
}

function makeStubHandle(resultPromise: Promise<InProcessShellResult>): InProcessShellHandle {
  return {
    pid: undefined,
    result: resultPromise,
    kill: () => {},
    writeStdin: () => false,
    resize: () => false,
  };
}
