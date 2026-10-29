export type FileChangeType =
  | 'create'
  | 'modify'
  | 'delete'
  | 'mkdir'
  | 'rmdir'
  | 'rename';

export interface FileChangeRecord {
  type: FileChangeType;
  path: string;
  timestamp: number;
  previousContent?: string;
  previousPath?: string;
  newContent?: string;
}

export interface FileChangeStats {
  created: number;
  modified: number;
  deleted: number;
  directories: number;
  total: number;
}

export interface FileCheckpointMeta {
  id: string;
  label: string;
  timestamp: number;
  sessionId: string;
  messageIndex: number;
  changes: FileChangeRecord[];
  stats: FileChangeStats;
}

export interface FileCheckpointListItem {
  id: string;
  label: string;
  timestamp: number;
  sessionId: string;
  messageIndex: number;
  stats: FileChangeStats;
}

export interface CheckpointRollbackResult {
  success: boolean;
  restored: string[];
  errors: string[];
  reapplyCheckpointId?: string;
}
