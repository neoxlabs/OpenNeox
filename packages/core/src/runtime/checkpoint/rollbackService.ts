
import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  CheckpointListItem,
  CommitFileChange,
  FileUnchangedResult,
  RollbackFileOptions,
  RollbackFileResult,
} from './types.js';
import { collectSessionChanges, type SessionChanges } from './sessionChanges.js';
import type { ChangeSet, ChangeTurn } from './changeSet.js';

/** RollbackService 依赖的只读/撤销能力 —— ShadowGitCheckpoint 天然满足 */
export interface RollbackChangeSource {
  getCheckpoints(limit?: number, sessionId?: string): Promise<CheckpointListItem[]>;
  getCommitFileChanges(commitId: string): Promise<CommitFileChange[]>;
  isFileUnchangedSinceCommit?(commitId: string, filePath: string): Promise<FileUnchangedResult>;
  rollbackSingleFile(filePath: string, options?: RollbackFileOptions): Promise<RollbackFileResult>;
  reapplySingleFile(filePath: string): Promise<{ success: boolean; error?: string }>;
}

export interface RollbackServiceDeps {
  source: RollbackChangeSource;
  /** 当前工作区绝对路径 —— revertHunk 直接改磁盘, 必须做边界校验 */
  getWorkspace: () => string | null;
}

export interface RevertHunkInput {
  filePath: string;
  oldString?: string;
  newString?: string;
  /** hunk 在新文件里的起始行 (1-based); 缺省时全文找 */
  startLine?: number;
}

export interface RevertHunkResult {
  success: boolean;
  error?: string;
  /** 命中的字节偏移, 便于调用方日志 / 调试 */
  matchedAt?: number;
  /** true = 在 startLine 附近命中; false = 退到全文命中 */
  anchored?: boolean;
}

export interface RevertTurnOptions {
  /** 只撤这些文件 (缺省 = 该提交改的全部文件) */
  files?: readonly string[];
  /** 跳过「用户之后手改过」的护栏 */
  force?: boolean;
  /** 护栏基准提交; 缺省用 commit 本身 */
  guardCommit?: string;
}

export interface TurnRevertResult {
  commit: string;
  restored: string[];
  skipped: Array<{ path: string; reason?: 'user-modified' | 'unknown' }>;
  failed: Array<{ path: string; error?: string }>;
}

/** startLine 附近的搜索容差 (行) —— 用户小幅手改 / 前一个 hunk 已撤销导致的行号漂移 */
const LINE_TOLERANCE = 25;

export class RollbackService {
  constructor(private readonly deps: RollbackServiceDeps) {}

  private get source(): RollbackChangeSource {
    return this.deps.source;
  }

  /** 会话级改动清单 (ChangeSet 是唯一结构, 见 changeSet.ts) */
  async list(sessionId: string): Promise<ChangeSet> {
    return (await this.listSession(sessionId)).changeSet;
  }

  /** 同 list, 但保留每轮明细 (撤销「上一轮」要用 turns[0]) */
  async listSession(sessionId: string): Promise<SessionChanges> {
    return collectSessionChanges(this.source, sessionId);
  }

  /** 单文件回滚 —— 整文件回到该轮改动之前; AI 新建的文件删掉 */
  async revertFile(filePath: string, options: RollbackFileOptions = {}): Promise<RollbackFileResult> {
    if (!filePath) return { success: false, error: 'Missing file path' };
    return this.source.rollbackSingleFile(filePath, options);
  }

  /** 重新应用 (撤销的反向操作) —— 从当前 HEAD 恢复文件 */
  async reapply(filePath: string): Promise<{ success: boolean; error?: string }> {
    if (!filePath) return { success: false, error: 'Missing file path' };
    return this.source.reapplySingleFile(filePath);
  }

  /**
   * 撤销一轮的全部 (或部分) 文件。
   *
   * 串行 + 按路径倒序: 重命名 / 目录树改动时先动深层路径, 避免前面的恢复把后面
   * 文件的位置挪掉。每个文件仍各自过护栏 —— 一个文件被用户手改过不影响其它文件。
   */
  async revertTurn(commit: string, options: RevertTurnOptions = {}): Promise<TurnRevertResult> {
    const result: TurnRevertResult = { commit, restored: [], skipped: [], failed: [] };
    if (!commit) {
      result.failed.push({ path: '*', error: 'Missing commit' });
      return result;
    }

    let files: CommitFileChange[];
    try {
      files = await this.source.getCommitFileChanges(commit);
    } catch (error: any) {
      result.failed.push({ path: '*', error: String(error?.message ?? error) });
      return result;
    }

    const wanted = options.files ? files.filter(f => options.files!.includes(f.path)) : files;
    const ordered = [...wanted].sort((a, b) => b.path.localeCompare(a.path));

    for (const file of ordered) {
      try {
        const r = await this.source.rollbackSingleFile(file.path, {
          guardCommit: options.guardCommit ?? commit,
          force: options.force,
        });
        if (r?.success) result.restored.push(file.path);
        else if (r?.skipped) result.skipped.push({ path: file.path, reason: r.reason });
        else result.failed.push({ path: file.path, error: r?.error });
      } catch (error: any) {
        result.failed.push({ path: file.path, error: String(error?.message ?? error) });
      }
    }
    return result;
  }

  /**
   * 单 hunk 反向替换 (撤销一行 / 一小段)。
   *
   * 用偏移定位而不是裸 String.replace: 同一份 newString 在文件里出现多次时, 裸替换
   * 永远命中第一个, 用户点第二个 hunk 撤销的却是第一个。这里按 startLine 折算成
   * 字节偏移, 只在其附近找; 附近没有才退到全文 (老卡片没有 startLine)。
   */
  async revertHunk(input: RevertHunkInput): Promise<RevertHunkResult> {
    const { filePath, oldString, newString, startLine } = input ?? ({} as RevertHunkInput);
    if (!filePath || typeof oldString !== 'string' || typeof newString !== 'string') {
      return { success: false, error: 'invalid args (likely previewTruncated hunk)' };
    }

    const absolutePath = this.resolveInWorkspace(filePath);
    if (typeof absolutePath !== 'string') return absolutePath;

    try {
      const content = await fs.readFile(absolutePath, 'utf-8');
      const searchStart = this.offsetForLine(content, startLine);

      let hit = content.indexOf(newString, searchStart);
      let anchored = true;
      if (hit < 0) {
        hit = content.indexOf(newString);
        anchored = false;
      }
      if (hit < 0) {
        return { success: false, error: 'hunk content not found in file (file may have been modified)' };
      }

      const next = content.slice(0, hit) + oldString + content.slice(hit + newString.length);
      await fs.writeFile(absolutePath, next, 'utf-8');
      return { success: true, matchedAt: hit, anchored };
    } catch (error: any) {
      return { success: false, error: error?.message ?? String(error) };
    }
  }

  /** 第 line (1-based) 往前退 LINE_TOLERANCE 行的字节偏移 */
  private offsetForLine(content: string, line?: number): number {
    if (typeof line !== 'number' || line <= 0) return 0;
    const lines = content.split('\n');
    const anchor = Math.max(0, Math.min(lines.length, line - 1 - LINE_TOLERANCE));
    let offset = 0;
    for (let i = 0; i < anchor; i++) offset += lines[i].length + 1;
    return offset;
  }

  /** 工作区边界校验 —— 撤销 hunk 直接写磁盘, 不能被 ../ 带到工作区外 */
  private resolveInWorkspace(filePath: string): string | RevertHunkResult {
    const workspace = this.deps.getWorkspace();
    if (!workspace) return { success: false, error: 'No workspace set' };
    const root = path.resolve(workspace);
    const absolute = path.resolve(root, filePath);
    const rel = path.relative(root, absolute);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return { success: false, error: `Path escapes workspace: ${filePath}` };
    }
    return absolute;
  }
}

/** 供上层把 turns 直接当 ChangeTurn 用的窄化 (撤销按钮只认最近一轮) */
export function latestTurnOf(changes: SessionChanges): ChangeTurn | undefined {
  return changes.turns[0];
}
