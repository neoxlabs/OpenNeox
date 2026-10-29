/**
 * Connector 子系统 —— 声明式第三方平台接入 (T0)
 *
 *   链路: plugin.json `connector` 块
 *          → validate (安装期挡越权/低报/凭据绕过)
 *          → connectorRegistry (materialize 成 Agent 工具)
 *          → gate (声明 / 授予 / 预算)
 *          → executor (建请求 → 注入凭据 → 发出)
 */

export { connectorRegistry } from './connectorRegistry.js';
export type { RegisteredConnector } from './connectorRegistry.js';

export { validateConnector } from './validate.js';

export { evaluateGate } from './gate.js';
export type { GateContext, GateDecision, GateDenial } from './gate.js';

export { executeCapability } from './executor.js';
export type { ExecuteOptions, ExecuteResult } from './executor.js';

export {
  saveCredential,
  loadCredential,
  deleteCredential,
  hasCredential,
  getConnection,
  setConnection,
  clearConnection,
} from './credentialStore.js';
export type { Credential } from './credentialStore.js';

export {
  grantStore,
  budgetStore,
  setGrants,
  getGrants,
  revokeGrants,
  setBudget,
  getBudgetState,
  newPermissionsSince,
} from './grantStore.js';
export type { GrantStore, BudgetStore } from './grantStore.js';

export {
  interpolatePath,
  interpolateQuery,
  interpolateString,
  interpolateValue,
  MISSING,
} from './template.js';
