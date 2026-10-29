/**
 * runtimeEndpoint 是 runtime 入口识别启动方式的唯一判据。
 *
 *   runtimeWorkerEntry 同时支持 worker 和独立进程启动：
 *   把这两样收敛到这里: 有 parentPort 就是 worker, 否则就是子进程 (走 process.send /
 *   process.on('message'), 初始化数据从 NEOX_RUNTIME_INIT 读)。
 *
 *   统一入口可确保两种启动方式共享初始化逻辑。
 */

import { parentPort, workerData } from 'node:worker_threads';

export interface RuntimeEndpoint {
  readonly kind: 'worker' | 'process';
  post(message: unknown): void;
  onMessage(cb: (msg: any) => void): void;
  /** 宿主传进来的初始化数据 (workDir / identityDir / deviceFp …)。 */
  readonly init: Record<string, any>;
}

export function resolveRuntimeEndpoint(): RuntimeEndpoint {
  if (parentPort) {
    const port = parentPort;
    return {
      kind: 'worker',
      post: (m) => port.postMessage(m),
      onMessage: (cb) => port.on('message', cb),
      init: (workerData ?? {}) as Record<string, any>,
    };
  }

  if (typeof process.send === 'function') {
    let init: Record<string, any> = {};
    try { init = JSON.parse(process.env.NEOX_RUNTIME_INIT ?? '{}'); }
    catch { init = {}; }
    return {
      kind: 'process',
      post: (m) => { try { process.send!(m as any); } catch { /* 父进程已走, 无处可送 */ } },
      onMessage: (cb) => { process.on('message', cb); },
      init,
    };
  }

  throw new Error('runtime entry 必须作为 worker_thread 或带 IPC 的子进程启动');
}
