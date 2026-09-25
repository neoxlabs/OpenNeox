import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { ensureServer, type ServerConnection } from '@neoxlabs/core/server/processManager.js';
import { NeoxClient } from '@neoxlabs/core/sdk/client.js';
import { RemoteRuntimeAdapter } from '@neoxlabs/core/sdk/remoteRuntimeAdapter.js';
import { LocalRuntimeAdapter } from '@neoxlabs/core/sdk/localRuntimeAdapter.js';
import { WorkerRuntimeAdapter } from '@neoxlabs/core/sdk/workerRuntimeAdapter.js';
import { LocalNeoxClient } from '@neoxlabs/core/sdk/localNeoxClient.js';
import type { RuntimeAdapter } from '@neoxlabs/core/sdk/runtimeAdapter.js';
import type { NeoxConfig } from '@neoxlabs/platform/utils/config.js';
import { getCliEdition } from '../edition/index.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

export type ServerConnectionSetupResult = {
  /* 方案 C: RemoteRuntimeAdapter (daemon) 或 LocalRuntimeAdapter (进程内), 都实现 RuntimeAdapter。 */
  remoteAdapter: RuntimeAdapter;
  sdkClient: NeoxClient;
  serverConnection: ServerConnection | null;
};

export async function connectServerForCliAttemptFromMain(params: {
  userConfig: NeoxConfig;
  workDir: string;
  attempt: number;
  maxRetries: number;
  trace: (label: string) => void;
  bootStep: <T>(scope: string, label: string, task: () => Promise<T>) => Promise<T>;
  logInfo: (message: string, details?: string) => void;
}): Promise<ServerConnectionSetupResult> {
  const remoteServerConfig = params.userConfig.remoteServer;
  if (remoteServerConfig?.url) {
    params.trace(`connecting remote server ${remoteServerConfig.url}`);
    const baseUrl = remoteServerConfig.url.replace(/\/+$/, '');
    const remoteAdapter = new RemoteRuntimeAdapter(baseUrl, remoteServerConfig.token);
    await params.bootStep(
      'init',
      `remoteAdapter.connect(remote:${baseUrl})`,
      async () => remoteAdapter.connect(),
    );
    const sdkClient = new NeoxClient({ baseUrl, token: remoteServerConfig.token });
    cliLogger.info('CLI', `Connected to remote server at ${baseUrl}`);
    params.logInfo('远程连接', `已连接到 ${baseUrl}`);
    return { remoteAdapter, sdkClient, serverConnection: null };
  }

  const remoteAccessOn = !!(params.userConfig as any).remote?.enabled;
  if (process.env.NEOX_USE_DAEMON !== '1' && !remoteAccessOn) {
    const isBunRuntime = typeof process.versions?.bun === 'string';
    const execLower = (process.execPath || '').toLowerCase();
    const isBunDev = execLower.endsWith('/bun') || execLower.endsWith('\\bun.exe') || execLower.endsWith('bun');
    const isBunCompile = isBunRuntime && !isBunDev;
    const isWin = process.platform === 'win32';
    if (isWin && isBunCompile && !process.env.NEOX_SAME_LOOP) {
      process.env.NEOX_SAME_LOOP = '1';
      params.trace('Win bun --compile binary → auto NEOX_SAME_LOOP=1 (LocalRuntimeAdapter)');
      cliLogger.info('CLI', 'Win bun binary: worker spawn unreliable, auto-falling back to in-process runtime');
    }
    const useSameLoop = process.env.NEOX_SAME_LOOP === '1';
    const withTimeout = <T>(p: Promise<T>, ms: number, msg: string): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, rej) => { const t = setTimeout(() => rej(new Error(msg)), ms); t.unref?.(); }),
      ]);
    const deviceFp = getCliEdition().account?.deviceFp() ?? '';
    const idDir = path.join(os.homedir(), NEOX_HOME_DIRNAME);
    const cliWorkerFactory = process.versions.bun
      ? async (workerData: Record<string, unknown>): Promise<Worker> => {
          const mod = await import('../workers/workerPathBun.js');
          return new Worker(mod.default, { workerData });
        }
      : undefined;
    let adapter: LocalRuntimeAdapter | WorkerRuntimeAdapter = useSameLoop
      ? new LocalRuntimeAdapter(params.workDir, idDir, deviceFp)
      : new WorkerRuntimeAdapter(params.workDir, idDir, deviceFp, cliWorkerFactory);
    let actuallySameLoop = useSameLoop;
    params.trace(useSameLoop ? 'in-process same-loop (LocalRuntimeAdapter)' : 'worker thread (WorkerRuntimeAdapter)');
    try {
      await params.bootStep(
        'init',
        useSameLoop ? 'LocalRuntimeAdapter.connect (same-loop)' : 'WorkerRuntimeAdapter.connect (worker thread)',
        async () => withTimeout(adapter.connect(), 8000, 'runtime adapter connect timeout (8s)'),
      );
    } catch (workerErr: any) {
      if (useSameLoop) throw workerErr;
      cliLogger.warn('CLI', `WorkerRuntimeAdapter 启动失败, 回退 in-process: ${workerErr?.message || String(workerErr)}`);
      try { (adapter as WorkerRuntimeAdapter).dispose(); } catch { /* ignore */ }
      adapter = new LocalRuntimeAdapter(params.workDir, idDir, deviceFp);
      actuallySameLoop = true;
      await params.bootStep('init', 'LocalRuntimeAdapter.connect (fallback after worker fail)', async () => adapter.connect());
    }
    const localSdkClient = new LocalNeoxClient(() => (adapter as { getBridge(): any }).getBridge());
    /* 不向用户暴露任何技术字眼 (商业化无感), 仅写日志供排查。 */
    cliLogger.info('CLI', actuallySameLoop
      ? 'Agent running in-process (same event loop, no daemon)'
      : 'Agent running in worker thread (isolated event loop, no daemon)');
    return { remoteAdapter: adapter, sdkClient: localSdkClient, serverConnection: null };
  }

  params.trace(`ensureServer (attempt ${params.attempt}/${params.maxRetries})`);
  const serverConnection = await params.bootStep(
    'init',
    `ensureServer(attempt ${params.attempt})`,
    async () => ensureServer(params.workDir),
  );
  params.trace(`ensureServer done, port=${serverConnection.port}`);
  const localToken = serverConnection.authToken || undefined;
  const remoteAdapter = new RemoteRuntimeAdapter(serverConnection.baseUrl, localToken);
  await params.bootStep(
    'init',
    `remoteAdapter.connect(local:${serverConnection.baseUrl})`,
    async () => remoteAdapter.connect(),
  );
  params.trace('remoteAdapter connected');
  const sdkClient = new NeoxClient({ baseUrl: serverConnection.baseUrl, token: localToken });
  cliLogger.info('CLI', `Connected to server at ${serverConnection.baseUrl}`);
  return { remoteAdapter, sdkClient, serverConnection };
}

export function registerRuntimeEventForwardingFromMain(params: {
  remoteAdapter: RuntimeAdapter;
  runtimeHandler: (event: any) => void;
  handleRemoteApprovalEvent: (event: any) => void;
  handleRemoteApprovalCancelledEvent: (event: any) => void;
  handleRemoteAskUserEvent: (event: any) => void;
}): void {
  params.remoteAdapter.onEvent((event) => {
    const incoming = event as any;
    if (incoming?.type === 'approval_needed') {
      params.handleRemoteApprovalEvent(incoming);
      return;
    }
    if (incoming?.type === 'approval_cancelled') {
      params.handleRemoteApprovalCancelledEvent(incoming);
      return;
    }
    if (incoming?.type === 'ask_user_needed') {
      params.handleRemoteAskUserEvent(incoming);
      return;
    }
    params.runtimeHandler(event);
  });
}
