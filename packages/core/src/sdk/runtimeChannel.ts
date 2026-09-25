
import { Worker } from 'node:worker_threads';
import { fork, type ChildProcess } from 'node:child_process';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export type RuntimeIsolation = 'worker' | 'process';

/** 适配器只依赖这四个原语 —— 换传输就是换这层实现。 */
export interface RuntimeChannel {
  readonly kind: RuntimeIsolation;
  post(message: unknown): void;
  onMessage(cb: (msg: any) => void): void;
  onError(cb: (err: Error) => void): void;
  onExit(cb: (code: number) => void): void;
  /** 强制结束。worker → terminate(), 子进程 → SIGKILL 进程树。 */
  terminate(): Promise<void>;
}

/** 宿主想要哪种隔离。显式参数 > 环境变量 > 默认 worker。 */
export function resolveRuntimeIsolation(explicit?: RuntimeIsolation): RuntimeIsolation {
  if (explicit) return explicit;
  const raw = (process.env.NEOX_RUNTIME_ISOLATION ?? '').trim().toLowerCase();
  return raw === 'process' ? 'process' : 'worker';
}

export function createWorkerChannel(worker: Worker): RuntimeChannel {
  return {
    kind: 'worker',
    post: (m) => worker.postMessage(m),
    onMessage: (cb) => worker.on('message', cb),
    onError: (cb) => worker.on('error', cb),
    onExit: (cb) => worker.on('exit', cb),
    terminate: async () => { await worker.terminate(); },
  };
}

export interface ChildChannelOptions {
  /** 子进程入口 (runtimeWorkerEntry 的构建产物 —— 它同时兼容两种宿主)。 */
  entryPath: string;
  /** 原本经 workerData 传的初始化数据 —— 子进程走 env, 内容一致。 */
  init: Record<string, unknown>;
  /** 传给子进程的额外 env。 */
  env?: NodeJS.ProcessEnv;
}

export function createChildProcessChannel(options: ChildChannelOptions): RuntimeChannel {
  const child: ChildProcess = fork(options.entryPath, [], {
    /* structured clone —— 跟 worker 的 postMessage 对齐, 否则 Buffer/Date 会变形 */
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      ...options.env,
      /* worker 走 workerData, 子进程没有这个通道 —— 用 env 传同一份 JSON。
       * 子进程入口 (runtimeEndpoint) 认这个键。 */
      NEOX_RUNTIME_INIT: JSON.stringify(options.init ?? {}),
    },
  });

  cliLogger.info('RUNTIME_CHANNEL', `runtime 跑在独立进程 pid=${child.pid} (NEOX_RUNTIME_ISOLATION=process)`);

  return {
    kind: 'process',
    post: (m) => {
      /* 子进程已经死了时 send 会抛 ERR_IPC_CHANNEL_CLOSED —— 咽掉并留痕,
       * 上层的 onExit 会走重建路径, 不该在这里把调用方炸掉。 */
      try { child.send(m as any); }
      catch (err: any) { cliLogger.warn('RUNTIME_CHANNEL', `post 失败 (子进程已退出?): ${err?.message ?? err}`); }
    },
    onMessage: (cb) => child.on('message', cb),
    onError: (cb) => child.on('error', cb),
    onExit: (cb) => child.on('exit', (code) => cb(code ?? 0)),
    terminate: async () => {
      if (child.killed || child.exitCode !== null) return;
      /* 先礼后兵: SIGTERM 给它收尾 (落盘/关句柄), 2s 不走再 SIGKILL。
       * 直接 SIGKILL 会留下写了一半的 sqlite/日志。 */
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 2000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}
