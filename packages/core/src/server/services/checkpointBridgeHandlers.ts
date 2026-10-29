import type { RuntimeBridge } from '../index.js';
import type { RuntimeCheckpointService } from '../../runtime/checkpoint/runtimeCheckpointService.js';

type CheckpointBridgeMethods = Pick<
  RuntimeBridge,
  | 'startCheckpointWatching'
  | 'stopCheckpointWatching'
  | 'createCheckpoint'
  | 'rollbackToCheckpoint'
  | 'rollbackSingleFile'
  | 'reapplySingleFile'
  | 'revertFile'
  | 'reapplyFile'
  | 'revertHunk'
  | 'rollbackTurn'
  | 'getCheckpoints'
  | 'getCheckpointStats'
  | 'getCheckpointChanges'
  | 'getSessionChanges'
  | 'isFileUnchangedSinceCommit'
  | 'setCheckpointEnabled'
  | 'isCheckpointEnabled'
  | 'cleanupCheckpoints'
>;

interface CreateCheckpointBridgeHandlersOptions {
  checkpointService: RuntimeCheckpointService;
}

export function createCheckpointBridgeHandlers(
  options: CreateCheckpointBridgeHandlersOptions,
): CheckpointBridgeMethods {
  const { checkpointService } = options;

  return {
    async startCheckpointWatching(sessionId) {
      return checkpointService.startMessage(sessionId);
    },

    async stopCheckpointWatching() {
      await checkpointService.stopWatching();
    },

    async createCheckpoint(sessionId, label) {
      return checkpointService.createCheckpoint(sessionId, label);
    },

    async rollbackToCheckpoint(checkpointId) {
      return checkpointService.rollbackToCheckpoint(checkpointId);
    },

    async rollbackSingleFile(filePath, options) {
      return checkpointService.rollbackSingleFile(filePath, options);
    },

    async reapplySingleFile(filePath) {
      return checkpointService.reapplySingleFile(filePath);
    },

    /* ── RollbackService 入口 (EDIT-01) ─────────────────────────────────────
     * 桌面 / CLI / 手机都走这几条, 不再各写一套撤销逻辑。
     * revertFile / reapplyFile 与上面的 rollbackSingleFile / reapplySingleFile
     * 是同一语义 (RollbackService 内部就转发到它们), 新代码用这一组。
     */
    async revertFile(filePath, options) {
      return checkpointService.rollbackSingleFile(filePath, options);
    },

    async reapplyFile(filePath) {
      return checkpointService.reapplySingleFile(filePath);
    },

    async revertHunk(input) {
      return checkpointService.revertHunk(input);
    },

    async rollbackTurn(commit, options) {
      return checkpointService.revertTurn(commit, options);
    },

    async getCheckpoints(limit, sessionId) {
      return checkpointService.getCheckpoints(limit, sessionId);
    },

    async getCheckpointStats() {
      return checkpointService.getStats?.() ?? {
        created: 0,
        modified: 0,
        deleted: 0,
        directories: 0,
        total: 0,
        repositorySize: 0,
        shadowDirSize: 0,
        storageTotalSize: 0,
        checkpointCount: 0,
      };
    },

    async getCheckpointChanges() {
      return checkpointService.getChangeBuffer?.() ?? [];
    },

    async getSessionChanges(sessionId, options) {
      return checkpointService.getSessionChanges(sessionId, options);
    },

    async isFileUnchangedSinceCommit(commitId, filePath) {
      return checkpointService.isFileUnchangedSinceCommit(commitId, filePath);
    },

    setCheckpointEnabled(enabled) {
      checkpointService.setEnabled(enabled);
    },

    isCheckpointEnabled() {
      return checkpointService.isEnabled();
    },

    async cleanupCheckpoints() {
      await checkpointService.cleanup?.();
    },
  };
}
