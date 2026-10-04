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
  | 'getCheckpoints'
  | 'getCheckpointStats'
  | 'getCheckpointChanges'
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

    async rollbackSingleFile(filePath) {
      return checkpointService.rollbackSingleFile(filePath);
    },

    async reapplySingleFile(filePath) {
      return checkpointService.reapplySingleFile(filePath);
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
