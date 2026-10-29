import { describe, test, expect } from 'vitest';

const STALE_MS = 5 * 60 * 1000;

/** 与 NeoxShellHost 内联逻辑同形的纯判据 */
function decide(
  flag: { id: string; ts: number } | null,
  consumed: string | null,
  now: number,
  sessionsLoaded: boolean,
  present = true,
): { action: 'none' | 'skip-consumed' | 'expire' | 'wait' | 'select'; key?: string } {
  if (!flag) return { action: 'none' };
  const key = `${flag.id}@${flag.ts}`;
  if (consumed === key) return { action: 'skip-consumed', key };
  if (now - flag.ts > STALE_MS) return { action: 'expire', key };
  if (!sessionsLoaded) return { action: 'wait', key };
  /* 会话还没进列表 → 继续等, **不能**在这里烧掉标记 */
  if (!present) return { action: 'wait', key };
  return { action: 'select', key };
}

describe('pending-select 标记消费', () => {
  const now = 1_700_000_000_000;

  test('★ 同一次挂载内的第二条标记必须还能生效 (原 boolean 闩会吞掉它)', () => {
    const first = { id: 's-1', ts: now - 1000 };
    const d1 = decide(first, null, now, true);
    expect(d1.action).toBe('select');

    /* 消费过第一条之后, 移动会话又写了第二条 —— 这条不能被当成"已经用过了" */
    const second = { id: 's-2', ts: now - 10 };
    const d2 = decide(second, d1.key!, now, true);
    expect(d2.action).toBe('select');
  });

  test('同一条不重复消费 (effect 会因依赖变化反复重跑)', () => {
    const flag = { id: 's-1', ts: now - 1000 };
    const d = decide(flag, null, now, true);
    expect(decide(flag, d.key!, now, true).action).toBe('skip-consumed');
  });

  test('同一个会话被移动两次 —— 靠 ts 区分, 第二次照样生效', () => {
    const a = { id: 's-1', ts: now - 2000 };
    const b = { id: 's-1', ts: now - 5 };
    const d = decide(a, null, now, true);
    expect(decide(b, d.key!, now, true).action).toBe('select');
  });

  test('★ 会话还没进列表时不能烧掉标记 (切工作区时 sessions 是分批到位的)', () => {
    const flag = { id: 's-1', ts: now - 10 };
    const d = decide(flag, null, now, true, false);
    expect(d.action).toBe('wait');
    /* 下一次 effect 会话到位 —— 标记还在, 照样能选中 */
    expect(decide(flag, null, now, true, true).action).toBe('select');
  });

  test('过期标记只清不选; sessions 没加载完则等待, 不提前消费', () => {
    expect(decide({ id: 's-1', ts: now - STALE_MS - 1 }, null, now, true).action).toBe('expire');
    const wait = decide({ id: 's-1', ts: now - 10 }, null, now, false);
    expect(wait.action).toBe('wait');
    /* 等待期间没被标记成已消费, sessions 到齐后仍能选中 */
    expect(decide({ id: 's-1', ts: now - 10 }, null, now, true).action).toBe('select');
  });
});
