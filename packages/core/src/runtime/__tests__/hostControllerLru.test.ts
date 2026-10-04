import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@neoxlabs/kernel/platform/cliLogger.js', () => ({
  cliLogger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { HostController } from '../hostController.js';

/** 从实现里读上限, 别在测试里抄 —— 抄了之后改实现测试照样绿。 */
const LIMIT = (HostController as unknown as { MAX_HOSTS: number }).MAX_HOSTS;

const interrupted: string[] = [];

/** 只实现 HostController 真正会碰的几个方法 */
function fakeHost(id: string, running = false): any {
  return {
    id,
    interrupt: () => { interrupted.push(id); },
    setWorkDir: () => {},
    isTaskRunning: () => running,
  };
}

let hc: HostController;
const open = (sid: string, key = 'k', running = false) =>
  hc.getOrCreateHost({ sessionId: sid, configKey: key, createHost: async () => fakeHost(sid, running) });

beforeEach(() => {
  hc = new HostController();
  interrupted.length = 0;
});

describe('HostController 的 host 上限', () => {
  it('上限是个正整数, 而且没大到形同虚设', () => {
    expect(Number.isInteger(LIMIT)).toBe(true);
    expect(LIMIT).toBeGreaterThan(0);
    expect(LIMIT).toBeLessThanOrEqual(32);
  });

  it('① 开 3 倍上限那么多会话, host 个数仍不超过上限', async () => {
    for (let i = 0; i < LIMIT * 3; i++) await open(`s${i}`);
    expect(hc.hostCount()).toBeLessThanOrEqual(LIMIT);
  });

  it('② 一直在用的那个会话永远不被淘汰 (abort 后接着聊的前提)', async () => {
    const hot = await open('hot');
    for (let i = 0; i < LIMIT * 3; i++) {
      await open(`cold${i}`);
      /* 每开一个新会话就回到 hot —— 模拟"用户主要在这个会话里干活" */
      expect(await open('hot')).toBe(hot);
    }
    expect(await open('hot')).toBe(hot);
    expect(interrupted).not.toContain('hot');
  });

  it('③ 淘汰的是最久没用的, 而且淘汰前会 interrupt (别留着在后台烧 token)', async () => {
    for (let i = 0; i < LIMIT + 2; i++) await open(`s${i}`);
    /* 最早的两个应该已经走了 */
    expect(hc.hasHost('s0')).toBe(false);
    expect(hc.hasHost('s1')).toBe(false);
    expect(interrupted).toEqual(['s0', 's1']);
    /* 最近开的那个必须还在 */
    expect(hc.hasHost(`s${LIMIT + 1}`)).toBe(true);
  });

  it('④ 淘汰时通知上层, 好把同一会话的其它 per-session 状态一起摘掉', async () => {
    const evicted: string[] = [];
    hc.setEvictListener((sid) => evicted.push(sid));
    for (let i = 0; i < LIMIT + 3; i++) await open(`s${i}`);
    expect(evicted).toEqual(['s0', 's1', 's2']);
  });

  it('⑥ 正在跑的 host 再老也不淘汰 —— 长工具调用里的主会话会被子 agent 挤掉 (2026-09-14 真机)', async () => {
    /* 主会话开着 deep_research, 之后每个调研 worker 各建一个 host, 主会话一直不再来拿 host */
    await open('parent', 'k', true);
    for (let i = 0; i < LIMIT + 3; i++) await open(`worker${i}`);
    expect(hc.hasHost('parent')).toBe(true);
    expect(interrupted).not.toContain('parent');
    /* 空闲的照样被收掉, 上限仍然有效 */
    expect(hc.hostCount()).toBeLessThanOrEqual(LIMIT);
  });

  it('⑦ 全都在跑时宁可超上限, 也不杀任何一个', async () => {
    for (let i = 0; i < LIMIT + 2; i++) await open(`busy${i}`, 'k', true);
    expect(hc.hostCount()).toBe(LIMIT + 2);
    expect(interrupted).toEqual([]);
  });

  it('⑤ 被淘汰的会话再开回来, 是重建的新 host (不是拿到个死的)', async () => {
    const first = await open('victim');
    for (let i = 0; i < LIMIT + 1; i++) await open(`f${i}`);
    expect(hc.hasHost('victim')).toBe(false);
    const again = await open('victim');
    expect(again).not.toBe(first);
    expect(hc.hasHost('victim')).toBe(true);
  });
});
