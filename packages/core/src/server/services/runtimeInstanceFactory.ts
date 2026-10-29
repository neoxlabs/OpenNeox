import { AgenticRuntime } from '../../runtime/agenticRuntime.js';
import { normalizeRunMode, type AgentRunMode } from '../../runtime/modeFactory.js';
import { AgentMode } from '@neoxlabs/kernel/core/runner.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { ActionLogService } from '../../platform/actionLog/index.js';
import type { PermissionManager } from '@neoxlabs/kernel/core/permissions/index.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import type { ShortTermMemory } from '@neoxlabs/kernel/memory/shortterm.js';
import type { ApprovalModeResolver } from './approvalModeResolver.js';
import type { RuntimeCheckpointService } from '../../runtime/checkpoint/runtimeCheckpointService.js';

interface CreateRuntimeInstancesOptions {
  config: any;
  baseConfig: any;
  actionLog: ActionLogService;
  approvalModeResolver: ApprovalModeResolver;
  tools: Tool[];
  permissionManager: PermissionManager;
  memory: ShortTermMemory;
  /** 传给 orchestrator, 让它每轮自动建 Shadow Git 文件快照。缺了它整条回滚链是死的。 */
  checkpointService?: RuntimeCheckpointService;
}

interface CreatedRuntimeInstances {
  singleRuntime: AgenticRuntime | null;
  /** assistant 模式已移除; 保留字段恒为 null 以兼容调用方解构, 待清理。 */
  assistantRuntime: null;
  currentMode: AgentRunMode;
}

export function createRuntimeInstances(options: CreateRuntimeInstancesOptions): CreatedRuntimeInstances {
  const {
    config,
    baseConfig,
    actionLog,
    approvalModeResolver,
    checkpointService,
  } = options;

  let singleRuntime: AgenticRuntime | null = null;
  /* assistant 模式已移除 —— 只构造 agentic runtime。 */
  const currentMode: AgentRunMode = normalizeRunMode((config.runMode as AgentRunMode) || 'agentic');

  try {
    singleRuntime = new AgenticRuntime({
      ...baseConfig,
      actionLog,
      agentMode: approvalModeResolver.getGlobalMode() === 'dangerous' ? AgentMode.AUTO : AgentMode.AGENT,
      enableFGTS: config.experimental?.enableFGTS,
      enablePTC: config.experimental?.enablePTC,
      checkpointService,
    });
  } catch (e) {
    cliLogger.error('SERVER', 'Failed to init AgenticRuntime', { error: e });
  }

  return {
    singleRuntime,
    assistantRuntime: null,
    currentMode,
  };
}
