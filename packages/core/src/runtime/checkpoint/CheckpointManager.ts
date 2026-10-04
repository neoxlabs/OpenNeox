/**
 * Checkpoint Manager - 全局单例管理器
 *
 * 管理多个 workspace 的 ShadowGitCheckpoint 实例
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import simpleGit from 'simple-git';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { ShadowGitCheckpoint } from './ShadowGitCheckpoint.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import {
  CheckpointMeta,
  CheckpointListItem,
  ChangeStats,
  FileChange,
  ShadowGitConfig,
  CheckpointDiff,
} from './types.js';

export class CheckpointManager {
  private static instance: CheckpointManager | null = null;
  private instances: Map<string, ShadowGitCheckpoint> = new Map();
  private config: Partial<ShadowGitConfig>;

  /** 系统 git 可用性 — 一次性检测后缓存 (null=未测) */
  private static _gitAvailable: boolean | null = null;
  private static _gitWarned = false;

  private constructor(config: Partial<ShadowGitConfig> = {}) {
    this.config = config;
  }

  /**
   * 一次性检测系统 git 是否可用 (Windows 用户常没装 git), 结果缓存。
   *
   *   checkpoint 全靠 ShadowGit, 没有 git 二进制时 init 会抛错。虽然调用点都 try/catch 了不会崩,
   *   但每条消息 startMessage + finishMessage 各试一次 git → 抛错 → 刷两条 warning, 纯浪费。
   *   这里一次测出 git 不可用就让各操作优雅 no-op (返回 null), 不再重试、只 warn 一次。
   *   checkpoint 默认关, 此检查只在用户显式启用后才会跑到。
   */
  static async isGitAvailable(): Promise<boolean> {
    if (CheckpointManager._gitAvailable !== null) return CheckpointManager._gitAvailable;
    try {
      await simpleGit().raw(['--version']);
      CheckpointManager._gitAvailable = true;
    } catch {
      CheckpointManager._gitAvailable = false;
      if (!CheckpointManager._gitWarned) {
        CheckpointManager._gitWarned = true;
        cliLogger.warn('CHECKPOINT', 'git 不可用 (未安装?), checkpoint 已自动停用 — 不影响其他功能');
      }
    }
    return CheckpointManager._gitAvailable;
  }

  private getPrivateRepoPath(workspacePath: string): string {
    const normalized = path.resolve(workspacePath);
    const workspaceName = path.basename(normalized)
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32) || 'workspace';

    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    const workspaceHash = Math.abs(hash).toString(16).substring(0, 10);

    return path.join(os.homedir(), NEOX_HOME_DIRNAME, 'checkpoints', `${workspaceName}-${workspaceHash}.git`);
  }

  private async getDirectorySize(dirPath: string): Promise<number> {
    let totalSize = 0;

    const walk = async (targetPath: string) => {
      let entries;
      try {
        entries = await fs.readdir(targetPath, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(targetPath, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        try {
          const stat = await fs.stat(fullPath);
          totalSize += stat.size;
        } catch {
          // ignore removed/unreadable files
        }
      }
    };

    await walk(dirPath);
    return totalSize;
  }

  private async readCheckpointSummaryFromRepo(repositoryDir: string): Promise<{
    checkpointCount: number;
    oldestCheckpoint?: { id: string; timestamp: number };
    newestCheckpoint?: { id: string; timestamp: number };
  }> {
    try {
      const output = await simpleGit().raw([
        '--git-dir', repositoryDir,
        'log',
        '--format=%H|%ct',
        '--max-count=1000',
      ]);

      const lines = output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      if (lines.length === 0) {
        return { checkpointCount: 0 };
      }

      const parsed = lines
        .map((line) => {
          const [id, ts] = line.split('|');
          const timestampSec = Number(ts);
          if (!id || !Number.isFinite(timestampSec)) {
            return null;
          }
          return { id, timestamp: timestampSec * 1000 };
        })
        .filter((item): item is { id: string; timestamp: number } => item !== null);

      if (parsed.length === 0) {
        return { checkpointCount: 0 };
      }

      return {
        checkpointCount: parsed.length,
        newestCheckpoint: parsed[0],
        oldestCheckpoint: parsed[parsed.length - 1],
      };
    } catch {
      return { checkpointCount: 0 };
    }
  }

  /**
   * 获取单例实例
   */
  static getInstance(config?: Partial<ShadowGitConfig>): CheckpointManager {
    if (!CheckpointManager.instance) {
      CheckpointManager.instance = new CheckpointManager(config);
    }
    return CheckpointManager.instance;
  }

  /**
   * 获取或创建 workspace 的 checkpoint 实例
   */
  async getCheckpoint(workspacePath: string): Promise<ShadowGitCheckpoint> {
    const normalized = path.normalize(workspacePath);

    if (!this.instances.has(normalized)) {
      const checkpoint = new ShadowGitCheckpoint(this.config);
      await checkpoint.init(normalized);
      this.instances.set(normalized, checkpoint);
    }

    return this.instances.get(normalized)!;
  }

  /**
   * 开始监控 workspace
   * @returns 返回开始监控前的 checkpoint ID（用于回滚）
   */
  async startWatching(
    workspacePath: string,
    sessionId: string,
    messageIndex: number = 0
  ): Promise<string | null> {
    const checkpoint = await this.getCheckpoint(workspacePath);
    return checkpoint.startWatching(sessionId, messageIndex);
  }

  /**
   * 获取开始监控前的 checkpoint ID
   */
  getBeforeCheckpointId(workspacePath: string): string | null {
    const normalized = path.normalize(workspacePath);
    const checkpoint = this.instances.get(normalized);
    return checkpoint?.getBeforeCheckpointId() ?? null;
  }

  /**
   * 停止监控 workspace
   */
  async stopWatching(workspacePath: string): Promise<void> {
    const normalized = path.normalize(workspacePath);
    const checkpoint = this.instances.get(normalized);
    if (checkpoint) {
      await checkpoint.stopWatching();
    }
  }

  /**
   * 创建 checkpoint
   */
  async createCheckpoint(workspacePath: string, label: string): Promise<CheckpointMeta> {
    const checkpoint = await this.getCheckpoint(workspacePath);
    return checkpoint.createCheckpoint(label);
  }

  /**
   * 回滚到指定 checkpoint
   * @returns 包含 reapplyCheckpointId 用于重新应用
   */
  async rollbackTo(
    workspacePath: string,
    checkpointId: string
  ): Promise<{ success: boolean; restored: string[]; errors: string[]; reapplyCheckpointId?: string }> {
    const checkpoint = await this.getCheckpoint(workspacePath);
    return checkpoint.rollbackTo(checkpointId);
  }

  /**
   * 回滚单个文件到消息开始前的状态
   * @param workspacePath 工作区路径
   * @param filePath 相对于工作区的文件路径
   */
  async rollbackSingleFile(
    workspacePath: string,
    filePath: string
  ): Promise<{ success: boolean; error?: string }> {
    const checkpoint = await this.getCheckpoint(workspacePath);
    return checkpoint.rollbackSingleFile(filePath);
  }

  /**
   * 重新应用单个文件（从当前 HEAD 恢复）
   * @param workspacePath 工作区路径
   * @param filePath 相对于工作区的文件路径
   */
  async reapplySingleFile(
    workspacePath: string,
    filePath: string
  ): Promise<{ success: boolean; error?: string }> {
    const checkpoint = await this.getCheckpoint(workspacePath);
    return checkpoint.reapplySingleFile(filePath);
  }

  /**
   * 获取 checkpoint 列表
   * @param workspacePath 工作区路径
   * @param limit 最大返回数量
   * @param sessionId 可选，按 sessionId 过滤
   */
  async getCheckpoints(workspacePath: string, limit?: number, sessionId?: string): Promise<CheckpointListItem[]> {
    const checkpoint = await this.getCheckpoint(workspacePath);
    return checkpoint.getCheckpoints(limit, sessionId);
  }

  /**
   * 获取 diff
   */
  async getDiff(
    workspacePath: string,
    fromCheckpoint: string,
    toCheckpoint?: string
  ): Promise<CheckpointDiff> {
    const checkpoint = await this.getCheckpoint(workspacePath);
    return checkpoint.getDiff(fromCheckpoint, toCheckpoint);
  }

  /**
   * 获取当前变更缓冲
   */
  async getChangeBuffer(workspacePath: string): Promise<FileChange[]> {
    const checkpoint = await this.getCheckpoint(workspacePath);
    return checkpoint.getChangeBuffer();
  }

  /**
   * 获取当前变更统计
   */
  async getCurrentStats(workspacePath: string): Promise<ChangeStats> {
    const checkpoint = await this.getCheckpoint(workspacePath);
    return checkpoint.getCurrentStats();
  }

  async getStorageStats(workspacePath: string): Promise<{
    repositorySize: number;
    shadowDirSize: number;
    checkpointCount: number;
    oldestCheckpoint?: { id: string; timestamp: number };
    newestCheckpoint?: { id: string; timestamp: number };
  }> {
    const normalized = path.normalize(workspacePath);
    const checkpoint = this.instances.get(normalized);

    if (checkpoint) {
      return checkpoint.getStorageStats();
    }

    const repositoryDir = this.getPrivateRepoPath(normalized);
    const shadowDir = path.join(normalized, '.cdundo');

    const [repositorySize, shadowDirSize, summary] = await Promise.all([
      this.getDirectorySize(repositoryDir),
      this.getDirectorySize(shadowDir),
      this.readCheckpointSummaryFromRepo(repositoryDir),
    ]);

    return {
      repositorySize,
      shadowDirSize,
      checkpointCount: summary.checkpointCount,
      oldestCheckpoint: summary.oldestCheckpoint,
      newestCheckpoint: summary.newestCheckpoint,
    };
  }

  /**
   * 订阅文件变更事件
   */
  async onFileChange(
    workspacePath: string,
    callback: (change: FileChange) => void
  ): Promise<() => void> {
    const checkpoint = await this.getCheckpoint(workspacePath);
    return checkpoint.onFileChange(callback);
  }

  /**
   * 检查 workspace 是否正在监控
   */
  isWatching(workspacePath: string): boolean {
    const normalized = path.normalize(workspacePath);
    const checkpoint = this.instances.get(normalized);
    return checkpoint?.isActive() ?? false;
  }

  hasInstance(workspacePath: string): boolean {
    const normalized = path.normalize(workspacePath);
    return this.instances.has(normalized);
  }

  /**
   * 清理指定 workspace 的 checkpoint 数据
   */
  async cleanup(workspacePath: string): Promise<void> {
    const normalized = path.normalize(workspacePath);
    const checkpoint = this.instances.get(normalized);

    let repositoryDir = this.getPrivateRepoPath(normalized);
    if (checkpoint) {
      repositoryDir = checkpoint.getRepositoryDir();
      await checkpoint.destroy();
      this.instances.delete(normalized);
    }

    // 删除私有 git checkpoint 仓库
    try {
      await fs.rm(repositoryDir, { recursive: true, force: true });
      console.log('[CheckpointManager] Cleaned private repo:', repositoryDir);
    } catch (error) {
      console.error('[CheckpointManager] Failed to cleanup private repo:', error);
    }

    // 删除 legacy .cdundo 目录
    const shadowDir = path.join(normalized, '.cdundo');
    try {
      await fs.rm(shadowDir, { recursive: true, force: true });
      console.log('[CheckpointManager] Cleaned up:', shadowDir);
    } catch (error) {
      console.error('[CheckpointManager] Failed to cleanup:', error);
    }
  }

  /**
   * 销毁所有实例
   */
  async destroyAll(): Promise<void> {
    for (const [workspacePath, checkpoint] of this.instances) {
      await checkpoint.destroy();
    }
    this.instances.clear();
    console.log('[CheckpointManager] All instances destroyed');
  }

  /**
   * 获取所有活跃的 workspace
   */
  getActiveWorkspaces(): string[] {
    return Array.from(this.instances.keys()).filter((wp) =>
      this.instances.get(wp)?.isActive()
    );
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalInstances: number;
    activeInstances: number;
    workspaces: string[];
  } {
    return {
      totalInstances: this.instances.size,
      activeInstances: this.getActiveWorkspaces().length,
      workspaces: Array.from(this.instances.keys()),
    };
  }
}

// 导出默认实例
export const checkpointManager = CheckpointManager.getInstance();
