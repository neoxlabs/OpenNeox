import { profileCheckpoint } from '@neoxlabs/platform/utils/startup/profiler.js';

export async function runParallelBootPhaseFromMain(params: {
  trace: (label: string) => void;
  bootStep: <T>(scope: string, label: string, task: () => Promise<T>) => Promise<T>;
  scheduleDeferredTask: (label: string, timeoutMs: number, task: () => Promise<void>) => void;
  preloadShellEnv: () => Promise<void>;
  setActionLogWorkspace: () => Promise<void>;
  initServerConnection: (trace: (label: string) => void) => Promise<void>;
}): Promise<void> {
  const DEFERRED_SHELL_TIMEOUT_MS = 2_000;
  const PARALLEL_SLOW_WARN_MS = 3_500;
  const startedAt = Date.now();
  params.trace('parallel boot start...');
  const slowTimer = setTimeout(() => {
    params.trace(`parallel boot slow (> ${PARALLEL_SLOW_WARN_MS}ms), waiting for critical server init`);
  }, PARALLEL_SLOW_WARN_MS);
  slowTimer.unref?.();

  try {
    const runShellAndActionLog = async (): Promise<void> => {
      try {
        await params.bootStep('init', 'preloadShellEnv', async () => params.preloadShellEnv());
        params.trace('preloadShellEnv done');
      } catch (error: any) {
        params.trace(`preloadShellEnv degraded: ${error?.message || String(error)}`);
      }

      try {
        await params.bootStep('init', 'actionLog.setWorkspace', async () => params.setActionLogWorkspace());
        params.trace('actionLog.setWorkspace done');
      } catch (error: any) {
        params.trace(`actionLog.setWorkspace degraded: ${error?.message || String(error)}`);
      }
    };

    profileCheckpoint('parallel_boot_server_init_start');
    const serverPromise = params.initServerConnection(params.trace);
    params.scheduleDeferredTask(
      'preloadShellEnv+actionLog.setWorkspace',
      DEFERRED_SHELL_TIMEOUT_MS,
      runShellAndActionLog,
    );
    await serverPromise;
    profileCheckpoint('parallel_boot_server_init_done');
  } finally {
    clearTimeout(slowTimer);
  }
  profileCheckpoint('parallel_boot_complete');
  params.trace(`parallel boot done (${Date.now() - startedAt}ms)`);
}
