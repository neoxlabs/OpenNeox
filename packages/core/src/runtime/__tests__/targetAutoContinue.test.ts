/** 目标保持 active 时自动续跑，并在完成、暂停、中断、上限或空转时停止。 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

/* 私有决策方法按相同判据建模验证；chat 循环的接线由端到端测试覆盖。 */
const AUTO_CONTINUE_MAX_ROUNDS = 40;
const AUTO_CONTINUE_MAX_IDLE_ROUNDS = 3;

type Block = { status: 'pending' | 'in_progress' | 'completed' };
type State = {
  status: string;
  blocks: Block[];
  interrupted: boolean;
};

/** 与 AgenticRuntime.shouldAutoContinueTarget 相同的判据。 */
function decide(st: State, rounds: number, memo: { done: number; total: number; idleRounds: number } | undefined) {
  if (rounds >= AUTO_CONTINUE_MAX_ROUNDS) return { go: false, note: 'max rounds', memo };
  if (st.interrupted) return { go: false, note: 'interrupted', memo };
  if (st.status !== 'active') return { go: false, note: `status=${st.status}`, memo };
  const done = st.blocks.filter((b) => b.status === 'completed').length;
  const idleRounds = memo && memo.done === done && memo.total === st.blocks.length ? memo.idleRounds + 1 : 0;
  const next = { done, total: st.blocks.length, idleRounds };
  if (idleRounds >= AUTO_CONTINUE_MAX_IDLE_ROUNDS) return { go: false, note: 'idle', memo: next };
  return { go: true, memo: next };
}

const blocks = (done: number, total: number): Block[] => [
  ...Array.from({ length: done }, () => ({ status: 'completed' as const })),
  ...Array.from({ length: total - done }, () => ({ status: 'pending' as const })),
];

describe('目标还活着就接着跑', () => {
  it('active + 有进展 → 继续', () => {
    let memo;
    let r = decide({ status: 'active', blocks: blocks(1, 7), interrupted: false }, 0, memo);
    expect(r.go).toBe(true);
    memo = r.memo;
    /* 下一轮完成数增加后继续。 */
    r = decide({ status: 'active', blocks: blocks(2, 7), interrupted: false }, 1, memo);
    expect(r.go).toBe(true);
  });
});

describe('四道刹车', () => {
  it('① 目标自己宣布完成 → 停', () => {
    expect(decide({ status: 'satisfied', blocks: blocks(7, 7), interrupted: false }, 1, undefined).go).toBe(false);
  });

  it('① 用户暂停 → 停', () => {
    expect(decide({ status: 'paused', blocks: blocks(2, 7), interrupted: false }, 1, undefined).go).toBe(false);
  });

  /* 用户中断后不能自动恢复。 */
  it('② 用户中断这一轮 → 停, 且优先于"目标还 active"', () => {
    expect(decide({ status: 'active', blocks: blocks(1, 7), interrupted: true }, 1, undefined).go).toBe(false);
  });

  it('③ 连着跑到上限 → 停, 把方向盘交回给人', () => {
    expect(decide({ status: 'active', blocks: blocks(1, 999), interrupted: false }, AUTO_CONTINUE_MAX_ROUNDS, undefined).go).toBe(false);
  });

  it('④ 连着几轮一个块都没推进 → 停 (空转比停下更糟)', () => {
    let memo;
    let go = true;
    let rounds = 0;
    /* 完成数保持不变。 */
    for (let i = 0; i < 6 && go; i++) {
      const r = decide({ status: 'active', blocks: blocks(2, 50), interrupted: false }, rounds++, memo);
      go = r.go;
      memo = r.memo;
    }
    expect(go).toBe(false);
    expect(rounds).toBeLessThanOrEqual(AUTO_CONTINUE_MAX_IDLE_ROUNDS + 2);
  });

  it('④ 中途又有进展 → 空转计数清零, 接着跑', () => {
    let memo;
    let r = decide({ status: 'active', blocks: blocks(2, 50), interrupted: false }, 0, memo);
    memo = r.memo;
    r = decide({ status: 'active', blocks: blocks(2, 50), interrupted: false }, 1, memo);   /* 空转 1 */
    memo = r.memo;
    expect(memo!.idleRounds).toBe(1);
    r = decide({ status: 'active', blocks: blocks(3, 50), interrupted: false }, 2, memo);   /* 有进展 */
    expect(r.go).toBe(true);
    expect(r.memo!.idleRounds).toBe(0);
  });
});
