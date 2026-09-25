import type {
  CheckpointMeta,
  CheckpointListItem,
  ChangeStats,
  FileChange,
} from './types.js';
import { CheckpointManager } from './CheckpointManager.js';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export class RuntimeCheckpointService {
  private checkpointManager: CheckpointManager;
  private workspacePath: string | null = null;
  private enabled = true;
  private sessionMessageCounts: Map<string, number> = new Map();

  constructor(checkpointManager?: CheckpointManager) {
    this.checkpointManager = checkpointManager ?? CheckpointManager.getInstance();
  }

  setWorkspace(workspacePath: string | null): void {
    this.workspacePath = workspacePath;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    try {
      const live = loadConfig().experimental?.enableCheckpoint;
      if (typeof live === 'boolean') return live;
    } catch { /* fallback */ }
    return this.enabled;
  }

  async startMessage(sessionId: string): Promise<string | null> {
    /* 静默 no-op 是这套系统最贵的坑 —— 曾经因为一个没传的构造参数, 整条文件回滚链
     * 死了 9 天而日志里一个字都没有。每个 return null 的分支都必须留痕。 */
    if (!this.isEnabled()) {
      cliLogger.debug('CHECKPOINT', 'startMessage skipped: disabled (experimental.enableCheckpoint)');
      return null;
    }
    if (!this.workspacePath) {
      cliLogger.warn('CHECKPOINT', 'startMessage skipped: workspace 未设置 — 文件回滚不可用');
      return null;
    }
    // git 没装 → 优雅 no-op (不抛错刷屏), 缓存检测只首条消息跑一次
    if (!(await CheckpointManager.isGitAvailable())) {
      return null;
    }
    const messageIndex = this.sessionMessageCounts.get(sessionId) || 0;
    const id = await this.checkpointManager.startWatching(this.workspacePath, sessionId, messageIndex);
    cliLogger.info('CHECKPOINT', `startMessage session=${sessionId} idx=${messageIndex} before=${id ?? 'null'}`);
    return id;
  }

  async finishMessage(sessionId: string, label?: string): Promise<CheckpointMeta | null> {
    if (!this.isEnabled() || !this.workspacePath) {
      return null;
    }
    const checkpoint = await this.createCheckpoint(sessionId, label);
    await this.checkpointManager.stopWatching(this.workspacePath);
    return checkpoint;
  }

  async stopWatching(): Promise<void> {
    if (!this.workspacePath) {
      return;
    }
    await this.checkpointManager.stopWatching(this.workspacePath);
  }

  async createCheckpoint(sessionId: string, label?: string): Promise<CheckpointMeta | null> {
    if (!this.isEnabled()) {
      cliLogger.debug('CHECKPOINT', 'createCheckpoint skipped: disabled');
      return null;
    }
    if (!this.workspacePath) {
      cliLogger.warn('CHECKPOINT', 'createCheckpoint skipped: workspace 未设置');
      return null;
    }
    if (!(await CheckpointManager.isGitAvailable())) {
      return null;
    }
    const messageIndex = this.sessionMessageCounts.get(sessionId) || 0;
    const checkpointLabel = label || `Message #${messageIndex + 1}`;
    const checkpoint = await this.checkpointManager.createCheckpoint(
      this.workspacePath,
      checkpointLabel
    );
    this.sessionMessageCounts.set(sessionId, messageIndex + 1);
    cliLogger.info('CHECKPOINT', `createCheckpoint session=${sessionId} label="${checkpointLabel}" id=${checkpoint?.id ?? 'null'}`);
    return checkpoint;
  }

  async rollbackToCheckpoint(checkpointId: string): Promise<{
    success: boolean;
    restored: string[];
    errors: string[];
    reapplyCheckpointId?: string;
  }> {
    if (!this.workspacePath) {
      return { success: false, restored: [], errors: ['No workspace set'] };
    }
    return this.checkpointManager.rollbackTo(this.workspacePath, checkpointId);
  }

  async rollbackSingleFile(filePath: string): Promise<{ success: boolean; error?: string }> {
    if (!this.workspacePath) {
      return { success: false, error: 'No workspace set' };
    }
    return this.checkpointManager.rollbackSingleFile(this.workspacePath, filePath);
  }

  async reapplySingleFile(filePath: string): Promise<{ success: boolean; error?: string }> {
    if (!this.workspacePath) {
      return { success: false, error: 'No workspace set' };
    }
    return this.checkpointManager.reapplySingleFile(this.workspacePath, filePath);
  }

  async getCheckpoints(limit?: number, sessionId?: string): Promise<CheckpointListItem[]> {
    if (!this.workspacePath) {
      return [];
    }
    return this.checkpointManager.getCheckpoints(this.workspacePath, limit, sessionId);
  }

  async getCurrentStats(): Promise<ChangeStats | null> {
    if (!this.workspacePath) {
      return null;
    }
    return this.checkpointManager.getCurrentStats(this.workspacePath);
  }

  async getStorageStats(): Promise<{
    repositorySize: number;
    shadowDirSize: number;
    checkpointCount: number;
    oldestCheckpoint?: { id: string; timestamp: number };
    newestCheckpoint?: { id: string; timestamp: number };
  } | null> {
    if (!this.workspacePath) {
      return null;
    }
    return this.checkpointManager.getStorageStats(this.workspacePath);
  }

  async getStats(): Promise<{
    created: number;
    modified: number;
    deleted: number;
    directories: number;
    total: number;
    repositorySize: number;
    shadowDirSize: number;
    storageTotalSize: number;
    checkpointCount: number;
    oldestCheckpoint?: { id: string; timestamp: number };
    newestCheckpoint?: { id: string; timestamp: number };
  }> {
    const defaultCurrent = { created: 0, modified: 0, deleted: 0, directories: 0, total: 0 };
    const current = this.workspacePath && this.checkpointManager.hasInstance(this.workspacePath)
      ? (await this.getCurrentStats() ?? defaultCurrent)
      : defaultCurrent;

    const storage = await this.getStorageStats() ?? { repositorySize: 0, shadowDirSize: 0, checkpointCount: 0 };

    return {
      ...current,
      repositorySize: storage.repositorySize,
      shadowDirSize: storage.shadowDirSize,
      storageTotalSize: storage.repositorySize + storage.shadowDirSize,
      checkpointCount: storage.checkpointCount,
      oldestCheckpoint: storage.oldestCheckpoint,
      newestCheckpoint: storage.newestCheckpoint,
    };
  }

  async getChangeBuffer(): Promise<FileChange[]> {
    if (!this.workspacePath) {
      return [];
    }
    return this.checkpointManager.getChangeBuffer(this.workspacePath);
  }

  async cleanup(): Promise<void> {
    if (!this.workspacePath) {
      return;
    }
    await this.checkpointManager.cleanup(this.workspacePath);
  }
}
