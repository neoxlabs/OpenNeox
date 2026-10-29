import { describe, it, expect } from 'vitest';
import {
  buildTargetPillModel,
  shouldShowTarget,
  TARGET_STALLED_AFTER_MS,
  TARGET_TERMINAL_AUTO_FADE_MS,
  type TargetPillInput,
} from '../targetPill';

const base: TargetPillInput = {
  status: 'active',
  target: '把 tracker 做到测试全绿',
  abandonReason: null,
  phase: 'execute',
  subMissionCount: 0,
  completedSubMissions: 0,
  busy: true,
  idleMs: 0,
  isZh: true,
};

describe('buildTargetPillModel', () => {
  it('目标激活 → 运行态药丸, 不抢注意力', () => {
    const m = buildTargetPillModel(base);
    expect(m.label).toBe('目标进行中');
    expect(m.tone).toBe('running');
    expect(m.attention).toBe(false);
    expect(m.weight).toBe(18);
    expect(m.primaryText).toBe('把 tracker 做到测试全绿');
  });

  it('研究先行阶段单独说法', () => {
    expect(buildTargetPillModel({ ...base, phase: 'research' }).label).toBe('调研对标中');
  });

  it('有战略块时给出宏观进度', () => {
    const m = buildTargetPillModel({ ...base, subMissionCount: 3, completedSubMissions: 2 });
    expect(m.progress).toBe('2/3 块');
  });

  it('没有战略块就不编进度出来', () => {
    expect(buildTargetPillModel(base).progress).toBeNull();
  });

  it('英文语境下块的单复数正确', () => {
    expect(buildTargetPillModel({ ...base, isZh: false, subMissionCount: 1, completedSubMissions: 0 }).progress)
      .toBe('0/1 block');
    expect(buildTargetPillModel({ ...base, isZh: false, subMissionCount: 4, completedSubMissions: 1 }).progress)
      .toBe('1/4 blocks');
  });

  it('暂停但这一轮还在跑 → 如实说「本轮结束后暂停」', () => {
    const m = buildTargetPillModel({ ...base, status: 'paused', busy: true });
    expect(m.label).toBe('本轮结束后暂停');
    expect(m.stillWorking).toBe(true);
    expect(m.tone).toBe('warn');
    expect(m.hint).toBe('正在收尾当前这一步');
  });

  it('暂停且真的停手了 → 「已暂停」并给恢复办法', () => {
    const m = buildTargetPillModel({ ...base, status: 'paused', busy: false });
    expect(m.label).toBe('已暂停');
    expect(m.stillWorking).toBe(false);
    expect(m.hint).toBe('发消息说「继续」即可恢复');
  });

  it('active 但长时间零推进 → 变成要处理的「目标待继续」', () => {
    const m = buildTargetPillModel({ ...base, busy: false, idleMs: TARGET_STALLED_AFTER_MS + 1 });
    expect(m.label).toBe('目标待继续');
    expect(m.stalled).toBe(true);
    expect(m.attention).toBe(true);
    expect(m.tone).toBe('attention');
    expect(m.weight).toBe(12);
    /* 这里绝不能建议 /target continue —— 状态本来就是 active, 那条命令直接 return false */
    expect(m.hint).toBe('这一轮已结束, 发一条消息接着推进');
  });

  it('工具间隙的短暂 idle 不算 stalled', () => {
    const m = buildTargetPillModel({ ...base, busy: false, idleMs: TARGET_STALLED_AFTER_MS - 1 });
    expect(m.stalled).toBe(false);
    expect(m.label).toBe('目标进行中');
  });

  it('paused 不会被误判成 stalled', () => {
    const m = buildTargetPillModel({ ...base, status: 'paused', busy: false, idleMs: 10 * 60_000 });
    expect(m.stalled).toBe(false);
    expect(m.label).toBe('已暂停');
  });

  it('三种终态各自的色和排序', () => {
    const satisfied = buildTargetPillModel({ ...base, status: 'satisfied', busy: false });
    expect(satisfied.label).toBe('目标达成');
    expect(satisfied.tone).toBe('ok');
    expect(satisfied.terminal).toBe(true);
    expect(satisfied.weight).toBe(40);

    const expired = buildTargetPillModel({ ...base, status: 'expired', busy: false });
    expect(expired.tone).toBe('err');
    expect(expired.hint).toBe('达 max_run_time');

    const abandoned = buildTargetPillModel({
      ...base, status: 'abandoned', busy: false, target: null, abandonReason: '需求变了',
    });
    expect(abandoned.label).toBe('已放弃');
    expect(abandoned.primaryText).toBe('需求变了');
  });

  it('放弃但没写理由时给占位, 不显示空白', () => {
    const m = buildTargetPillModel({ ...base, status: 'abandoned', busy: false, target: null, abandonReason: null });
    expect(m.primaryText).toBe('(无理由)');
  });
});

describe('shouldShowTarget', () => {
  const now = 1_700_000_000_000;

  it('off 不显示', () => {
    expect(shouldShowTarget({ status: 'off', target: null, terminalReachedAtMs: null, dismissed: false, now }))
      .toBe(false);
  });

  it('active 但还没拿到目标文本时不闪一下空条', () => {
    expect(shouldShowTarget({ status: 'active', target: null, terminalReachedAtMs: null, dismissed: false, now }))
      .toBe(false);
    expect(shouldShowTarget({ status: 'active', target: 'x', terminalReachedAtMs: null, dismissed: false, now }))
      .toBe(true);
  });

  it('终态在 5 分钟内显示, 过期自动退场', () => {
    expect(shouldShowTarget({
      status: 'satisfied', target: 'x', terminalReachedAtMs: now - 1000, dismissed: false, now,
    })).toBe(true);
    expect(shouldShowTarget({
      status: 'satisfied', target: 'x', terminalReachedAtMs: now - TARGET_TERMINAL_AUTO_FADE_MS - 1, dismissed: false, now,
    })).toBe(false);
  });

  it('用户点过 X 就不再回来', () => {
    expect(shouldShowTarget({
      status: 'satisfied', target: 'x', terminalReachedAtMs: now - 1000, dismissed: true, now,
    })).toBe(false);
  });
});
