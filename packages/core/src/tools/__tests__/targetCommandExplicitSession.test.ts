/**
 * Target mutators route by the explicit session id. The id takes precedence
 * over the fallback slot, and the live-slot check remains a read-only query.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  abandonTargetFromCommand,
  activateTargetFromCommand,
  continueTargetMission,
  getCurrentTargetPlan,
  getTargetStatus,
  hasLiveTargetSlot,
  pauseTargetMission,
  refineTargetMission,
  resetTargetMode,
  runWithTargetSession,
  setActiveTargetSession,
} from '../targetModeTools.js';

const A = 'session-A-long-run';
const B = 'session-B-bystander';

beforeEach(() => {
  setActiveTargetSession(null);
  /* 上一条用例留下的槽会让"从没激活过"的断言失真 */
  resetTargetMode(A);
  resetTargetMode(B);
  setActiveTargetSession(null);
});

describe('hasLiveTargetSlot —— 命令层判"活不活"的唯一判据', () => {
  it('从没激活过 = false', () => {
    expect(hasLiveTargetSlot('never-seen-session')).toBe(false);
  });

  it('查询本身不许建槽 —— 否则存在性判断恒真', () => {
    hasLiveTargetSlot('probe-only-session');
    expect(hasLiveTargetSlot('probe-only-session')).toBe(false);
  });

  it('空 sid = false, 不许退化成"当前上下文"', () => {
    runWithTargetSession(A, () => activateTargetFromCommand('ship X'));
    expect(hasLiveTargetSlot(null)).toBe(false);
    expect(hasLiveTargetSlot(undefined)).toBe(false);
    expect(hasLiveTargetSlot('')).toBe(false);
  });

  it('激活后 true; off 之后回到 false (off 不是"活的状态机")', () => {
    runWithTargetSession(A, () => activateTargetFromCommand('ship X'));
    expect(hasLiveTargetSlot(A)).toBe(true);
    resetTargetMode(A);
    expect(hasLiveTargetSlot(A)).toBe(false);
  });

  it('paused / abandoned 仍算活的 —— continue 和状态查询还要用它', () => {
    runWithTargetSession(A, () => activateTargetFromCommand('ship X'));
    pauseTargetMission('user', A);
    expect(hasLiveTargetSlot(A)).toBe(true);
    abandonTargetFromCommand('user', A);
    expect(hasLiveTargetSlot(A)).toBe(true);
  });
});

describe('显式 sid 压过 fallback —— fallback 串号时不许打错会话', () => {
  beforeEach(() => {
    runWithTargetSession(A, () => activateTargetFromCommand('ship X'));
    runWithTargetSession(B, () => activateTargetFromCommand('unrelated goal'));
    /* 模拟 worker 里另一条 session 后建 runner 把 fallback 拍成 B */
    setActiveTargetSession(B);
  });

  it('pause(A) 只暂停 A, B 照常 active', () => {
    expect(pauseTargetMission('user paused', A)).toBe(true);
    expect(getTargetStatus(A)).toBe('paused');
    expect(getTargetStatus(B)).toBe('active');
  });

  it('stop(A) 只终止 A —— 这条错了就是"停别人的长跑"', () => {
    expect(abandonTargetFromCommand('user stopped', A)).toBe(true);
    expect(getTargetStatus(A)).toBe('abandoned');
    expect(getTargetStatus(B)).toBe('active');
  });

  it('continue(A) 只恢复 A', () => {
    pauseTargetMission('user paused', A);
    pauseTargetMission('user paused', B);
    expect(continueTargetMission(A)).toBe(true);
    expect(getTargetStatus(A)).toBe('active');
    expect(getTargetStatus(B)).toBe('paused');
  });

  it('off(A) 只清 A 的计划, B 的计划完好', () => {
    resetTargetMode(A);
    expect(getTargetStatus(A)).toBe('off');
    expect(getCurrentTargetPlan(A)).toBeNull();
    expect(getTargetStatus(B)).toBe('active');
    expect(getCurrentTargetPlan(B)?.target).toBe('unrelated goal');
  });

  it('refine(A) 只改 A 的目标文本', () => {
    expect(refineTargetMission('ship X v2', 'User refine (desktop)', A)).toBe(true);
    expect(getCurrentTargetPlan(A)?.target).toBe('ship X v2');
    expect(getCurrentTargetPlan(B)?.target).toBe('unrelated goal');
  });
});

describe('省略 sid 时保持原语义 —— CLI / 工具内调用不受影响', () => {
  it('落到 ALS 上下文', () => {
    runWithTargetSession(A, () => {
      activateTargetFromCommand('ship X');
      expect(pauseTargetMission('inline')).toBe(true);
    });
    expect(getTargetStatus(A)).toBe('paused');
  });

  it('没有 ALS 时落到 fallback', () => {
    runWithTargetSession(A, () => activateTargetFromCommand('ship X'));
    setActiveTargetSession(A);
    expect(pauseTargetMission('inline')).toBe(true);
    expect(getTargetStatus(A)).toBe('paused');
  });
});

describe('状态前置条件按目标 session 判, 不看 fallback', () => {
  it('A 不是 active 时 pause(A) 返回 false, 哪怕 fallback 那条正 active', () => {
    runWithTargetSession(A, () => activateTargetFromCommand('ship X'));
    runWithTargetSession(B, () => activateTargetFromCommand('unrelated goal'));
    pauseTargetMission('first', A);
    setActiveTargetSession(B);
    expect(pauseTargetMission('second', A)).toBe(false);
    expect(getTargetStatus(A)).toBe('paused');
    expect(getTargetStatus(B)).toBe('active');
  });

  it('对从没激活过的 session 下命令一律 false, 且不留下脏槽', () => {
    expect(pauseTargetMission('x', 'ghost-session')).toBe(false);
    expect(continueTargetMission('ghost-session')).toBe(false);
    expect(abandonTargetFromCommand('x', 'ghost-session')).toBe(false);
    expect(getTargetStatus('ghost-session')).toBe('off');
  });
});
