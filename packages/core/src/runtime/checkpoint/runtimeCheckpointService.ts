import type {
  CheckpointMeta,
  CheckpointListItem,
  ChangeStats,
  FileChange,
  RollbackFileOptions,
  RollbackFileResult,
  FileUnchangedResult,
} from './types.js';
import { CheckpointManager } from './CheckpointManager.js';
import { collectSessionChanges, type SessionChanges } from './sessionChanges.js';
import { EMPTY_CHANGE_SET, type ChangeSet } from './changeSet.js';
import {
  RollbackService,
  type RevertHunkInput,
  type RevertHunkResult,
  type RevertTurnOptions,
  type TurnRevertResult,
} from './rollbackService.js';
import {
  reconcileSessionChanges,
  type SessionReconciliation,
  type SnapshotSource,
} from './reconcile.js';
import { listFileSnapshots, readFileSnapshot } from '../../tools/files/fileSnapshotStore.js';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

/** 默认快照来源 —— fileSnapshotStore 是 write_file / delete_file 落的原内容 */
const FILE_SNAPSHOTS: SnapshotSource = { listFileSnapshots, readFileSnapshot };

export class RuntimeCheckpointService {
  private checkpointManager: CheckpointManager;
  private workspacePath: string | null = null;
  private enabled = true;
  private sessionMessageCounts: Map<string, number> = new Map();
  /** 在跑的收尾快照。下一轮 startMessage 和所有读快照的入口先等它 —— 快照不挡回合结束,
   *  但下一轮的基线必须落在上一轮的快照之后, 否则 AI 的改动会被记成"用户改的"。 */
  private pendingFinish: Promise<unknown> = Promise.resolve();

  constructor(checkpointManager?: CheckpointManager) {
    this.checkpointManager = checkpointManager ?? CheckpointManager.getInstance();
  }

  setWorkspace(workspacePath: string | null): void {
    this.workspacePath = workspacePath;
  }

  /** 当前工作区 —— RollbackService 的 revertHunk 要拿它做边界校验 */
  getWorkspace(): string | null {
    return this.workspacePath;
  }

  /**
   * 桌面 / CLI / 手机共用的撤销入口 (EDIT-01)。
   *
   * 不另存状态: source 就是当前的 ShadowGitCheckpoint, 所以重启后照样能撤 ——
   * 提交历史在 ~/.neox/checkpoints/<workspace>.git 里。
   */
  private async rollbackService(): Promise<RollbackService | null> {
    if (!this.workspacePath) return null;
    await this.settled();
    const checkpoint = await this.checkpointManager.getCheckpoint(this.workspacePath);
    return new RollbackService({
      source: checkpoint,
      getWorkspace: () => this.workspacePath,
    });
  }

  /** 会话级改动清单 (ChangeSet 是唯一结构) */
  async getChangeSet(sessionId: string): Promise<ChangeSet> {
    return (await this.getSessionChanges(sessionId)).changeSet;
  }

  /** 撤销一轮的全部 (或部分) 文件 */
  async revertTurn(commit: string, options?: RevertTurnOptions): Promise<TurnRevertResult> {
    const service = await this.rollbackService();
    if (!service) {
      return { commit, restored: [], skipped: [], failed: [{ path: '*', error: 'No workspace set' }] };
    }
    return service.revertTurn(commit, options);
  }

  /** 单 hunk 反向替换 (按 startLine 附近定位, 不是裸字符串替换) */
  async revertHunk(input: RevertHunkInput): Promise<RevertHunkResult> {
    const service = await this.rollbackService();
    if (!service) return { success: false, error: 'No workspace set' };
    return service.revertHunk(input);
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

  finishMessageInBackground(sessionId: string, label?: string): void {
    const t0 = Date.now();
    this.pendingFinish = this.pendingFinish
      .then(() => this.finishMessage(sessionId, label))
      .then(
        () => cliLogger.info('CHECKPOINT', `finishMessage session=${sessionId} ${Date.now() - t0}ms`),
        (error) => cliLogger.warn('CHECKPOINT', `finishMessage failed session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`),
      );
  }

  /** 等在跑的收尾快照落完 */
  settled(): Promise<void> {
    return this.pendingFinish.then(() => undefined);
  }

  async startMessage(sessionId: string): Promise<string | null> {
    await this.settled();
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
    await this.settled();
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
    await this.settled();
    return this.checkpointManager.rollbackTo(this.workspacePath, checkpointId);
  }

  async rollbackSingleFile(
    filePath: string,
    options?: RollbackFileOptions,
  ): Promise<RollbackFileResult> {
    if (!this.workspacePath) {
      return { success: false, error: 'No workspace set' };
    }
    await this.settled();
    return this.checkpointManager.rollbackSingleFile(this.workspacePath, filePath, options);
  }

  /**
   * 这个文件自某次 checkpoint 提交后有没有被改过 (CLI /undo 的护栏)。
   * 只读检查, 真正的恢复动作会在 rollbackSingleFile 里用同一判据再核一次。
   */
  async isFileUnchangedSinceCommit(
    commitId: string,
    filePath: string,
  ): Promise<FileUnchangedResult> {
    if (!this.workspacePath || !commitId || !filePath) {
      return { unchanged: false, reason: 'unknown', error: 'Missing workspace, commit or file path' };
    }
    await this.settled();
    const checkpoint = await this.checkpointManager.getCheckpoint(this.workspacePath);
    return checkpoint.isFileUnchangedSinceCommit(commitId, filePath);
  }

  async reapplySingleFile(filePath: string): Promise<{ success: boolean; error?: string }> {
    if (!this.workspacePath) {
      return { success: false, error: 'No workspace set' };
    }
    await this.settled();
    return this.checkpointManager.reapplySingleFile(this.workspacePath, filePath);
  }

  async getCheckpoints(limit?: number, sessionId?: string): Promise<CheckpointListItem[]> {
    if (!this.workspacePath) {
      return [];
    }
    await this.settled();
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

  /**
   * 本会话 agent 改过哪些文件 (CLI /changes 与 /undo 的唯一数据源)。
   *
   * 先等收尾快照落盘 —— 否则刚跑完一轮就敲 /undo, 最后一个提交可能还在路上,
   * 清单会是「上一轮之前」的, 用户看到的待撤销文件和实际要撤的不一致。
   *
   * `options.reconcile` 时顺带做一次「快照与 checkpoint 对账」(EDIT-06):
   * 每个文件带上磁盘哈希、是否被用户改过、以及能不能靠原内容快照兜底。
   * 只对最近一轮做 —— 撤销只用得到上一轮, 全量对账在大仓库上太贵。
   */
  async getSessionChanges(
    sessionId: string,
    options: { reconcile?: boolean } = {},
  ): Promise<SessionChanges & { reconciliation?: SessionReconciliation }> {
    if (!this.workspacePath || !sessionId) {
      return { turns: [], files: [], changeSet: EMPTY_CHANGE_SET };
    }
    await this.settled();
    const checkpoint = await this.checkpointManager.getCheckpoint(this.workspacePath);
    const changes = await collectSessionChanges(checkpoint, sessionId);
    if (!options.reconcile) return changes;
    return { ...changes, reconciliation: await this.reconcileWith(changes, sessionId, checkpoint) };
  }

  /** 只做对账, 不重新查一遍改动清单 (CLI /undo 在拿到清单之后调) */
  async reconcileSession(sessionId: string): Promise<SessionReconciliation> {
    return (await this.getSessionChanges(sessionId, { reconcile: true })).reconciliation!;
  }

  private async reconcileWith(
    changes: SessionChanges,
    sessionId: string,
    checkpoint: unknown,
  ): Promise<SessionReconciliation> {
    const empty: SessionReconciliation = {
      sessionId,
      files: [],
      summary: { total: 0, verified: 0, userModified: 0, unknown: 0, snapshotOnly: 0 },
    };
    if (!this.workspacePath) return empty;
    try {
      return await reconcileSessionChanges({
        source: checkpoint as any,
        snapshots: FILE_SNAPSHOTS,
        sessionId,
        workspacePath: this.workspacePath,
        changes,
        turns: 1,
      });
    } catch (error) {
      /* 对账只是给 UI/护栏补充信息, 失败不能把 /changes /undo 本身弄挂 */
      cliLogger.warn('CHECKPOINT', `reconcile failed session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      return empty;
    }
  }

  async cleanup(): Promise<void> {
    if (!this.workspacePath) {
      return;
    }
    await this.checkpointManager.cleanup(this.workspacePath);
  }
}
