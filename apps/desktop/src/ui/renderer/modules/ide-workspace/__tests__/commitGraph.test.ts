/* 分支图的泳道分配 —— 纯函数, 拿真实拓扑当样本钉住。
 *
 * 这些形状不是编的, 是 git 里最常见的四种:
 *   直线 / 分叉后 merge 回来 / 连续两个 merge / 根提交。
 * 画错的表现是"线连到不相干的提交上", 而那种错在界面上很难一眼看出是错的
 * (看起来只是"这仓库历史有点乱"), 所以在这一层钉死。
 */
import { describe, it, expect } from 'vitest';
import { layoutCommitGraph, graphWidth, type GraphCommit } from '../commitGraph';

/** helper: 'A B' → { hash:'A', parents:['B'] } */
const c = (spec: string): GraphCommit => {
  const [hash, ...parents] = spec.split(' ');
  return { hash: hash!, parents };
};

describe('layoutCommitGraph', () => {
  it('一条直线全在 0 道, 没有分叉也没有汇合', () => {
    const rows = layoutCommitGraph(['A B', 'B C', 'C'].map(c));
    expect(rows.map(r => r.lane)).toEqual([0, 0, 0]);
    expect(rows.every(r => r.forks.length === 0 && r.merges.length === 0)).toBe(true);
    expect(graphWidth(rows)).toBe(1);
    /* 最后一条是根提交 —— 下面不该再画线 */
    expect(rows[2]!.hasParentLine).toBe(false);
    expect(rows[0]!.hasParentLine).toBe(true);
  });

  it('merge: 第二个父开新道, 两条线在共同祖先处汇合', () => {
    /*  M ─┬─ A ─┐
     *     └─ B ─┴─ C      M 是 merge(A,B), A 和 B 都指向 C
     */
    const rows = layoutCommitGraph(['M A B', 'A C', 'B C', 'C'].map(c));

    expect(rows[0]!.isMerge).toBe(true);
    /* M 在 0 道, 第二个父 B 被安排到一条新道 */
    expect(rows[0]!.lane).toBe(0);
    expect(rows[0]!.forks).toEqual([{ from: 0, to: 1 }]);

    expect(rows[1]!.lane).toBe(0);          /* A 继续走 0 道 */
    expect(rows[2]!.lane).toBe(1);          /* B 走分出去那条 */

    /* C 被两条道同时等着 → 保留最左, 另一条并进来 */
    expect(rows[3]!.lane).toBe(0);
    expect(rows[3]!.merges).toEqual([{ from: 1, to: 0 }]);
    expect(graphWidth(rows)).toBe(2);
  });

  it('A 那一行要把 B 的道画成穿过去的直线', () => {
    const rows = layoutCommitGraph(['M A B', 'A C', 'B C', 'C'].map(c));
    /* 处理 A 时 1 道上还挂着 B, 那条线得穿过 A 这一行, 否则画出来是断的 */
    expect(rows[1]!.through).toContain(1);
  });

  it('两个连续 merge 各自开道, 道号不复用到已占用的位置', () => {
    const rows = layoutCommitGraph(['M1 M2 X', 'M2 A Y', 'A Z', 'X Z', 'Y Z', 'Z'].map(c));
    expect(rows[0]!.isMerge).toBe(true);
    expect(rows[1]!.isMerge).toBe(true);
    /* 同一时刻 X / Y / 主线各占一道, 不能撞在一起 */
    const lanesAtY = rows[4]!;
    expect(lanesAtY.lane).not.toBe(rows[3]!.lane);
    expect(graphWidth(rows)).toBeGreaterThanOrEqual(3);
  });

  it('父不在这一页里 (翻到底) 也不崩, 那条道继续留着', () => {
    /* B 的父 ZZZ 没加载进来 —— 不该抛, 也不该把 B 当根提交 */
    const rows = layoutCommitGraph(['A B', 'B ZZZ'].map(c));
    expect(rows).toHaveLength(2);
    expect(rows[1]!.hasParentLine).toBe(true);
  });

  it('width 不被历史峰值永久撑着 —— 分支合完就缩回去', () => {
    const rows = layoutCommitGraph(['M A B', 'A C', 'B C', 'C', 'D'].map(c));
    /* 合并完之后剩下的行不该还占着 2 道 */
    expect(rows[4]!.width).toBeLessThanOrEqual(rows[0]!.width);
  });

  it('空输入返回空, 不抛', () => {
    expect(layoutCommitGraph([])).toEqual([]);
    expect(graphWidth([])).toBe(1);
  });

  it('hash 是短的、parents 是全的 —— 截齐后照样连成一条线', () => {
    const full = (n: string) => n.repeat(40).slice(0, 40);
    const commits: GraphCommit[] = [
      { hash: 'aaaaaaa', parents: [full('b')] },
      { hash: 'bbbbbbb', parents: [full('c')] },
      { hash: 'ccccccc', parents: [] },
    ];
    const rows = layoutCommitGraph(commits);
    expect(rows.map(r => r.lane)).toEqual([0, 0, 0]);
    expect(graphWidth(rows)).toBe(1);
  });

  it('反过来 (hash 全 / parents 短) 也接得上', () => {
    const full = (n: string) => n.repeat(40).slice(0, 40);
    const rows = layoutCommitGraph([
      { hash: full('a'), parents: ['bbbbbbb'] },
      { hash: full('b'), parents: [] },
    ]);
    expect(rows.map(r => r.lane)).toEqual([0, 0]);
    expect(graphWidth(rows)).toBe(1);
  });
});
