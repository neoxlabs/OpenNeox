import { describe, it, expect } from 'vitest';
import {
  changeSetOfTurn,
  mergeChangeTurns,
  totalsOf,
  type ChangeFile,
  type ChangeTurn,
} from '../changeSet.js';

const file = (path: string, status: ChangeFile['status'], additions = 0, deletions = 0): ChangeFile => ({
  path, status, additions, deletions,
});

const turn = (commit: string, timestamp: number, files: ChangeFile[]): ChangeTurn => ({
  commit, timestamp, label: 'Message completed', files,
});

describe('mergeChangeTurns —— 会话级合并口径', () => {
  it('同一文件多轮: 行数累加, 会话内新建仍是 A', () => {
    const set = mergeChangeTurns([
      turn('t2', 2, [file('new.ts', 'M', 2, 0)]),
      turn('t1', 1, [file('new.ts', 'A', 10, 0)]),
    ]);
    expect(set.files).toEqual([{ path: 'new.ts', status: 'A', additions: 12, deletions: 0 }]);
    expect(set.scope).toBe('session');
    expect(set.turns!.map(t => t.commit)).toEqual(['t2', 't1']);
  });

  it('最新一轮删除 → 以 D 为准, 但行数不丢', () => {
    const set = mergeChangeTurns([
      turn('t2', 2, [file('old.ts', 'D', 0, 4)]),
      turn('t1', 1, [file('old.ts', 'M', 1, 0)]),
    ]);
    expect(set.files[0]).toMatchObject({ status: 'D', additions: 1, deletions: 4 });
  });

  it('按路径排序, 合计与逐文件相加一致', () => {
    const set = mergeChangeTurns([
      turn('t1', 1, [file('b.ts', 'M', 1, 2), file('a.ts', 'A', 3, 0)]),
    ]);
    expect(set.files.map(f => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(set.totals).toEqual({ files: 2, additions: 4, deletions: 2 });
    expect(set.totals).toEqual(totalsOf(set.files));
  });
});

describe('changeSetOfTurn —— 单轮结构', () => {
  it('一轮的列表 / 合计 / scope 都对得上', () => {
    const set = changeSetOfTurn('c1', 1700000000000, 'Message completed', [
      file('a.ts', 'M', 3, 1),
      file('b.ts', 'A', 7, 0),
    ]);
    expect(set.scope).toBe('turn');
    expect(set.turns).toBeUndefined();
    expect(set.files.map(f => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(set.totals).toEqual({ files: 2, additions: 10, deletions: 1 });
  });
});

describe('三端一致性', () => {
  /* CLI 的 /changes 用 files, 手机只看 totals, 桌面复核按文件 —— 三者必须同时成立 */
  it('会话清单 = 逐轮合并结果, 三端拿到的数字相同', () => {
    const turns = [
      turn('t2', 2, [file('src/a.ts', 'M', 4, 2), file('src/new.ts', 'M', 1, 0)]),
      turn('t1', 1, [file('src/new.ts', 'A', 6, 0)]),
    ];
    const set = mergeChangeTurns(turns);

    /* CLI: 一行一个文件 */
    expect(set.files).toEqual([
      { path: 'src/a.ts', status: 'M', additions: 4, deletions: 2 },
      { path: 'src/new.ts', status: 'A', additions: 7, deletions: 0 },
    ]);

    /* 桌面 / 手机: 合计不能自己再加一遍 */
    const byHand = set.files.reduce(
      (acc, f) => ({ files: acc.files + 1, additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
      { files: 0, additions: 0, deletions: 0 },
    );
    expect(set.totals).toEqual(byHand);

    /* 每轮明细也能独立算 —— 与单轮 ChangeSet 同一口径 */
    const first = changeSetOfTurn(turns[0]!.commit, turns[0]!.timestamp, turns[0]!.label, turns[0]!.files);
    expect(first.totals).toEqual(totalsOf(turns[0]!.files));
  });
});
