import { describe, it, expect, beforeEach } from 'vitest';
import {
  noteStreamActivity, msSinceStreamActivity, waitForStreamQuiet,
  requestStreamFreeze, subscribeStreamFreeze, msSinceStreamFreeze,
  markRunEnded, waitForRunEnd, forgetStreamActivity,
} from '../streamActivity';

const SID = 'session-test-1';

describe('流活跃度', () => {
  beforeEach(() => forgetStreamActivity(SID));

  it('没吐过字 = Infinity (调用方据此认为已安静)', () => {
    expect(msSinceStreamActivity(SID)).toBe(Infinity);
    expect(msSinceStreamActivity(null)).toBe(Infinity);
  });

  it('记一笔之后就是"刚刚"', () => {
    noteStreamActivity(SID);
    expect(msSinceStreamActivity(SID)).toBeLessThan(50);
  });

  it('安静了就立刻返回 true, 不空等', async () => {
    const t0 = Date.now();
    expect(await waitForStreamQuiet(SID, { quietMs: 30, timeoutMs: 500 })).toBe(true);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('还没安静够 → 超时返回 false (调用方照发, 不能把消息卡住)', async () => {
    noteStreamActivity(SID);
    /* 要求的安静时长远大于超时 → 必定等不到, 不依赖定时器抖动 */
    expect(await waitForStreamQuiet(SID, { quietMs: 10_000, timeoutMs: 120 })).toBe(false);
  });
});

describe('定格信号', () => {
  it('订阅者收得到会话 id; 退订后不再收到', () => {
    const got: string[] = [];
    const off = subscribeStreamFreeze((sid) => got.push(sid));
    requestStreamFreeze(SID);
    off();
    requestStreamFreeze(SID);
    expect(got).toEqual([SID]);
  });

  it('空 sessionId 不广播 (别让"没有会话"变成一次全局定格)', () => {
    const got: string[] = [];
    const off = subscribeStreamFreeze((sid) => got.push(sid));
    requestStreamFreeze(undefined);
    off();
    expect(got).toEqual([]);
  });

  it('单个订阅者抛异常不影响其他订阅者', () => {
    const got: string[] = [];
    const off1 = subscribeStreamFreeze(() => { throw new Error('boom'); });
    const off2 = subscribeStreamFreeze((sid) => got.push(sid));
    expect(() => requestStreamFreeze(SID)).not.toThrow();
    off1(); off2();
    expect(got).toEqual([SID]);
  });

  it('定格时刻可被打字机组件读到 (它据此当场落地全文)', () => {
    requestStreamFreeze(SID);
    expect(msSinceStreamFreeze()).toBeLessThan(50);
  });
});

describe('等这一轮真的收尾', () => {
  beforeEach(() => forgetStreamActivity(SID));

  it('只认 since 之后的 run_result —— 上一轮的收尾不能顶包', async () => {
    markRunEnded(SID);                    // 上一轮的收尾
    const since = Date.now() + 5;
    expect(await waitForRunEnd(SID, since, 150)).toBe(false);
  });

  it('收尾到了就返回 true', async () => {
    const since = Date.now();
    setTimeout(() => markRunEnded(SID), 40);
    expect(await waitForRunEnd(SID, since, 800)).toBe(true);
  });

  it('引擎不回收尾 → 超时 false, 调用方照发', async () => {
    expect(await waitForRunEnd(SID, Date.now(), 120)).toBe(false);
  });
});
