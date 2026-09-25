type CheckpointRollbackResult = import('../../ipc.js').CheckpointRollbackResult;
type FileChangeRecord = import('../../ipc.js').FileChangeRecord;
type FileChangeStats = import('../../ipc.js').FileChangeStats;
type FileCheckpointListItem = import('../../ipc.js').FileCheckpointListItem;
type FileCheckpointMeta = import('../../ipc.js').FileCheckpointMeta;

export interface RendererAPICheckpoint {
  // ==================== Checkpoint 系统 (Shadow Git) ====================
  // 启动/停止文件监控
  startCheckpointWatching: (sessionId: string) => Promise<{ success: boolean; beforeCheckpointId?: string | null; error?: string }>;
  stopCheckpointWatching: () => Promise<{ success: boolean; error?: string }>;
  // 创建/回滚 checkpoint
  createFileCheckpoint: (sessionId: string, label?: string) => Promise<{ success: boolean; checkpoint?: FileCheckpointMeta; error?: string }>;
  rollbackToFileCheckpoint: (checkpointId: string) => Promise<CheckpointRollbackResult>;
  // 获取 checkpoint 列表和当前变更
  getFileCheckpoints: (limit?: number, sessionId?: string) => Promise<{ success: boolean; checkpoints: FileCheckpointListItem[]; error?: string }>;
  getCurrentChangeStats: () => Promise<{ success: boolean; stats: FileChangeStats }>;
  getCurrentChanges: () => Promise<{ success: boolean; changes: FileChangeRecord[]; afterCheckpointId?: string | null }>;
  // 开关控制
  setCheckpointEnabled: (enabled: boolean) => Promise<{ success: boolean }>;
  isCheckpointEnabled: () => Promise<{ enabled: boolean }>;
  // 清理
  cleanupFileCheckpoints: () => Promise<{ success: boolean; error?: string }>;
}
