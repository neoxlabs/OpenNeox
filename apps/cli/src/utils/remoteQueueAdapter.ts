import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { RunResponse } from '@neoxlabs/core/server/client-agent/index.js';

type QueuedRunRequest = {
  text: string;
  source: 'remote';
  voice?: boolean;
};

export function enqueueExecutorRunFromMain(params: {
  text: string;
  source: 'remote';
  voice?: boolean;
  remoteInputQueue: QueuedRunRequest[];
  triggerDrain: () => void;
}): RunResponse {
  const trimmed = params.text.trim();
  if (!trimmed) {
    return { ok: false, error: 'Empty input' };
  }
  params.remoteInputQueue.push({ text: trimmed, voice: params.voice, source: params.source });
  const position = params.remoteInputQueue.length;
  params.triggerDrain();
  return { ok: true, queued: position > 1, position };
}

export async function drainRemoteQueueFromMain(params: {
  isActive: () => boolean;
  setActive: (value: boolean) => void;
  getQueue: () => QueuedRunRequest[];
  isTaskRunning: () => boolean;
  processInput: (request: QueuedRunRequest) => Promise<void>;
}): Promise<void> {
  const QUEUE_BLOCK_WARN_INTERVAL_MS = 5_000;

  if (params.isActive()) {
    cliLogger.debug('REMOTE', 'drainRemoteQueue: already active, skipping');
    return;
  }
  params.setActive(true);
  cliLogger.debug(
    'REMOTE',
    `drainRemoteQueue: started, queue length=${params.getQueue().length}, isTaskRunning=${params.isTaskRunning()}`,
  );
  let blockedSince: number | null = null;
  let lastBlockedWarnAt = 0;
  try {
    while (params.getQueue().length > 0) {
      if (params.isTaskRunning()) {
        const now = Date.now();
        if (blockedSince === null) {
          blockedSince = now;
          lastBlockedWarnAt = now;
        }
        if (now - lastBlockedWarnAt >= QUEUE_BLOCK_WARN_INTERVAL_MS) {
          lastBlockedWarnAt = now;
          cliLogger.warn('REMOTE', `drainRemoteQueue: blocked by running task for ${now - blockedSince}ms`, {
            queueLength: params.getQueue().length,
          });
        }
        cliLogger.debug('REMOTE', 'drainRemoteQueue: task running, waiting...');
        await new Promise(resolve => setTimeout(resolve, 200));
        continue;
      }
      if (blockedSince !== null) {
        cliLogger.debug('REMOTE', `drainRemoteQueue: resumed after ${Date.now() - blockedSince}ms blocked`);
        blockedSince = null;
      }
      const next = params.getQueue().shift();
      if (!next) {
        continue;
      }
      cliLogger.debug('REMOTE', `drainRemoteQueue: processing "${next.text.slice(0, 50)}"`);
      await params.processInput(next);
      cliLogger.debug('REMOTE', 'drainRemoteQueue: handleUserInput completed');
    }
  } finally {
    params.setActive(false);
    cliLogger.debug('REMOTE', 'drainRemoteQueue: finished');
  }
}
