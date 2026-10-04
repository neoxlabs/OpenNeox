export interface StorageFileInfo {
  path: string;
  name: string;
  size: number;
  type: 'json' | 'directory' | 'other';
  description: string;
}

export interface CheckpointStorageInfo {
  workspacePath: string;
  workspaceName: string;
  size: number;
  checkpointCount: number;
}

export interface StorageInfo {
  /** Electron userData 目录 — SQLite 库和图片产物在这儿 */
  configDir: string;
  /** ~/.neox — 真正的配置/日志/快照目录 (config.json 在这儿, 不在 configDir) */
  neoxHomeDir?: string;
  totalSize: number;
  files: StorageFileInfo[];
  checkpointTotalSize: number;
  checkpoints: CheckpointStorageInfo[];
}

export interface CheckpointClearResult {
  success: boolean;
  freedSize: number;
  clearedCount?: number;
  error?: string;
}

export interface ConfigFileContent {
  content: string;
  error?: string;
}
