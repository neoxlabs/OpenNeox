
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FileUnchangedResult } from './types.js';
import { collectSessionChanges, type SessionChanges } from './sessionChanges.js';
import type { ChangeFile } from './changeSet.js';

export type UndoVia = 'checkpoint' | 'snapshot' | 'none';

/** 对账需要的能力 —— ShadowGitCheckpoint 满足 */
export interface ReconcileSource {
  getCheckpoints(limit?: number, sessionId?: string): Promise<any[]>;
  getCommitFileChanges(commitId: string): Promise<any[]>;
  isFileUnchangedSinceCommit?(commitId: string, filePath: string): Promise<FileUnchangedResult>;
}

/** 原内容快照 (fileSnapshotStore) 需要的能力 */
export interface SnapshotSource {
  listFileSnapshots(): Promise<Array<{ id: string; filePath: string; savedAt: number }>>;
  readFileSnapshot(id: string): Promise<string | null>;
}

export interface ReconciledFile extends ChangeFile {
  /** 磁盘内容是否仍是「那一轮改完后」的样子; null = 比不了 (没有提交 / git 出错) */
  unchanged: boolean | null;
  /** 当前磁盘内容 sha256; 文件不存在为 null */
  diskHash: string | null;
  /** 那一轮之前最近的一份原内容快照 */
  snapshotId?: string;
  /** 快照内容 sha256 (有快照时才给) */
  snapshotHash?: string;
  undoVia: UndoVia;
}

export interface SessionReconciliation {
  sessionId: string;
  /** 最近一轮改动的提交 —— 重启后撤销「上一轮」就从这个提交出发 */
  turnCommit?: string;
  files: ReconciledFile[];
  summary: {
    total: number;
    /** 可以安全整文件回滚 (磁盘未被用户改过) */
    verified: number;
    /** 用户之后改过 —— 撤销会冲掉他的改动 */
    userModified: number;
    /** 没法判断 */
    unknown: number;
    /** checkpoint 不可用, 但有原内容快照能兜底 */
    snapshotOnly: number;
  };
}

export interface ReconcileOptions {
  source: ReconcileSource;
  snapshots: SnapshotSource;
  sessionId: string;
  workspacePath: string;
  /** 已经算好的 session changes —— 省一次重复查询 */
  changes?: SessionChanges;
  /** 只对账最近 N 轮 (默认 1, 撤销只用最近一轮) */
  turns?: number;
}

function normalizeRel(workspacePath: string, filePath: string): string {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(workspacePath, filePath);
  const rel = path.relative(path.resolve(workspacePath), abs);
  return (rel || filePath).split(path.sep).join('/');
}

async function sha256OfFile(absPath: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(absPath);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

function sha256OfText(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex');
}

export async function reconcileSessionChanges(options: ReconcileOptions): Promise<SessionReconciliation> {
  const { source, snapshots, sessionId, workspacePath } = options;
  const empty: SessionReconciliation = {
    sessionId,
    files: [],
    summary: { total: 0, verified: 0, userModified: 0, unknown: 0, snapshotOnly: 0 },
  };
  if (!sessionId || !workspacePath) return empty;

  const changes = options.changes ?? await collectSessionChanges(source as any, sessionId);
  const turns = options.turns && options.turns > 0 ? changes.turns.slice(0, options.turns) : changes.turns;
  if (turns.length === 0) return empty;

  /* 每个文件归「最近一次改过它的那一轮」—— 护栏用那一轮的提交做基准, 和 CLI /undo 一致。
   * 只对账 turns 范围内的文件: 落在更早轮次的文件这里不做判定, 调用方回退到逐文件查,
   * 免得把「没对账」误当成「无法确认」而白白跳过可撤的文件。 */
  const scope = new Map<string, { file: ChangeFile; turn: SessionChanges['turns'][number] }>();
  for (const turn of turns) {
    for (const file of turn.files) {
      if (!scope.has(file.path)) scope.set(file.path, { file, turn });
    }
  }

  let snapshotList: Array<{ id: string; filePath: string; savedAt: number }> = [];
  try {
    snapshotList = await snapshots.listFileSnapshots();
  } catch { /* 快照索引读不出来只影响兜底, 不影响 checkpoint 判定 */ }

  const files: ReconciledFile[] = [];

  for (const [filePath, { file, turn }] of scope) {
    let unchanged: boolean | null = null;
    if (typeof source.isFileUnchangedSinceCommit === 'function') {
      try {
        const guard = await source.isFileUnchangedSinceCommit(turn.commit, filePath);
        unchanged = guard.unchanged === true;
      } catch {
        unchanged = null;
      }
    }

    /* 候选快照: 同路径、且保存时间不晚于那一轮提交 —— 那是「AI 动手之前」的原内容 */
    const cutoff = turn.timestamp ?? Date.now();
    let snapshot: { id: string; savedAt: number } | undefined;
    for (const meta of snapshotList) {
      if (normalizeRel(workspacePath, meta.filePath) !== filePath) continue;
      if (meta.savedAt > cutoff) continue;
      if (!snapshot || meta.savedAt > snapshot.savedAt) snapshot = meta;
    }

    let snapshotHash: string | undefined;
    if (snapshot) {
      const text = await snapshots.readFileSnapshot(snapshot.id).catch(() => null);
      if (text === null) snapshot = undefined;
      else snapshotHash = sha256OfText(text);
    }

    const diskHash = await sha256OfFile(path.resolve(workspacePath, filePath));

    /* checkpoint 的护栏过了 = 可以整文件回滚; 比不了 (null) 但有原内容快照 = 快照兜底;
     * 用户改过 (false) 一律 none —— 拿快照覆盖同样会冲掉他的改动。 */
    const undoVia: UndoVia = unchanged === true
      ? 'checkpoint'
      : unchanged === null && snapshot ? 'snapshot' : 'none';

    files.push({
      ...file,
      unchanged,
      diskHash,
      ...(snapshot ? { snapshotId: snapshot.id } : {}),
      ...(snapshotHash ? { snapshotHash } : {}),
      undoVia,
    });
  }

  const summary = { total: files.length, verified: 0, userModified: 0, unknown: 0, snapshotOnly: 0 };
  for (const file of files) {
    if (file.undoVia === 'checkpoint') summary.verified++;
    else if (file.undoVia === 'snapshot') summary.snapshotOnly++;
    else if (file.unchanged === false) summary.userModified++;
    else summary.unknown++;
  }

  return {
    sessionId,
    ...(turns[0] ? { turnCommit: turns[0].commit } : {}),
    files,
    summary,
  };
}
