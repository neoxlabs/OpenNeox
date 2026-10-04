import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  armTurnStallGuard,
  disarmTurnStallGuard,
  noteTurnProgress,
  setTurnStallHandlers,
  getTurnStallSnapshot,
  isTurnGuarded,
  buildStallRecoveryMessage,
  __resetTurnStallGuardForTest,
} from '../turnStallGuard.js';

/**
 * 回合停滞看门狗 —  死锁现场的回归。
 *
 * 现场: agent 发起 execute_shell 后 10 分钟一动不动, 而 ps / processList /
 * listBackgroundTasks / 外网连接全空 —— 它在等一个永远不会来的事件。
 * 链路上每一层都只保自己那一段, 于是"没有任何一层报错, 但整体停住了"。
 *
 * 最关键的一条是"有活在跑时绝不打断": 工具执行期间本来就没有运行时事件,
 * 只按静默时长判定会把正常的长任务 (build / clone / 慢 SQL) 全部误杀。
 */

const SID = 'sess-1';

/** 推进假时钟并把 setInterval 回调跑完 (看门狗 tick 是 15s 一次) */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetTurnStallGuardForTest();
});

afterEach(() => {
  __resetTurnStallGuardForTest();
  vi.useRealTimers();
});

describe('turnStallGuard — 有活在跑时绝不打断', () => {
  it('工具正在执行(无事件)时不算停滞 — 长任务不被误杀', async () => {
    const onRecover = vi.fn().mockResolvedValue(true);
    const onAbort = vi.fn();
    setTurnStallHandlers({
      hasLiveWork: () => true,   // 底下确实有工具在跑
      onRecover,
      onAbort,
    });

    armTurnStallGuard(SID);
    /* 整整 20 分钟一个事件都没有 —— 但工具在跑, 一次都不该开火 */
    await advance(20 * 60_000);

    expect(onRecover).not.toHaveBeenCalled();
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('探针抛错时按"有活"处理 — 宁可晚开火也不误杀', async () => {
    const onRecover = vi.fn().mockResolvedValue(true);
    setTurnStallHandlers({
      hasLiveWork: () => { throw new Error('probe broken'); },
      onRecover,
    });

    armTurnStallGuard(SID);
    await advance(15 * 60_000);

    expect(onRecover).not.toHaveBeenCalled();
  });
});

describe('turnStallGuard — 真停滞时兜底', () => {
  it('底下没活 + 长时间无事件 → 注入恢复信息唤醒 agent', async () => {
    const onRecover = vi.fn().mockResolvedValue(true);
    const onAbort = vi.fn();
    setTurnStallHandlers({ hasLiveWork: () => false, onRecover, onAbort });

    armTurnStallGuard(SID);
    await advance(5 * 60_000);   // 超过 recover 阈值 (默认 240s)

    expect(onRecover).toHaveBeenCalledTimes(1);
    expect(onAbort).not.toHaveBeenCalled();

    /* 喂给 agent 的必须是可行动的指引, 不是"再试一次" */
    const msg = onRecover.mock.calls[0][1] as string;
    expect(msg).toContain('system-stall-recovery');
    expect(msg).toContain('bash_output');
    expect(msg).toContain('不要继续等待');
  });

  it('唤醒成功后重新计时 — 不会立刻又开火', async () => {
    const onRecover = vi.fn().mockResolvedValue(true);
    setTurnStallHandlers({ hasLiveWork: () => false, onRecover });

    armTurnStallGuard(SID);
    await advance(5 * 60_000);
    expect(onRecover).toHaveBeenCalledTimes(1);

    /* 唤醒后又过了一小段 (不到一个完整阈值) — 不该重复开火 */
    await advance(60_000);
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it('唤醒无效(没有 chat meta) → 直接升级到终止, 不干等满 T3', async () => {
    const onRecover = vi.fn().mockResolvedValue(false);  // 叫不醒
    const onAbort = vi.fn();
    setTurnStallHandlers({ hasLiveWork: () => false, onRecover, onAbort });

    armTurnStallGuard(SID);
    await advance(5 * 60_000);
    expect(onRecover).toHaveBeenCalledTimes(1);

    /* 下一个 tick 就该放弃, 而不是再等满 abort 阈值 */
    await advance(30_000);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(String(onAbort.mock.calls[0][1])).toContain('没有任何进展');
  });

  it('反复叫不醒时有次数上限 — 不无限循环烧 token', async () => {
    const onRecover = vi.fn().mockResolvedValue(true);   // 每次都"成功"但其实没进展
    const onAbort = vi.fn();
    setTurnStallHandlers({ hasLiveWork: () => false, onRecover, onAbort });

    armTurnStallGuard(SID);
    await advance(40 * 60_000);

    /* 默认 MAX_RECOVER=2 */
    expect(onRecover.mock.calls.length).toBeLessThanOrEqual(2);
    expect(onAbort).toHaveBeenCalled();
  });

  it('warn 先于 recover 触发, 且只提示一次', async () => {
    const onWarn = vi.fn();
    setTurnStallHandlers({ hasLiveWork: () => false, onWarn, onRecover: () => true });

    armTurnStallGuard(SID);
    await advance(120_000);   // 过了 warn(90s) 未到 recover(240s)

    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][0].level).toBe('warn');
  });
});

describe('turnStallGuard — 生命周期', () => {
  it('有进展就重置计时, 永远不该开火', async () => {
    const onRecover = vi.fn().mockResolvedValue(true);
    setTurnStallHandlers({ hasLiveWork: () => false, onRecover });

    armTurnStallGuard(SID);
    /* 每 60s 来一个事件, 持续 10 分钟 —— 一直在动, 不算停滞 */
    for (let i = 0; i < 10; i++) {
      await advance(60_000);
      noteTurnProgress(SID, 'text');
    }
    expect(onRecover).not.toHaveBeenCalled();
  });

  it('disarm 之后不再开火 — 已结束的 turn 不该被误报', async () => {
    const onRecover = vi.fn().mockResolvedValue(true);
    const onAbort = vi.fn();
    setTurnStallHandlers({ hasLiveWork: () => false, onRecover, onAbort });

    armTurnStallGuard(SID);
    disarmTurnStallGuard(SID);
    await advance(30 * 60_000);

    expect(onRecover).not.toHaveBeenCalled();
    expect(onAbort).not.toHaveBeenCalled();
    expect(isTurnGuarded(SID)).toBe(false);
  });

  it('重复 arm 视为新一轮, 计数归零', async () => {
    setTurnStallHandlers({ hasLiveWork: () => false, onRecover: () => true });
    armTurnStallGuard(SID);
    await advance(100_000);
    armTurnStallGuard(SID);   // 新一轮
    const snap = getTurnStallSnapshot().find((s) => s.sessionId === SID);
    expect(snap?.recoverAttempt).toBe(0);
    expect(snap?.silentMs ?? 999_999).toBeLessThan(5_000);
  });

  it('多个 session 互不干扰', async () => {
    const onRecover = vi.fn().mockResolvedValue(true);
    setTurnStallHandlers({ hasLiveWork: () => false, onRecover });

    armTurnStallGuard('a');
    armTurnStallGuard('b');
    /* a 一直在动, b 停住 */
    for (let i = 0; i < 6; i++) {
      await advance(60_000);
      noteTurnProgress('a', 'text');
    }
    const woken = onRecover.mock.calls.map((c) => (c[0] as { sessionId: string }).sessionId);
    expect(woken).toContain('b');
    expect(woken).not.toContain('a');
  });

  it('没有注册 handler 时不炸', async () => {
    setTurnStallHandlers({});
    armTurnStallGuard(SID);
    await expect(advance(20 * 60_000)).resolves.not.toThrow();
  });
});

describe('恢复信息内容', () => {
  it('把上一次进展是什么告诉 agent, 便于它自己判断', () => {
    const msg = buildStallRecoveryMessage({
      sessionId: SID, level: 'recover', silentMs: 300_000,
      lastSignal: 'tool_call', recoverAttempt: 1,
    });
    expect(msg).toContain('tool_call');
    expect(msg).toContain('5 分钟');
  });
});
