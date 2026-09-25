/**
 * Shadow Git Checkpoint 系统
 *
 * 使用隐藏的 .cdundo/ Git 仓库 + WatchCoordinator 文件监控
 * 实现 100% 覆盖率的文件变更追踪和回滚
 */

import simpleGit, { SimpleGit, StatusResult } from 'simple-git';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { getWatchCoordinator } from '../watch/WatchCoordinator.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

import {
  ChangeType,
  FileChange,
  ChangeStats,
  CheckpointMeta,
  CheckpointListItem,
  ShadowGitConfig,
  DEFAULT_SHADOW_GIT_CONFIG,
  FileDiff,
  CheckpointDiff,
  BINARY_EXTENSIONS,
} from './types.js';

/** 事件回调类型 */
type ChangeCallback = (change: FileChange) => void;

function sanitizeWorkspaceName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'workspace';
}

function hashWorkspacePath(workspacePath: string): string {
  let hash = 0;
  for (let i = 0; i < workspacePath.length; i++) {
    const char = workspacePath.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16).substring(0, 10);
}

export class ShadowGitCheckpoint {
  private workspacePath: string;
  private shadowDir: string;          // 兼容字段：workspace/.cdundo（仅 legacy 清理）
  private shadowGitDir: string;       // 私有 Git 仓库：~/.neox/checkpoints/<workspace>.git
  private git: SimpleGit;
  private watchSubscriptionId: number | null = null;
  private changeBuffer: FileChange[] = [];
  private isWatching = false;
  private currentSessionId: string | null = null;
  private currentMessageIndex = 0;
  private config: ShadowGitConfig;
  private changeCallbacks: Set<ChangeCallback> = new Set();
  private initialized = false;

  // 防抖: 同一文件短时间内多次变更只记录一次
  private debounceMap: Map<string, NodeJS.Timeout> = new Map();
  private readonly DEBOUNCE_MS = 100;

  // Git 操作锁：防止并发的 git 操作导致 index.lock 冲突
  private gitOperationLock: Promise<any> = Promise.resolve();
  private readonly GIT_RETRY_ATTEMPTS = 3;
  private readonly GIT_RETRY_DELAY_MS = 500;

  constructor(config: Partial<ShadowGitConfig> = {}) {
    this.config = { ...DEFAULT_SHADOW_GIT_CONFIG, ...config };
    this.workspacePath = '';
    this.shadowDir = '';
    this.shadowGitDir = '';
    this.git = simpleGit();
  }

  /**
   * 初始化 Shadow Git 系统
   *
   * 优化: 不再维护 mirror 副本。git-dir 在 .cdundo/.git，work-tree 直接指向 workspace。
   * 所有文件内容由 Git objects 存储，checkpoint/rollback 通过 git 原生操作完成，零拷贝。
   */
  async init(workspacePath: string): Promise<void> {
    const normalizedWorkspace = path.resolve(workspacePath);
    if (this.initialized && this.workspacePath === normalizedWorkspace) {
      cliLogger.debug('CHECKPOINT', 'Already initialized for: ' + workspacePath);
      return;
    }

    this.workspacePath = normalizedWorkspace;
    this.shadowDir = path.join(normalizedWorkspace, '.cdundo');

    const checkpointRoot = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'checkpoints');
    await fs.mkdir(checkpointRoot, { recursive: true });
    const workspaceName = sanitizeWorkspaceName(path.basename(normalizedWorkspace));
    const workspaceHash = hashWorkspacePath(normalizedWorkspace);
    this.shadowGitDir = path.join(checkpointRoot, `${workspaceName}-${workspaceHash}.git`);

    cliLogger.debug('CHECKPOINT', `Initializing private checkpoint repo: ${this.shadowGitDir}`);

    // 初始化私有 git 仓库，work-tree 指向 workspace（0 拷贝）
    const gitExists = fsSync.existsSync(this.shadowGitDir);

    // 配置 simple-git: --git-dir=~/.neox/checkpoints/*.git --work-tree=workspace
    this.git = simpleGit({
      baseDir: normalizedWorkspace,
      config: [
        `core.worktree=${normalizedWorkspace}`,
      ],
    }).env('GIT_DIR', this.shadowGitDir).env('GIT_WORK_TREE', normalizedWorkspace);

    if (!gitExists) {
      // 创建 bare 仓库并绑定工作树
      await fs.mkdir(path.dirname(this.shadowGitDir), { recursive: true });
      await simpleGit().raw(['init', '--bare', this.shadowGitDir]);
      const cfgGit = simpleGit({ baseDir: normalizedWorkspace })
        .env('GIT_DIR', this.shadowGitDir)
        .env('GIT_WORK_TREE', normalizedWorkspace);
      await cfgGit.addConfig('core.worktree', normalizedWorkspace);
      await cfgGit.addConfig('core.bare', 'false');
      await cfgGit.addConfig('user.email', 'checkpoint@neox.local');
      await cfgGit.addConfig('user.name', 'Neox Checkpoint');
      await this.writeExcludeRules();
      cliLogger.debug('CHECKPOINT', 'Created new private checkpoint repository (work-tree mode)');
    } else {
      cliLogger.debug('CHECKPOINT', 'Using existing private checkpoint repository');
    }

    // 4. 仅在首次初始化时创建 initial commit（空 commit 作为基线）
    if (!gitExists) {
      await this.withGitLock(async () => {
        try {
          await this.git.commit('Initial checkpoint', { '--allow-empty': null });
          cliLogger.debug('CHECKPOINT', 'Created initial empty checkpoint');
        } catch (e) {
          cliLogger.debug('CHECKPOINT', 'No initial commit needed');
        }
      });
    }

    this.initialized = true;
    cliLogger.debug('CHECKPOINT', 'Initialization complete');
  }

  /**
   * 写入 exclude 规则到 .cdundo/.git/info/exclude
   * 等价于 .gitignore，但不污染用户项目
   */
  private async writeExcludeRules(): Promise<void> {
    const excludeDir = path.join(this.shadowGitDir, 'info');
    await fs.mkdir(excludeDir, { recursive: true });
    const excludePath = path.join(excludeDir, 'exclude');
    const rules = [
      '# Neox checkpoint exclude rules',
      '.cdundo/',
      '.git/',
      'node_modules/',
      'dist/',
      'build/',
      '.next/',
      'target/',
      '.DS_Store',
      '*.swp',
      '*.swo',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      // 从 config.ignoredPatterns 追加
      ...this.config.ignoredPatterns,
    ];
    await fs.writeFile(excludePath, rules.join('\n') + '\n');
  }

  // 记录开始监控时的 checkpoint ID（用于回滚）
  private beforeCheckpointId: string | null = null;

  /**
   * 开始监控文件变更
   * @returns 返回开始监控前的 checkpoint ID（用于回滚）
   */
  async startWatching(sessionId: string, messageIndex: number = 0): Promise<string | null> {
    if (!this.initialized) {
      throw new Error('ShadowGitCheckpoint not initialized. Call init() first.');
    }

    if (this.isWatching) {
      cliLogger.debug('CHECKPOINT', 'Already watching, updating session info');
      cliLogger.debug('CHECKPOINT', 'Clearing changeBuffer (was: ' + this.changeBuffer.length + ' items)');
      this.currentSessionId = sessionId;
      this.currentMessageIndex = messageIndex;
      // 清空变更缓冲，开始新的监控周期
      this.changeBuffer = [];
      return this.beforeCheckpointId;
    }

    cliLogger.debug('CHECKPOINT', 'Starting new watch, clearing changeBuffer (was: ' + this.changeBuffer.length + ' items)');
    this.currentSessionId = sessionId;
    this.currentMessageIndex = messageIndex;
    this.changeBuffer = [];

    // 在开始监控前，记录当前 HEAD 作为 "before" checkpoint
    // 不再 git add . 整个 workspace，只记录已有的最新 commit
    try {
      await this.withGitLock(async () => {
        await this.git.raw(['add', '-A', '.']);
        const pending = await this.git.status();
        if (pending.files.length > 0) {
          try {
            await this.git.commit(this.formatCommitMessage('User changes before message', {
              created: 0, modified: pending.files.length, deleted: 0, directories: 0,
              total: pending.files.length,
            }));
            cliLogger.info('CHECKPOINT', `baselined ${pending.files.length} pre-message change(s)`);
          } catch {
            /* 没得可提交 (竞态) — 下面取 HEAD 一样正确 */
          }
        }
        const log = await this.git.log({ maxCount: 1 });
        this.beforeCheckpointId = log.latest?.hash || null;
        cliLogger.debug('CHECKPOINT', 'Before-checkpoint (HEAD): ' + this.beforeCheckpointId);
      });
    } catch (error) {
      cliLogger.error('CHECKPOINT', 'Failed to get before-checkpoint', { error });
      this.beforeCheckpointId = null;
    }

    cliLogger.debug('CHECKPOINT', 'Starting file watcher for session: ' + sessionId);

    this.isWatching = true;
    const coordinator = getWatchCoordinator();
    coordinator.start(this.workspacePath);
    this.watchSubscriptionId = coordinator.subscribe(
      (events) => {
        for (const event of events) {
          switch (event.kind) {
            case 'add':
              this.handleChange('create', event.filePath);
              break;
            case 'change':
              this.handleChange('modify', event.filePath);
              break;
            case 'unlink':
              this.handleChange('delete', event.filePath);
              break;
            case 'addDir':
              this.handleChange('mkdir', event.filePath);
              break;
            case 'unlinkDir':
              this.handleChange('rmdir', event.filePath);
              break;
          }
        }
      },
      {
        name: 'ShadowGitCheckpoint',
        kinds: ['add', 'change', 'unlink', 'addDir', 'unlinkDir'],
        fileFilter: (relativePath) => !this.shouldIgnorePath(relativePath),
        debounceMs: this.DEBOUNCE_MS,
      },
    );

    cliLogger.debug('CHECKPOINT', 'File watcher started');

    return this.beforeCheckpointId;
  }

  /**
   * 获取开始监控前的 checkpoint ID（用于回滚）
   */
  getBeforeCheckpointId(): string | null {
    return this.beforeCheckpointId;
  }

  /**
   * 停止监控
   */
  async stopWatching(): Promise<void> {
    if (this.watchSubscriptionId !== null) {
      getWatchCoordinator().unsubscribe(this.watchSubscriptionId);
      this.watchSubscriptionId = null;
    }
    this.isWatching = false;
    this.currentSessionId = null;

    // 清理防抖定时器
    for (const timeout of this.debounceMap.values()) {
      clearTimeout(timeout);
    }
    this.debounceMap.clear();

    // 清空变更缓冲，避免残留数据影响下次会话
    this.changeBuffer = [];

    cliLogger.debug('CHECKPOINT', 'File watcher stopped');
  }

  /**
   * 处理文件变更事件
   */
  private handleChange(type: ChangeType, absolutePath: string): void {
    if (!this.isWatching) return;

    // 获取相对路径
    const relativePath = path.relative(this.workspacePath, absolutePath);

    // 二次过滤：忽略不应该追踪的文件/目录
    // 这是对协调器 fileFilter 的补充，确保不会漏掉
    if (this.shouldIgnorePath(relativePath)) {
      return;
    }

    // 防抖处理
    const debounceKey = `${type}:${relativePath}`;
    const existingTimeout = this.debounceMap.get(debounceKey);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    this.debounceMap.set(
      debounceKey,
      setTimeout(() => {
        this.recordChange(type, relativePath, absolutePath);
        this.debounceMap.delete(debounceKey);
      }, this.DEBOUNCE_MS)
    );
  }

  /**
   * 检查文件是否为二进制文件
   */
  private isBinaryFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return this.config.binaryExtensions.includes(ext);
  }

  /**
   * 检查文件内容是否为二进制（通过检测 NULL 字节）
   */
  private async detectBinaryContent(absolutePath: string): Promise<boolean> {
    try {
      // 读取文件前 8KB 检测
      const fd = await fs.open(absolutePath, 'r');
      const buffer = Buffer.alloc(8192);
      const { bytesRead } = await fd.read(buffer, 0, 8192, 0);
      await fd.close();

      // 检测 NULL 字节（二进制文件特征）
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * 记录变更
   */
  private async recordChange(
    type: ChangeType,
    relativePath: string,
    absolutePath: string
  ): Promise<void> {
    const change: FileChange = {
      type,
      path: relativePath,
      timestamp: Date.now(),
    };

    // 检查是否为二进制文件（基于扩展名）
    const isBinaryByExt = this.isBinaryFile(relativePath);
    change.isBinary = isBinaryByExt;

    // 获取文件大小和类型信息
    let fileSize = 0;
    let isVeryLargeFile = false;
    let isLargeFile = false;

    if (type === 'create' || type === 'modify') {
      try {
        const stat = await fs.stat(absolutePath);
        if (stat.isFile()) {
          fileSize = stat.size;
          change.size = fileSize;
          isVeryLargeFile = fileSize > this.config.veryLargeFileThreshold;
          isLargeFile = fileSize > this.config.largeFileThreshold;
          change.isLargeFile = isLargeFile;

          // 如果扩展名不确定，检测内容是否为二进制
          if (!isBinaryByExt && !isLargeFile) {
            const isBinaryContent = await this.detectBinaryContent(absolutePath);
            change.isBinary = isBinaryContent;
          }
        }
      } catch {
        // 文件可能已被删除
      }
    }

    // 对于删除/修改操作，尝试保存原内容（从 git objects 获取，零拷贝）
    // 跳过二进制和大文件
    if ((type === 'delete' || type === 'modify') && !change.isBinary && !isLargeFile) {
      try {
        const content = await this.git.show([`HEAD:${relativePath}`]);
        if (content && content.length < this.config.largeFileThreshold) {
          change.previousContent = content;
        }
      } catch {
        // 文件可能不存在于 git 中（新文件首次修改）
      }
    }

    // 对于创建/修改操作，读取新内容
    // 跳过二进制、大文件
    if ((type === 'create' || type === 'modify') && !change.isBinary && !isLargeFile) {
      try {
        change.newContent = await fs.readFile(absolutePath, 'utf-8');
      } catch {
        // 文件可能已被删除或读取失败
      }
    }

    this.changeBuffer.push(change);

    // 0 拷贝引擎：不做 shadow 文件复制，仅记录事件
    if (isVeryLargeFile) {
      cliLogger.debug('CHECKPOINT', `Skipping very large file (${(fileSize / 1024 / 1024).toFixed(1)}MB): ${relativePath}`);
    }

    // 触发回调
    for (const callback of this.changeCallbacks) {
      try {
        callback(change);
      } catch (e) {
        cliLogger.error('CHECKPOINT', 'Callback error', { error: e });
      }
    }

    const sizeInfo = fileSize ? ` (${this.formatFileSize(fileSize)})` : '';
    const binaryInfo = change.isBinary ? ' [binary]' : '';
    cliLogger.debug('CHECKPOINT', `Recorded ${type}: ${relativePath}${sizeInfo}${binaryInfo}`);
  }

  /**
   * 格式化文件大小
   */
  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  }

  /**
   * 检查路径是否应该忽略（用于 handleChange 的二次过滤）
   */
  private shouldIgnorePath(relativePath: string): boolean {
    if (relativePath.startsWith('.cdundo') || relativePath.includes('/.cdundo/')) return true;
    if (relativePath.includes('node_modules/') || relativePath.startsWith('node_modules')) return true;
    if (relativePath.startsWith('.git') || relativePath.includes('/.git/')) return true;
    if (relativePath.startsWith('dist/') || relativePath.includes('/dist/')) return true;
    if (relativePath.startsWith('build/') || relativePath.includes('/build/')) return true;
    if (relativePath.startsWith('out/') || relativePath.includes('/out/')) return true;
    if (relativePath.startsWith('coverage/') || relativePath.includes('/coverage/')) return true;
    if (relativePath.startsWith('target/') || relativePath.includes('/target/')) return true;
    if (relativePath.startsWith('reverse/') || relativePath.includes('/<third-party-tree>/')) return true;
    if (relativePath.startsWith('.idea/') || relativePath.includes('/.idea/')) return true;
    if (relativePath.startsWith('.gradle/') || relativePath.includes('/.gradle/')) return true;
    if (relativePath.startsWith('.next/') || relativePath.includes('/.next/')) return true;
    if (relativePath.includes('.DS_Store')) return true;
    if (relativePath.endsWith('.swp') || relativePath.endsWith('.swo')) return true;
    if (relativePath.endsWith('package-lock.json')) return true;
    if (relativePath.endsWith('yarn.lock')) return true;
    if (relativePath.endsWith('pnpm-lock.yaml')) return true;

    for (const pattern of this.config.ignoredPatterns) {
      const regexPattern = pattern
        .replace(/\*\*/g, '<<<GLOBSTAR>>>')
        .replace(/\*/g, '[^/]*')
        .replace(/<<<GLOBSTAR>>>/g, '.*')
        .replace(/\?/g, '.');

      if (new RegExp(`^${regexPattern}$`).test(relativePath)) {
        return true;
      }
    }

    return false;
  }

  /**
   * 创建 Checkpoint
   */
  async createCheckpoint(label: string): Promise<CheckpointMeta> {
    if (!this.initialized) {
      throw new Error('ShadowGitCheckpoint not initialized');
    }

    cliLogger.debug('CHECKPOINT', 'Creating checkpoint: ' + label);

    return await this.withGitLock(async () => {
      // 只添加 changeBuffer 中记录的变更文件，而非整个 workspace
      if (this.changeBuffer.length > 0) {
        const filesToAdd: string[] = [];
        const filesToRm: string[] = [];
        for (const change of this.changeBuffer) {
          if (change.type === 'delete' || change.type === 'rmdir') {
            filesToRm.push(change.path);
          } else {
            filesToAdd.push(change.path);
          }
        }
        if (filesToAdd.length > 0) {
          await this.git.add(filesToAdd);
        }
        if (filesToRm.length > 0) {
          try {
            await this.git.raw(['rm', '--cached', '--ignore-unmatch', ...filesToRm]);
          } catch {
            // 文件可能已不在 index 中，忽略
          }
        }
      }

      // 检查是否有变更
      const status = await this.git.status();
      if (status.files.length === 0 && this.changeBuffer.length === 0) {
        cliLogger.debug('CHECKPOINT', 'No changes to checkpoint');
        // 返回最后一个 checkpoint
        const log = await this.git.log({ maxCount: 1 });
        return {
          id: log.latest?.hash || 'no-changes',
          label,
          timestamp: Date.now(),
          sessionId: this.currentSessionId || '',
          messageIndex: this.currentMessageIndex,
          changes: [],
          stats: { created: 0, modified: 0, deleted: 0, directories: 0, total: 0 },
        };
      }

      // 生成变更摘要
      const stats = this.calculateStats();
      const commitMessage = this.formatCommitMessage(label, stats);

      // 提交
      const result = await this.git.commit(commitMessage);

      const checkpoint: CheckpointMeta = {
        id: result.commit,
        label,
        timestamp: Date.now(),
        sessionId: this.currentSessionId || '',
        messageIndex: this.currentMessageIndex,
        changes: [...this.changeBuffer],
        stats,
      };

      // 清空变更缓冲
      this.changeBuffer = [];
      this.currentMessageIndex++;

      cliLogger.debug('CHECKPOINT', `Checkpoint created: ${result.commit} (${stats.total} changes)`);

      // 清理过期 checkpoints
      await this.cleanupOldCheckpoints();

      return checkpoint;
    });
  }

  // 保存回滚前的 checkpoint ID（用于 reapply）
  private lastRollbackFromId: string | null = null;

  getLastRollbackFromId(): string | null {
    return this.lastRollbackFromId;
  }

  /**
   * 回滚到指定 Checkpoint
   * @returns 包含 reapplyCheckpointId 用于重新应用
   */
  async rollbackTo(checkpointId: string): Promise<{ success: boolean; restored: string[]; errors: string[]; reapplyCheckpointId?: string }> {
    if (!this.initialized) {
      throw new Error('ShadowGitCheckpoint not initialized');
    }

    cliLogger.debug('CHECKPOINT', 'Rolling back to checkpoint: ' + checkpointId);

    const restored: string[] = [];
    const errors: string[] = [];

    let reapplyCheckpointId: string | undefined;

    try {
      await this.withGitLock(async () => {
        // 先把当前工作区状态落到私有仓库，保证 reapply 可恢复
        await this.git.raw(['add', '-A', '.']);
        const status = await this.git.status();
        cliLogger.debug('CHECKPOINT', 'Current git status before rollback: ' + status.files.length + ' files');

        if (status.files.length > 0) {
          try {
            await this.git.commit('Changes before rollback (for reapply)');
            cliLogger.debug('CHECKPOINT', 'Created commit for rollback comparison');
          } catch {
            cliLogger.debug('CHECKPOINT', 'No changes to commit (might be already committed)');
          }
        }

        // 获取当前 HEAD 作为 reapply checkpoint（回滚前状态）
        const log = await this.git.log({ maxCount: 1 });
        reapplyCheckpointId = log.latest?.hash;
        this.lastRollbackFromId = reapplyCheckpointId || null;
        cliLogger.debug('CHECKPOINT', 'Saved reapply checkpoint: ' + reapplyCheckpointId);

        // 记录变更清单（用于回滚结果展示）
        const diffOutput = await this.git.diff(['--name-status', checkpointId, 'HEAD']);
        const lines = diffOutput.trim().split('\n').filter(l => l.trim());
        for (const line of lines) {
          const [statusCode, ...pathParts] = line.split('\t');
          const changedPath = pathParts.join('\t');
          if (!changedPath) continue;
          if (statusCode === 'A') restored.push(`deleted: ${changedPath}`);
          else if (statusCode === 'D') restored.push(`recovered: ${changedPath}`);
          else restored.push(`restored: ${changedPath}`);
        }

        // 核心回滚：直接把工作树与索引 reset 到目标 checkpoint
        await this.git.reset(['--hard', checkpointId]);

        // 清空变更缓冲
        this.changeBuffer = [];

        cliLogger.debug('CHECKPOINT', `Rollback complete: ${restored.length} restored, ${errors.length} errors`);
      });

      return { success: errors.length === 0, restored, errors, reapplyCheckpointId };
    } catch (error) {
      cliLogger.error('CHECKPOINT', 'Rollback failed', { error });
      return { success: false, restored, errors: [String(error)], reapplyCheckpointId };
    }
  }

  private toWorkspaceRelative(
    rawPath: string,
  ): { ok: true; relative: string; absolute: string } | { ok: false; error: string } {
    const raw = String(rawPath || '').trim();
    if (!raw) return { ok: false, error: 'Empty file path' };
    const absolute = path.resolve(this.workspacePath, raw);
    const relative = path.relative(this.workspacePath, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return { ok: false, error: `File is outside the workspace: ${raw}` };
    }
    /* git 参数一律用 POSIX 分隔符, Windows 下 path.relative 会给反斜杠 */
    return { ok: true, relative: relative.split(path.sep).join('/'), absolute };
  }

  /**
   * 回滚单个文件到消息开始前的状态（使用 beforeCheckpointId）
   *
   * 统一使用 shadow git 方案，与整体回滚保持一致：
   * - 使用 beforeCheckpointId 作为回滚目标
   * - 通过 git checkout 恢复文件
   * - 确保单文件回滚与整体状态联动
   *
   * @param filePath 相对于工作区的文件路径
   * @returns 回滚结果
   */
  async rollbackSingleFile(rawPath: string): Promise<{ success: boolean; error?: string }> {
    if (!this.initialized) {
      return { success: false, error: 'ShadowGitCheckpoint not initialized' };
    }

    const norm = this.toWorkspaceRelative(rawPath);
    if (!norm.ok) return { success: false, error: norm.error };
    const filePath = norm.relative;

    cliLogger.debug('CHECKPOINT', 'Rolling back single file: ' + filePath);

    const workspaceFilePath = path.join(this.workspacePath, filePath);

    try {
      return await this.withGitLock(async () => {
        const base = await this.resolveRevertBase(filePath);
        if (!base.ok) return { success: false, error: base.error };

        /* 文件在 base 里存在吗? 不存在 = 这个文件是 AI 新建的 → 删掉它。 */
        let existsInBase = true;
        try {
          await this.git.raw(['cat-file', '-e', `${base.commit}:${filePath}`]);
        } catch {
          existsInBase = false;
        }

        if (!existsInBase) {
          cliLogger.debug('CHECKPOINT', `File was created by AI, deleting: ${filePath}`);
          try {
            await fs.unlink(workspaceFilePath);
          } catch (deleteError: any) {
            if (deleteError?.code !== 'ENOENT') {
              return { success: false, error: `Failed to delete file: ${deleteError}` };
            }
          }
          /* index 里也要抹掉, 否则下一个 checkpoint 会把"已删除"当成新改动重新记一遍 */
          try {
            await this.git.raw(['rm', '--cached', '--ignore-unmatch', '--', filePath]);
          } catch { /* index 里本来就没有 */ }
          return { success: true };
        }

        cliLogger.debug('CHECKPOINT', `Restoring ${filePath} from ${base.commit.slice(0, 8)}`);
        try {
          await this.git.checkout([base.commit, '--', filePath]);
          return { success: true };
        } catch (restoreError) {
          return { success: false, error: `Failed to restore file: ${restoreError}` };
        }
      });
    } catch (error) {
      cliLogger.error('CHECKPOINT', 'Failed to rollback single file', { error });
      return { success: false, error: String(error) };
    }
  }

  private async resolveRevertBase(
    filePath: string,
  ): Promise<{ ok: true; commit: string } | { ok: false; error: string }> {
    if (this.isWatching && this.beforeCheckpointId) {
      return { ok: true, commit: this.beforeCheckpointId };
    }
    let lastTouch = '';
    try {
      lastTouch = (await this.git.raw(['log', '-1', '--format=%H', '--', filePath])).trim();
    } catch (err) {
      return { ok: false, error: `git log failed: ${err}` };
    }
    if (!lastTouch) {
      return { ok: false, error: 'This file has no recorded AI change to revert.' };
    }
    try {
      const parent = (await this.git.raw(['rev-parse', '--verify', `${lastTouch}^`])).trim();
      if (parent) return { ok: true, commit: parent };
    } catch {
      /* 没有父提交 = 这个文件从仓库初始化起就没被 AI 动过 */
    }
    return { ok: false, error: 'This file has no recorded AI change to revert.' };
  }

  /**
   * 重新应用单个文件（从当前 HEAD 恢复）
   * @param filePath 相对于工作区的文件路径
   * @returns 重新应用结果
   */
  async reapplySingleFile(rawPath: string): Promise<{ success: boolean; error?: string }> {
    if (!this.initialized) {
      return { success: false, error: 'ShadowGitCheckpoint not initialized' };
    }

    const norm = this.toWorkspaceRelative(rawPath);
    if (!norm.ok) return { success: false, error: norm.error };
    const filePath = norm.relative;

    cliLogger.debug('CHECKPOINT', 'Reapplying single file: ' + filePath);

    try {
      return await this.withGitLock(async () => {
        // 从 HEAD（当前最新状态）恢复文件
        try {
          await this.git.checkout(['HEAD', '--', filePath]);

          cliLogger.debug('CHECKPOINT', 'Successfully reapplied file: ' + filePath);
          return { success: true };
        } catch (checkoutError) {
          // 文件在 HEAD 时不存在
          return { success: false, error: `File not found in HEAD: ${checkoutError}` };
        }
      });
    } catch (error) {
      cliLogger.error('CHECKPOINT', 'Failed to reapply single file', { error });
      return { success: false, error: String(error) };
    }
  }

  /**
   * 获取 Checkpoint 列表
   * @param limit 最大返回数量
   * @param sessionId 可选，按 sessionId 过滤
   */
  async getCheckpoints(limit: number = 50, sessionId?: string): Promise<CheckpointListItem[]> {
    if (!this.initialized) return [];

    try {
      // 如果需要按 session 过滤，获取更多记录再过滤
      const fetchLimit = sessionId ? limit * 3 : limit;
      const log = await this.git.log({ maxCount: fetchLimit });

      let checkpoints = log.all.map((commit) => {
        const fullMessage = [commit.message, commit.body].filter(Boolean).join('\n');
        const parsed = this.parseCommitMessage(fullMessage);
        return {
          id: commit.hash,
          label: parsed.label,
          timestamp: new Date(commit.date).getTime(),
          sessionId: parsed.sessionId,
          messageIndex: parsed.messageIndex,
          stats: parsed.stats,
        };
      });

      // 按 sessionId 过滤
      if (sessionId) {
        checkpoints = checkpoints.filter(cp => cp.sessionId === sessionId);
      }

      // 限制返回数量
      return checkpoints.slice(0, limit);
    } catch (error) {
      cliLogger.error('CHECKPOINT', 'Failed to get checkpoints', { error });
      return [];
    }
  }

  /**
   * 获取两个 checkpoint 之间的 diff
   */
  async getDiff(fromCheckpoint: string, toCheckpoint: string = 'HEAD'): Promise<CheckpointDiff> {
    if (!this.initialized) {
      throw new Error('ShadowGitCheckpoint not initialized');
    }

    const diff = await this.git.diff([fromCheckpoint, toCheckpoint, '--stat', '--numstat']);
    const diffSummary = await this.git.diffSummary([fromCheckpoint, toCheckpoint]);

    const files: FileDiff[] = diffSummary.files.map((file) => {
      // 处理不同类型的 diff 结果 (文本文件 vs 二进制文件)
      const textDiffFile = file as { insertions?: number; deletions?: number };
      const isTextFile = typeof textDiffFile.insertions === 'number' || typeof textDiffFile.deletions === 'number';
      return {
        path: file.file,
        status: this.getFileStatus(file),
        additions: isTextFile ? (textDiffFile.insertions ?? 0) : 0,
        deletions: isTextFile ? (textDiffFile.deletions ?? 0) : 0,
        lines: [], // 详细行级 diff 可以按需获取
      };
    });

    return {
      checkpointId: fromCheckpoint,
      files,
      stats: {
        filesChanged: diffSummary.changed,
        additions: diffSummary.insertions,
        deletions: diffSummary.deletions,
      },
    };
  }

  /**
   * 获取当前变更缓冲
   */
  getChangeBuffer(): FileChange[] {
    // 如果不在监控状态，返回空数组（避免返回旧数据）
    if (!this.isWatching) {
      cliLogger.debug('CHECKPOINT', 'getChangeBuffer called but not watching, returning empty array');
      return [];
    }
    return [...this.changeBuffer];
  }

  /**
   * 获取当前变更统计
   */
  getCurrentStats(): ChangeStats {
    // 如果不在监控状态，返回空统计（避免返回旧数据）
    if (!this.isWatching) {
      cliLogger.debug('CHECKPOINT', 'getCurrentStats called but not watching, returning empty stats');
      return { created: 0, modified: 0, deleted: 0, directories: 0, total: 0 };
    }
    
    const stats = this.calculateStats();
    cliLogger.debug('CHECKPOINT', 'getCurrentStats called, changeBuffer length: ' + this.changeBuffer.length);
    if (this.changeBuffer.length > 0) {
      cliLogger.debug('CHECKPOINT', 'changeBuffer contents: ' + this.changeBuffer.map(c => `${c.type}: ${c.path}`).join(', '));
    }
    return stats;
  }

  /**
   * 订阅变更事件
   */
  onFileChange(callback: ChangeCallback): () => void {
    this.changeCallbacks.add(callback);
    return () => this.changeCallbacks.delete(callback);
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 检查是否正在监控
   */
  isActive(): boolean {
    return this.isWatching;
  }

  /**
   * 获取 legacy shadow 目录路径（兼容旧数据清理）
   */
  getShadowDir(): string {
    return this.shadowDir;
  }

  /**
   * 获取私有 checkpoint git 仓库路径
   */
  getRepositoryDir(): string {
    return this.shadowGitDir;
  }

  // ==================== 私有辅助方法 ====================

  /**
   * 计算变更统计
   */
  private calculateStats(): ChangeStats {
    const stats: ChangeStats = {
      created: 0,
      modified: 0,
      deleted: 0,
      directories: 0,
      total: 0,
    };

    for (const change of this.changeBuffer) {
      switch (change.type) {
        case 'create':
          stats.created++;
          break;
        case 'modify':
          stats.modified++;
          break;
        case 'delete':
          stats.deleted++;
          break;
        case 'mkdir':
        case 'rmdir':
          stats.directories++;
          break;
      }
    }

    stats.total = stats.created + stats.modified + stats.deleted + stats.directories;
    return stats;
  }

  /**
   * 格式化 commit message
   */
  private formatCommitMessage(label: string, stats: ChangeStats): string {
    const sessionInfo = this.currentSessionId
      ? `\n\nSession: ${this.currentSessionId}\nMessage: ${this.currentMessageIndex}`
      : '';

    return `${label}

Stats: +${stats.created} ~${stats.modified} -${stats.deleted} d${stats.directories}${sessionInfo}`;
  }

  /**
   * 解析 commit message
   */
  private parseCommitMessage(message: string): {
    label: string;
    sessionId: string;
    messageIndex: number;
    stats: ChangeStats;
  } {
    const lines = message.split('\n');
    const label = lines[0] || 'Unknown';

    let sessionId = '';
    let messageIndex = 0;
    const stats: ChangeStats = { created: 0, modified: 0, deleted: 0, directories: 0, total: 0 };

    for (const line of lines) {
      if (line.startsWith('Session:')) {
        sessionId = line.replace('Session:', '').trim();
      } else if (line.startsWith('Message:')) {
        messageIndex = parseInt(line.replace('Message:', '').trim()) || 0;
      } else if (line.startsWith('Stats:')) {
        const match = line.match(/\+(\d+)\s+~(\d+)\s+-(\d+)\s+d(\d+)/);
        if (match) {
          stats.created = parseInt(match[1]);
          stats.modified = parseInt(match[2]);
          stats.deleted = parseInt(match[3]);
          stats.directories = parseInt(match[4]);
          stats.total = stats.created + stats.modified + stats.deleted + stats.directories;
        }
      }
    }

    return { label, sessionId, messageIndex, stats };
  }

  /**
   * 获取文件状态
   */
  private getFileStatus(file: { file: string; insertions?: number; deletions?: number }): 'A' | 'M' | 'D' | 'R' {
    const insertions = file.insertions ?? 0;
    const deletions = file.deletions ?? 0;
    if (insertions > 0 && deletions === 0) return 'A';
    if (deletions > 0 && insertions === 0) return 'D';
    return 'M';
  }

  /**
   * 清理过期 checkpoints 并压缩存储
   */
  /**
   * 把历史截断到只剩最近 keepCount 个 checkpoint。
   *
   *   从 cleanupOldCheckpoints 里抽出来 —— 字节预算那条路要再截一次, 两处一份实现。
   *   失败不抛: filter-branch 在某些仓库形态下会失败, 那时退回"只 GC", 行为跟以前一样。
   */
  private async truncateHistoryTo(keepCount: number): Promise<boolean> {
    const checkpoints = await this.getCheckpoints(keepCount + 10);
    if (checkpoints.length <= keepCount) return false;
    const keepFrom = checkpoints[keepCount - 1];
    if (!keepFrom?.id) return false;
    try {
      /* 将最老保留点变为新的 root commit（orphan） */
      await this.git.raw(['replace', '--graft', keepFrom.id]);
      await this.git.raw(['filter-branch', '--', '--all']);
      const refs = await this.git.raw(['for-each-ref', '--format=%(refname)', 'refs/replace/']);
      for (const ref of refs.trim().split('\n').filter(Boolean)) {
        await this.git.raw(['update-ref', '-d', ref]);
      }
      return true;
    } catch {
      cliLogger.debug('CHECKPOINT', 'History truncation failed, falling back to GC only');
      return false;
    }
  }

  private async cleanupOldCheckpoints(): Promise<void> {
    try {
      const checkpoints = await this.getCheckpoints(this.config.maxCheckpoints + 10);

      if (checkpoints.length > this.config.maxCheckpoints) {
        const toRemove = checkpoints.length - this.config.maxCheckpoints;
        cliLogger.debug('CHECKPOINT', `Pruning ${toRemove} old checkpoints (${checkpoints.length} > ${this.config.maxCheckpoints})`);
        await this.truncateHistoryTo(this.config.maxCheckpoints);
        // 强制 GC 回收空间
        await this.compressRepository();
      }

      // 定期 GC：每 10 个 checkpoint 压缩一次
      if (checkpoints.length > 0 && checkpoints.length % 10 === 0) {
        await this.compressRepository();
      }

      const MAX_REPO_BYTES = 200 * 1024 * 1024;
      const MIN_KEEP = 10;
      let repoSize = await this.getRepositorySize();
      if (repoSize > MAX_REPO_BYTES) {
        let keep = this.config.maxCheckpoints;
        for (let round = 0; round < 3 && repoSize > MAX_REPO_BYTES && keep > MIN_KEEP; round++) {
          keep = Math.max(MIN_KEEP, Math.floor(keep / 2));
          cliLogger.warn('CHECKPOINT',
            `shadow 仓 ${this.formatFileSize(repoSize)} 超过预算 ${this.formatFileSize(MAX_REPO_BYTES)}, `
            + `把保留条数压到 ${keep} 再压缩`);
          const truncated = await this.truncateHistoryTo(keep);
          await this.compressRepository();
          repoSize = await this.getRepositorySize();
          if (!truncated) break;   /* 截不动就别空转三轮 */
        }
        if (repoSize > MAX_REPO_BYTES) {
          cliLogger.warn('CHECKPOINT',
            `shadow 仓仍有 ${this.formatFileSize(repoSize)} (保底保留 ${MIN_KEEP} 个 checkpoint, 不再往下截) —— `
            + `要彻底清掉请在 设置 → 存储 里操作`);
        }
      }
    } catch (error) {
      cliLogger.error('CHECKPOINT', 'Failed to cleanup checkpoints', { error });
    }
  }

  /**
   * 压缩 Git 仓库以节省磁盘空间
   */
  async compressRepository(): Promise<{ success: boolean; savedBytes?: number }> {
    if (!this.initialized) {
      return { success: false };
    }

    try {
      // 获取压缩前的仓库大小
      const beforeSize = await this.getRepositorySize();

      cliLogger.debug('CHECKPOINT', 'Compressing repository...');

      // 1. 清理未引用的对象
      await this.git.raw(['reflog', 'expire', '--expire=now', '--all']);

      // 2. 运行垃圾回收（压缩 pack 文件）
      await this.git.raw(['gc', '--aggressive', '--prune=now']);

      // 3. 重新打包以优化存储
      await this.git.raw(['repack', '-a', '-d', '--depth=250', '--window=250']);

      // 获取压缩后的仓库大小
      const afterSize = await this.getRepositorySize();
      const savedBytes = beforeSize - afterSize;

      cliLogger.debug('CHECKPOINT', `Repository compressed: ${this.formatFileSize(beforeSize)} → ${this.formatFileSize(afterSize)} (saved ${this.formatFileSize(savedBytes)})`);

      return { success: true, savedBytes };
    } catch (error) {
      cliLogger.error('CHECKPOINT', 'Failed to compress repository', { error });
      return { success: false };
    }
  }

  /**
   * 获取 shadow git 仓库大小
   */
  private async getRepositorySize(): Promise<number> {
    let totalSize = 0;

    const calculateSize = async (dirPath: string) => {
      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);
          if (entry.isDirectory()) {
            await calculateSize(fullPath);
          } else if (entry.isFile()) {
            const stat = await fs.stat(fullPath);
            totalSize += stat.size;
          }
        }
      } catch {
        // 忽略无法访问的目录
      }
    };

    await calculateSize(this.shadowGitDir);
    return totalSize;
  }

  /**
   * 获取存储统计信息
   */
  async getStorageStats(): Promise<{
    repositorySize: number;
    shadowDirSize: number;
    checkpointCount: number;
    oldestCheckpoint?: { id: string; timestamp: number };
    newestCheckpoint?: { id: string; timestamp: number };
  }> {
    const repositorySize = await this.getRepositorySize();

    let shadowDirSize = 0;
    const calculateShadowSize = async (dirPath: string) => {
      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);
          if (entry.isDirectory() && entry.name !== '.git') {
            await calculateShadowSize(fullPath);
          } else if (entry.isFile()) {
            const stat = await fs.stat(fullPath);
            shadowDirSize += stat.size;
          }
        }
      } catch {
        // 忽略
      }
    };
    await calculateShadowSize(this.shadowDir);

    const checkpoints = await this.getCheckpoints(1000);

    return {
      repositorySize,
      shadowDirSize,
      checkpointCount: checkpoints.length,
      oldestCheckpoint: checkpoints.length > 0 ? {
        id: checkpoints[checkpoints.length - 1].id,
        timestamp: checkpoints[checkpoints.length - 1].timestamp,
      } : undefined,
      newestCheckpoint: checkpoints.length > 0 ? {
        id: checkpoints[0].id,
        timestamp: checkpoints[0].timestamp,
      } : undefined,
    };
  }

  /**
   * 清理 stale Git lock 文件
   * 当 git 进程异常退出时可能遗留 index.lock 文件
   */
  private async cleanStaleLocks(): Promise<void> {
    const lockFile = path.join(this.shadowGitDir, 'index.lock');
    try {
      const exists = fsSync.existsSync(lockFile);
      if (exists) {
        // 检查 lock 文件年龄，只删除超过 10 秒的 lock（避免删除正在使用的）
        const stat = await fs.stat(lockFile);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > 10000) {
          await fs.unlink(lockFile);
          cliLogger.debug('CHECKPOINT', 'Cleaned stale lock file');
        }
      }
    } catch (error) {
      // 忽略清理失败
    }
  }

  /**
   * 带锁和重试的 Git 操作包装器
   * 确保同一时间只有一个 git 操作在执行，避免 index.lock 冲突
   */
  private async withGitLock<T>(operation: () => Promise<T>): Promise<T> {
    // 在锁队列中排队
    const previousLock = this.gitOperationLock;
    let resolveLock: (value?: any) => void = () => {};

    this.gitOperationLock = new Promise((resolve) => {
      resolveLock = resolve;
    });

    try {
      // 等待前面的操作完成
      await previousLock;

      // 带重试执行操作
      let lastError: any;
      for (let attempt = 1; attempt <= this.GIT_RETRY_ATTEMPTS; attempt++) {
        try {
          // 在重试前清理 stale lock
          if (attempt > 1) {
            await this.cleanStaleLocks();
            // 延迟重试
            await new Promise(resolve => setTimeout(resolve, this.GIT_RETRY_DELAY_MS));
          }

          const result = await operation();
          return result;
        } catch (error: any) {
          lastError = error;

          // 检查是否是 lock 文件错误
          const isLockError = error.message && (
            error.message.includes('index.lock') ||
            error.message.includes('File exists')
          );

          if (!isLockError || attempt === this.GIT_RETRY_ATTEMPTS) {
            // 不是 lock 错误，或已达到最大重试次数
            throw error;
          }

          cliLogger.warn('CHECKPOINT', `Git operation failed (attempt ${attempt}/${this.GIT_RETRY_ATTEMPTS}), retrying...`);
        }
      }

      throw lastError;
    } finally {
      // 释放锁
      resolveLock!();
    }
  }

  /**
   * 销毁实例
   */
  async destroy(): Promise<void> {
    await this.stopWatching();
    this.initialized = false;
    this.changeCallbacks.clear();
    cliLogger.debug('CHECKPOINT', 'Instance destroyed');
  }
}
