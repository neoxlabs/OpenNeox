import { AgentMode } from '@neoxlabs/kernel/core/runner.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { profileCheckpoint } from '@neoxlabs/platform/utils/startup/profiler.js';

export async function runRuntimeBootstrapPhaseFromMain(params: {
  approvalMode: 'auto' | 'manual' | 'dangerous';
  setCurrentMode: (mode: AgentMode) => void;
  trace: (label: string) => void;
  bootStep: <T>(scope: string, label: string, task: () => Promise<T>) => Promise<T>;
  scheduleDeferredTask: (label: string, timeoutMs: number, task: () => Promise<void>) => void;
  loadBaseTools: () => Promise<void>;
  initMcpTools: () => Promise<void>;
  initializeSkills: () => Promise<void>;
  getSkillCount: () => number;
  setCombinedTools: () => void;
  setupApprovalPrompt: () => void;
  getWorkDir?: () => string;
}): Promise<void> {
  const RUNTIME_CRITICAL_WARN_MS = 2_000;
  const RUNTIME_DEFERRED_TIMEOUT_MS = 4_000;
  const criticalStartedAt = Date.now();
  const criticalSlowTimer = setTimeout(() => {
    params.trace(`runtime critical path slow (> ${RUNTIME_CRITICAL_WARN_MS}ms)`);
  }, RUNTIME_CRITICAL_WARN_MS);
  criticalSlowTimer.unref?.();

  const isDangerous = params.approvalMode === 'dangerous';
  if (isDangerous) {
    params.setCurrentMode(AgentMode.AUTO);
  } else {
    params.setCurrentMode(AgentMode.AGENT);
  }

  try {
    profileCheckpoint('runtime_bootstrap_tools_start');
    params.trace('getTools...');
    await params.bootStep('init', 'getTools', async () => params.loadBaseTools());
    params.trace('getTools done');
    profileCheckpoint('runtime_bootstrap_tools_done');

    params.setCombinedTools();
    params.setupApprovalPrompt();
    profileCheckpoint('runtime_bootstrap_critical_done');
    params.trace(`runtime critical path ready (+${Date.now() - criticalStartedAt}ms)`);
  } finally {
    clearTimeout(criticalSlowTimer);
  }

  const bootstrapMcpTools = async (): Promise<void> => {
    params.trace('loadMcpTools...');
    await params.bootStep('init', 'loadMcpTools', async () => params.initMcpTools());
    params.trace('loadMcpTools done');
    params.setCombinedTools();
  };

  const bootstrapSkills = async (): Promise<void> => {
    params.trace('skillRegistry.initialize...');
    await params.bootStep('init', 'skillRegistry.initialize', async () => params.initializeSkills());
    params.trace('skills done');
    cliLogger.info('CLI', `Skills loaded: ${params.getSkillCount()} skills`);
  };

  const bootstrapAgentTypes = async (): Promise<void> => {
    params.trace('agentTypeRegistry.initialize...');
    try {
      const { agentTypeRegistry } = await import('@neoxlabs/core/runtime/agent/agentTypeRegistry.js');
      await agentTypeRegistry.initialize(params.getWorkDir?.());
      params.trace(`agentTypes done (${agentTypeRegistry.size} types)`);
    } catch (err: any) {
      params.trace(`agentTypes degraded: ${err?.message || String(err)}`);
    }
  };

  params.scheduleDeferredTask('loadMcpTools', RUNTIME_DEFERRED_TIMEOUT_MS, bootstrapMcpTools);
  params.scheduleDeferredTask('skillRegistry.initialize', RUNTIME_DEFERRED_TIMEOUT_MS, bootstrapSkills);
  params.scheduleDeferredTask('agentTypeRegistry.initialize', RUNTIME_DEFERRED_TIMEOUT_MS, bootstrapAgentTypes);
}
