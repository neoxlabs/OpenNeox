/** 自动续跑按战略块判断空转；无战略块时跳过该刹车，并按用户轮次清理计数。 */
import { describe, expect, it, beforeEach } from 'vitest';

const AUTO_CONTINUE_MAX_ROUNDS = 40;
const AUTO_CONTINUE_MAX_IDLE_ROUNDS = 3;

type Block = { status?: string };
type Progress = { done: number; total: number; idleRounds: number };

class Brakes {
  private lastProgress = new Map<string, Progress>();
  private interrupted = new Map<string, boolean>();

  markInterrupted(sid: string): void { this.interrupted.set(sid, true); }
  /** 新一轮用户输入时调 —— 上一轮攒的计数跟这一轮无关 */
  resetTurn(sid: string): void {
    this.lastProgress.delete(sid);
    this.interrupted.delete(sid);
  }

  decide(sid: string, rounds: number, status: string, blocks: Block[]): { go: boolean; note?: string } {
    if (rounds >= AUTO_CONTINUE_MAX_ROUNDS) return { go: false, note: 'hit max rounds' };
    if (this.interrupted.get(sid)) {
      this.interrupted.delete(sid);
      return { go: false, note: 'user interrupted this turn' };
    }
    if (status !== 'active') return { go: false, note: `target status = ${status}` };
    /* 无战略块时没有可用的块进度，不启用空转刹车。 */
    if (blocks.length === 0) {
      this.lastProgress.delete(sid);
      return { go: true };
    }
    const done = blocks.filter((b) => b?.status === 'completed').length;
    const prev = this.lastProgress.get(sid);
    const idleRounds = prev && prev.done === done && prev.total === blocks.length ? prev.idleRounds + 1 : 0;
    this.lastProgress.set(sid, { done, total: blocks.length, idleRounds });
    if (idleRounds >= AUTO_CONTINUE_MAX_IDLE_ROUNDS) {
      return { go: false, note: `no block progressed in ${idleRounds} rounds (${done}/${blocks.length})` };
    }
    return { go: true };
  }
}

const SID = 'session-autocontinue';
const blocksOf = (doneCount: number, total: number): Block[] =>
  Array.from({ length: total }, (_, i) => ({ status: i < doneCount ? 'completed' : 'pending' }));

let b: Brakes;
beforeEach(() => { b = new Brakes(); });

describe('无战略块的目标不许被块进度误杀', () => {
  it('中小目标 (0 块) 连跑 20 轮都不该被判原地打转', () => {
    for (let r = 0; r < 20; r++) {
      const d = b.decide(SID, r, 'active', []);
      expect(d.go, `第 ${r} 轮被停了: ${d.note}`).toBe(true);
    }
  });

  it('无块目标最终仍受总轮数上限约束 —— 不是无限跑', () => {
    expect(b.decide(SID, AUTO_CONTINUE_MAX_ROUNDS, 'active', []).go).toBe(false);
  });
});

describe('有战略块时空转刹车照常生效', () => {
  it('块一直不动 → 第 3 轮停', () => {
    const stuck = blocksOf(1, 4);
    expect(b.decide(SID, 0, 'active', stuck).go).toBe(true);  // idle 0
    expect(b.decide(SID, 1, 'active', stuck).go).toBe(true);  // idle 1
    expect(b.decide(SID, 2, 'active', stuck).go).toBe(true);  // idle 2
    const stop = b.decide(SID, 3, 'active', stuck);           // idle 3
    expect(stop.go).toBe(false);
    expect(stop.note).toContain('no block progressed');
  });

  it('块推进了就清零 —— 慢但在动的长跑不该被停', () => {
    expect(b.decide(SID, 0, 'active', blocksOf(1, 5)).go).toBe(true);
    expect(b.decide(SID, 1, 'active', blocksOf(1, 5)).go).toBe(true);
    expect(b.decide(SID, 2, 'active', blocksOf(1, 5)).go).toBe(true);
    /* 第 4 轮推进了一块 → 重新起算 */
    expect(b.decide(SID, 3, 'active', blocksOf(2, 5)).go).toBe(true);
    expect(b.decide(SID, 4, 'active', blocksOf(2, 5)).go).toBe(true);
    expect(b.decide(SID, 5, 'active', blocksOf(2, 5)).go).toBe(true);
  });

  it('块总数变了也算有变化 (加块/丢块)', () => {
    expect(b.decide(SID, 0, 'active', blocksOf(1, 4)).go).toBe(true);
    expect(b.decide(SID, 1, 'active', blocksOf(1, 4)).go).toBe(true);
    expect(b.decide(SID, 2, 'active', blocksOf(1, 6)).go).toBe(true); // total 变 → 清零
    expect(b.decide(SID, 3, 'active', blocksOf(1, 6)).go).toBe(true);
  });
});

describe('计数不许跨轮泄漏', () => {
  it('上一轮停在 idle=2, 新一轮不该第一次判定就停', () => {
    const stuck = blocksOf(1, 4);
    b.decide(SID, 0, 'active', stuck);
    b.decide(SID, 1, 'active', stuck);
    b.decide(SID, 2, 'active', stuck); // idleRounds 已经 2

    b.resetTurn(SID);                  // 用户发了新的一句
    const first = b.decide(SID, 0, 'active', stuck);
    expect(first.go, '新一轮第一次判定就被上一轮的账停掉了').toBe(true);
  });

  it('上一轮的用户中断不许影响新一轮', () => {
    b.markInterrupted(SID);
    b.resetTurn(SID);
    expect(b.decide(SID, 0, 'active', blocksOf(0, 3)).go).toBe(true);
  });

  it('本轮中断仍然立刻生效 —— 点了停止就是不想让它再跑', () => {
    b.markInterrupted(SID);
    const d = b.decide(SID, 0, 'active', blocksOf(0, 3));
    expect(d.go).toBe(false);
    expect(d.note).toContain('interrupted');
  });
});

describe('目标不再 active 一律停', () => {
  for (const st of ['paused', 'satisfied', 'abandoned', 'expired', 'off']) {
    it(`status=${st} → 停`, () => {
      const d = b.decide(SID, 0, st, []);
      expect(d.go).toBe(false);
      expect(d.note).toContain(st);
    });
  }
});
