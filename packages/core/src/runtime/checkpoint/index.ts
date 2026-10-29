/**
 * Checkpoint 模块导出
 */

export * from './types.js';
export {
  changeSetOfTurn,
  mergeChangeTurns,
  totalsOf,
  EMPTY_CHANGE_SET,
  type ChangeSet,
  type ChangeFile,
  type ChangeTotals,
  type ChangeStatus,
  type ChangeTurn,
} from './changeSet.js';
export { collectSessionChanges, type SessionChanges } from './sessionChanges.js';
export { RollbackService, type RollbackChangeSource } from './rollbackService.js';
export { reconcileSessionChanges, type SessionReconciliation } from './reconcile.js';
export { ShadowGitCheckpoint } from './ShadowGitCheckpoint.js';
export {
  assessCheckpointWorkspace,
  describeUnsafeWorkspace,
  type UnsafeWorkspaceReason,
  type WorkspaceAssessment,
} from './workspaceGuard.js';
export { CheckpointManager, checkpointManager } from './CheckpointManager.js';
export { RuntimeCheckpointService } from './runtimeCheckpointService.js';
