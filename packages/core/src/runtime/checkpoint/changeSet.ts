
import type { CommitFileChange } from './types.js';

/** A=新建 M=修改 D=删除 R=重命名 */
export type ChangeStatus = 'A' | 'M' | 'D' | 'R';

/** 一个文件的改动 */
export interface ChangeFile {
  path: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
}

/** 一轮 (一次 checkpoint 提交) 的改动 */
export interface ChangeTurn {
  commit: string;
  timestamp: number;
  label: string;
  files: ChangeFile[];
}

export interface ChangeTotals {
  files: number;
  additions: number;
  deletions: number;
}

export interface ChangeSet {
  /** 结构版本 —— 以后加字段时调用方可以按它判断 */
  version: 1;
  /** turn = 一轮的改动; session = 本会话累计 */
  scope: 'turn' | 'session';
  files: ChangeFile[];
  totals: ChangeTotals;
  /** scope='session' 时带上每轮明细 (新 → 旧), turn 级不带 */
  turns?: ChangeTurn[];
}

function toChangeFile(file: CommitFileChange): ChangeFile {
  return {
    path: file.path,
    status: file.status,
    additions: Number.isFinite(file.additions) ? file.additions : 0,
    deletions: Number.isFinite(file.deletions) ? file.deletions : 0,
  };
}

/** 一轮提交的 git 变更 → ChangeSet (单轮) */
export function changeSetOfTurn(
  commit: string,
  timestamp: number,
  label: string,
  files: readonly CommitFileChange[],
): ChangeSet {
  const normalized = files.map(toChangeFile);
  return {
    version: 1,
    scope: 'turn',
    files: normalized,
    totals: totalsOf(normalized),
  };
}

/** 行数 / 文件数合计 —— 三端显示同一个数, 不再各加一遍 */
export function totalsOf(files: readonly ChangeFile[]): ChangeTotals {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { files: files.length, additions, deletions };
}

/**
 * 把多轮提交合并成会话级清单。
 *
 * 口径 (CLI-05 起就这么定, 别改): 行数按轮累加; 状态保留「最先出现的那个」——
 * 会话内新建的文件后来被改, 仍然显示「新建」; 只有最新一轮是删除时以 D 为准。
 * `turns` 按**新 → 旧**给, 所以要从最旧一轮往前合并, A 才能一路保留到后面。
 */
export function mergeChangeTurns(turns: readonly ChangeTurn[]): ChangeSet {
  const acc = new Map<string, ChangeFile>();
  for (let i = turns.length - 1; i >= 0; i--) {
    for (const file of turns[i]!.files) {
      const prev = acc.get(file.path);
      if (!prev) {
        acc.set(file.path, { ...file });
        continue;
      }
      acc.set(file.path, {
        path: file.path,
        /* 最新一轮是删除 → 以删除为准; 否则保留更早的状态 */
        status: file.status === 'D' ? 'D' : prev.status,
        additions: prev.additions + file.additions,
        deletions: prev.deletions + file.deletions,
      });
    }
  }
  const files = [...acc.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    version: 1,
    scope: 'session',
    files,
    totals: totalsOf(files),
    turns: [...turns],
  };
}

export const EMPTY_CHANGE_SET: ChangeSet = {
  version: 1,
  scope: 'session',
  files: [],
  totals: { files: 0, additions: 0, deletions: 0 },
  turns: [],
};
