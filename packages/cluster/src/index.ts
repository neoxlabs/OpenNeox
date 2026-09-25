/**
 * @openneox/cluster — 集群框架
 *
 * agent loop 作为原子节点 + 确定性调度器。
 * 动态工作流 (含 teamwork) 只是跑在它上面的**模板数据**, 不是硬编码的模式。
 *
 * 单向依赖 neox-core; agentic 行为保持不变 (边界由 __tests__/boundary.test.ts 强制)。
 */

export * from './types.js';
export { computeReadySet, validateGraph, findCycle, topoLayers } from './scheduler/readySet.js';
export { ClusterBudgetTracker } from './scheduler/budget.js';
export type { BudgetOptions } from './scheduler/budget.js';

export const CLUSTER_VERSION = '0.1.0';

export {
  buildSnapshot, emptyTelemetry, renderSnapshotForAgent,
} from './scheduler/telemetry.js';
export type {
  NodeTelemetry, NodeReport, ClusterSnapshot, SnapshotOptions,
  StragglerAlert, SilenceAlert,
} from './scheduler/telemetry.js';
