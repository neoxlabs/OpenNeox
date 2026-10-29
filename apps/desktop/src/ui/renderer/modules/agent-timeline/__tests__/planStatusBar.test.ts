import { describe, expect, it } from 'vitest';
import { shouldHidePlanBar, PLAN_BAR_STALE_MS } from '../PlanStatusBar';


const NOW = 1_700_000_000_000;

describe('shouldHidePlanBar', () => {
  it('正常进行中 → 显示', () => {
    expect(shouldHidePlanBar({
      running: true, allDone: false, lastEntryTs: NOW - 5_000, now: NOW,
    })).toBe(false);
  });

  it('已停 + 一步没走 (0/N) → 退场', () => {
    expect(shouldHidePlanBar({
      running: false, allDone: false, doneCount: 0, lastEntryTs: NOW - 1_000, now: NOW,
    })).toBe(true);
  });

  it('已停 + 做到一半 (2/8) → 必须继续显示, 用户要靠它知道从哪儿续', () => {
    expect(shouldHidePlanBar({
      running: false, allDone: false, doneCount: 2, lastEntryTs: NOW - 1_000, now: NOW,
    })).toBe(false);
  });

  /* 中断态不吃陈旧判定 —— 否则用户去充个值、回个消息, 一分钟后条子自己没了 */
  it('已停 + 做到一半 + 很久没有新 entry → 仍然显示', () => {
    expect(shouldHidePlanBar({
      running: false, allDone: false, doneCount: 2,
      lastEntryTs: NOW - (PLAN_BAR_STALE_MS * 10), now: NOW,
    })).toBe(false);
  });

  /* 做完了优先于一切 —— 停没停都不该再挂着 */
  it('已停 + 全做完 → 退场', () => {
    expect(shouldHidePlanBar({
      running: false, allDone: true, doneCount: 8, lastEntryTs: NOW - 1_000, now: NOW,
    })).toBe(true);
  });

  it('全部步骤做完 → 退场 (不再常驻一条 "N/N 计划已完成" 挡 feed)', () => {
    expect(shouldHidePlanBar({
      running: true, allDone: true, lastEntryTs: NOW - 1_000, now: NOW,
    })).toBe(true);
  });

  it('running 卡住不收敛, 但很久没有新 entry → 照样退场', () => {
    expect(shouldHidePlanBar({
      running: true, allDone: false, lastEntryTs: NOW - (PLAN_BAR_STALE_MS + 1_000), now: NOW,
    })).toBe(true);
  });

  it('刚好没到陈旧阈值 → 仍显示 (不误杀慢工具)', () => {
    /* 一个 50 秒没有任何事件的工具执行仍算正常, 不能因此把进度指示抢走 */
    expect(shouldHidePlanBar({
      running: true, allDone: false, lastEntryTs: NOW - (PLAN_BAR_STALE_MS - 1_000), now: NOW,
    })).toBe(false);
  });

  it('拿不到 entry 时间戳时不靠陈旧判定 (只按 running/allDone)', () => {
    expect(shouldHidePlanBar({
      running: true, allDone: false, lastEntryTs: 0, now: NOW,
    })).toBe(false);
  });

  it('阈值可覆盖 — 测试与未来调参用', () => {
    expect(shouldHidePlanBar({
      running: true, allDone: false, lastEntryTs: NOW - 5_000, now: NOW, staleMs: 1_000,
    })).toBe(true);
  });
});
