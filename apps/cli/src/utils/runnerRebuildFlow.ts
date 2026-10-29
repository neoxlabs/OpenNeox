import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export async function rebuildAgentAndRunnerFlow(params: {
  hasProviderSettings: boolean;
  reloadBaseTools: () => Promise<void>;
  refreshMcpTools: () => Promise<void>;
  resetMemoryPressureMonitor: () => void;
  sessionEnabled: boolean;
  hasCurrentSession: boolean;
}): Promise<void> {
  const {
    hasProviderSettings,
    reloadBaseTools,
    refreshMcpTools,
    resetMemoryPressureMonitor,
    sessionEnabled,
    hasCurrentSession,
  } = params;

  if (!hasProviderSettings) {
    throw new Error('No provider configured.');
  }

  await reloadBaseTools();
  await refreshMcpTools();
  resetMemoryPressureMonitor();

  if (sessionEnabled && hasCurrentSession) {
    cliLogger.info('MODEL', 'Model switched, server will reload session');
  }

  cliLogger.info('MODEL', 'Agent rebuilt for new model');
}
