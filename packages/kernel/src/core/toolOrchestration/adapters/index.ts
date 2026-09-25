/**
 * Adapter barrel —— 现有组件到 orchestrate 接口的包装。
 *
 * 使用模式:
 *   - runner 路径 = PermissionAdapter + GuardrailsAdapter + LoopAdapter
 *                 + ErrorPattern hooks
 *                 (risk 内置在 PermissionManager, 不另挂 RiskAdapter)
 *   - agentLoop 路径 = RiskAdapter + LoopAdapter + ErrorPattern hooks
 *                    (worker/taskagent 无用户审批环节, 不挂 PermissionAdapter)
 */

export { createPermissionAdapter } from './permissionAdapter.js';
export type {
  PermissionManagerLike,
  CreatePermissionAdapterOptions,
} from './permissionAdapter.js';

export { createRiskAdapter } from './riskAdapter.js';
export type {
  EvaluateToolRiskLike,
  CreateRiskAdapterOptions,
} from './riskAdapter.js';

export { createGuardrailsAdapter } from './guardrailsAdapter.js';
export type { CreateGuardrailsAdapterOptions } from './guardrailsAdapter.js';

export { createLoopAdapter } from './loopAdapter.js';

export {
  createErrorPatternSuccessHook,
  createErrorPatternFailureHook,
} from './errorPatternHooks.js';
export type { CreateErrorPatternFailureHookOptions } from './errorPatternHooks.js';
