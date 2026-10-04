/** 会话标题按里程碑低频重聚合，并保留用户手动修改的名称。 */
import { describe, it, expect } from 'vitest';
import { decideTitleWrite, latestTitleMilestone, shouldReaggregateTitle } from '../sessionTitlePolicy.js';
import { buildSessionTitleMessages } from '../claude/sideAgentPrompts.js';

describe('重聚合的节奏', () => {
  it('前 5 条一次都不重算 —— 那阵子标题一变用户就在看着', () => {
    for (let n = 1; n <= 5; n++) {
      expect(shouldReaggregateTitle(n, 1)).toBe(false);
    }
  });

  it('里程碑是 6 / 20 / 60, 之后每 60 条一次', () => {
    expect(latestTitleMilestone(5)).toBe(0);
    expect(latestTitleMilestone(6)).toBe(6);
    expect(latestTitleMilestone(19)).toBe(6);
    expect(latestTitleMilestone(20)).toBe(20);
    expect(latestTitleMilestone(59)).toBe(20);
    expect(latestTitleMilestone(60)).toBe(60);
    expect(latestTitleMilestone(119)).toBe(60);
    expect(latestTitleMilestone(120)).toBe(120);
    expect(latestTitleMilestone(200)).toBe(180);
  });

  it('同一个里程碑只跑一次 —— 跨过之后接着聊不再重算', () => {
    expect(shouldReaggregateTitle(6, 1)).toBe(true);
    /* 里程碑 6 完成后，记录值为 6。 */
    for (let n = 6; n <= 19; n++) {
      expect(shouldReaggregateTitle(n, 6)).toBe(false);
    }
    expect(shouldReaggregateTitle(20, 6)).toBe(true);
  });

  it('账本落盘的意义: 重启后计数从头来, 同一个里程碑也不该再跑', () => {
    /* 计数记录为 7 时，里程碑 6 已完成，下一次应等待里程碑 20。 */
    expect(shouldReaggregateTitle(8, 7)).toBe(false);
    expect(shouldReaggregateTitle(19, 7)).toBe(false);
    expect(shouldReaggregateTitle(20, 7)).toBe(true);
  });

  it('一个 200 条的长会话总共只多 5 次调用', () => {
    let ledger = 1;
    let runs = 0;
    for (let n = 2; n <= 200; n++) {
      if (shouldReaggregateTitle(n, ledger)) { runs += 1; ledger = n; }
    }
    expect(runs).toBe(5); // 6 / 20 / 60 / 120 / 180
  });
});

describe('重聚合的素材', () => {
  it('给了后续消息就按整段对话出题, 并明确告诉模型别只看第一句', () => {
    const msgs = buildSessionTitleMessages('帮我看看这个报错', 'zh', ['重写鉴权中间件', '加上刷新 token']);
    const user = String(msgs[1].content);
    expect(user).toContain('[1] 帮我看看这个报错');
    expect(user).toContain('[2] 重写鉴权中间件');
    expect(user).toContain('[3] 加上刷新 token');
    expect(user).toMatch(/not only turn \[1\]/);
  });

  it('首条那次形状不变 —— 没有编号, 也没有那句"看整段"', () => {
    const msgs = buildSessionTitleMessages('帮我看看这个报错', 'zh');
    const user = String(msgs[1].content);
    expect(user).toContain('帮我看看这个报错');
    expect(user).not.toContain('[1] ');
    expect(user).not.toMatch(/not only turn/);
  });
});

describe('写回判定', () => {
  it('用户手改过名 (跟我们上次写的对不上) → 让位, 绝不覆盖', () => {
    expect(decideTitleWrite({
      currentName: '鉴权改造 · 别动',
      nextTitle: '重写鉴权中间件',
      expectedCurrentTitle: '排查登录报错',
    })).toBe('user_renamed');
  });

  it('还是我们上次写的名字 → 允许覆盖', () => {
    expect(decideTitleWrite({
      currentName: '排查登录报错',
      nextTitle: '重写鉴权中间件',
      expectedCurrentTitle: '排查登录报错',
    })).toBe('write');
  });

  it('模型给出同一个标题 → 不写盘 (但里程碑照样算跑过)', () => {
    expect(decideTitleWrite({
      currentName: '重写鉴权中间件',
      nextTitle: '重写鉴权中间件',
      expectedCurrentTitle: '重写鉴权中间件',
    })).toBe('unchanged');
  });

  it('首条那次没有锁 —— 那时库里还是"新会话"/首句原文', () => {
    expect(decideTitleWrite({ currentName: '帮我看看这个报错为什么', nextTitle: '排查登录报错' })).toBe('write');
  });
});
