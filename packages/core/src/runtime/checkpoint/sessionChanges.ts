
import type { CheckpointListItem, CommitFileChange } from './types.js';
import { mergeChangeTurns, type ChangeSet } from './changeSet.js';

/** 只依赖这两个方法, 便于单测替身 (不需要真 git) */
export interface SessionChangeSource {
  getCheckpoints(limit?: number, sessionId?: string): Promise<CheckpointListItem[]>;
  getCommitFileChanges(commitId: string): Promise<CommitFileChange[]>;
}

export interface TurnChanges {
  commit: string;
  timestamp: number;
  label: string;
  files: CommitFileChange[];
}

export interface SessionChanges {
  /** 改过文件的轮次, 新 → 旧 (turns[0] = 最近一次真的动了文件的那一轮) */
  turns: TurnChanges[];
  /** 本会话累计改动, 一个文件一行 */
  files: CommitFileChange[];
  /** 同一份数据落成 ChangeSet —— 桌面 / CLI / 手机都从这里取 (EDIT-02) */
  changeSet: ChangeSet;
}

/** 每轮收尾提交的 label (见 runtimeOrchestrator: finishMessageInBackground) */
const TURN_LABELS = new Set(['message completed', 'message interrupted']);

export async function collectSessionChanges(
  source: SessionChangeSource,
  sessionId: string,
  limit = 50,
): Promise<SessionChanges> {
  if (!sessionId) return { turns: [], files: [], changeSet: mergeChangeTurns([]) };

  const items = await source.getCheckpoints(limit, sessionId);
  const turns: TurnChanges[] = [];

  for (const item of items) {
    if (!TURN_LABELS.has((item.label || '').trim().toLowerCase())) continue;
    const files = await source.getCommitFileChanges(item.id);
    /* 改了又改回去 → 收尾提交里一个文件都没有; 这种轮次没什么可撤的, 不进清单 */
    if (files.length === 0) continue;
    turns.push({
      commit: item.id,
      timestamp: item.timestamp,
      label: item.label,
      files,
    });
  }

  const changeSet = mergeChangeTurns(turns);
  return { turns, files: changeSet.files, changeSet };
}
