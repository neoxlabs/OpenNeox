import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolPack } from '../../../tools/packs/toolPack.js';

const askJev = vi.fn();
let enabled = true;
vi.mock('../jevClient.js', () => ({
  askJev: (...args: unknown[]) => askJev(...args),
  readJevSettings: () => (enabled ? { apiKey: 'k', model: 'jev-latest' } : null),
}));

const { JevToolPreloader, PREFETCH_GRACE_MS } = await import('../jevToolPreloader.js');

const pack = (id: string, toolNames: string[]): ToolPack => ({
  id, label: id, icon: '', description: `${id} tools`, toolNames, group: 'code' as ToolPack['group'],
});
const packs = [pack('scheduling', ['cron_create', 'cron_list']), pack('pptx', ['deck_begin'])];
const answer = (p: Record<string, number>) => ({
  model: 'jev-1.13.0', inputTokens: 100, ms: 5,
  answers: Object.fromEntries(Object.entries(p).map(([id, v]) => [`pack:${id}`, { type: 'noul', noul: v }])),
});
const available = new Set(['cron_create', 'cron_list', 'deck_begin']);

function make() {
  return new JevToolPreloader({ getPacks: () => packs, alwaysActive: new Set(), log: () => {}, info: () => {} });
}

describe('JevToolPreloader', () => {
  /* 花括号不能省: 返回 mock 函数会被当成清理钩子调用, 它返回的 pending promise 会卡死 */
  beforeEach(() => { askJev.mockReset(); enabled = true; });

  it('开着时缓存下的预判和账, 关掉开关后一律不用', async () => {
    askJev.mockResolvedValue(answer({ scheduling: 0.95 }));
    const p = make();
    p.prefetch('每天 9 点跑 echo hi');
    await new Promise((r) => setTimeout(r, 0));
    expect((await p.beginTurn('s', '每天 9 点跑 echo hi', available, true)).preload).toEqual(['cron_create', 'cron_list']);
    enabled = false;
    const off = await p.beginTurn('s', '每天 9 点跑 echo hi', available, true);
    expect(off).toEqual({ preload: [], late: null, chatOnly: null });
    expect((await p.beginTurn('s', '继续', available, false)).preload).toEqual([]);
  });

  it('纯聊天概率: 同一请求里问, 只取同一段全文已到手的预判; 前缀和晚到的都不算', async () => {
    const withChat = (p: number) => ({ ...answer({}), answers: { ...answer({}).answers, chat_only: { type: 'noul', noul: p } } });
    askJev.mockResolvedValueOnce(withChat(0.97));
    const p = make();
    p.prefetch('你好');
    await new Promise((r) => setTimeout(r, 0));
    expect(Object.keys(askJev.mock.calls[0][2])).toContain('chat_only');
    expect((await p.beginTurn('s', '你好', available, true)).chatOnly).toBe(0.97);
    /* 「你好」是前缀, 但后面跟着要干活 —— 不能拿前缀的「纯聊天」来判 */
    askJev.mockResolvedValueOnce(withChat(0.05));
    expect((await p.beginTurn('s', '你好，帮我把 README 里的错别字改一下', available, true)).chatOnly).toBeNull();
  });

  it('草稿预判已到手 → 本轮第一次请求前就在, 不再发请求', async () => {
    askJev.mockResolvedValue(answer({ scheduling: 0.95, pptx: 0.1 }));
    const p = make();
    p.prefetch('每天 9 点跑  echo hi');
    await new Promise((r) => setTimeout(r, 0));
    const turn = await p.beginTurn('s', '每天 9 点跑 echo hi', available, true);
    expect(turn.preload).toEqual(['cron_create', 'cron_list']);
    expect(turn.late).toBeNull();
    expect(askJev).toHaveBeenCalledTimes(1);
  });

  it('草稿预判还在飞 → 最多等 grace, 超了就转成晚到', async () => {
    let resolve!: (v: unknown) => void;
    askJev.mockReturnValue(new Promise((r) => { resolve = r; }));
    const p = make();
    p.prefetch('做一份 PPT');
    const t0 = Date.now();
    const turn = await p.beginTurn('s', '做一份 PPT', available, true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(PREFETCH_GRACE_MS - 20);
    expect(turn.preload).toEqual([]);
    resolve(answer({ pptx: 0.9 }));
    expect(await turn.late).toEqual(['deck_begin']);
    /* 入账了: 下一轮 (续跑也一样) 第一次请求就带着 */
    expect((await p.beginTurn('s', '继续', available, false)).preload).toEqual(['deck_begin']);
  });

  it('没有草稿预判 → 现发但不等', async () => {
    askJev.mockReturnValue(new Promise(() => {}));
    const p = make();
    const t0 = Date.now();
    const turn = await p.beginTurn('s', '做一份 PPT', available, true);
    expect(Date.now() - t0).toBeLessThan(50);
    expect(turn.late).not.toBeNull();
  });

  it('ask=false 只照账, 不发请求', async () => {
    const p = make();
    const turn = await p.beginTurn('s', '[NEOX_RESUME] ...', available, false);
    expect(turn).toEqual({ preload: [], late: null, chatOnly: null });
    expect(askJev).not.toHaveBeenCalled();
  });

  it('本轮模式里没有的工具不入账', async () => {
    askJev.mockResolvedValue(answer({ scheduling: 0.95 }));
    const p = make();
    p.prefetch('每天 9 点跑 echo hi');
    await new Promise((r) => setTimeout(r, 0));
    const turn = await p.beginTurn('s', '每天 9 点跑 echo hi', new Set(['cron_list']), true);
    expect(turn.preload).toEqual(['cron_list']);
  });

  it('打字途中的前缀预判已到手 → 直接用不等, 全文再补问一次', async () => {
    askJev.mockResolvedValueOnce(answer({ scheduling: 0.95 })).mockReturnValue(new Promise(() => {}));
    const p = make();
    p.prefetch('每天 9 点跑 echo');
    await new Promise((r) => setTimeout(r, 0));
    const t0 = Date.now();
    const turn = await p.beginTurn('s', '每天 9 点跑 echo hi', available, true);
    expect(Date.now() - t0).toBeLessThan(50);
    expect(turn.preload).toEqual(['cron_create', 'cron_list']);
    expect(turn.late).not.toBeNull();
    expect(askJev).toHaveBeenCalledTimes(2);
  });

  it('前缀太短 (不到一半) 不算', async () => {
    askJev.mockResolvedValueOnce(answer({ scheduling: 0.95 })).mockReturnValue(new Promise(() => {}));
    const p = make();
    p.prefetch('每天 9');
    await new Promise((r) => setTimeout(r, 0));
    const turn = await p.beginTurn('s', '每天 9 点跑 echo hi 然后再跑一次别的东西', available, true);
    expect(turn.preload).toEqual([]);
  });

  it('草稿请求同时只飞一个, 回来后补发最新的那段', async () => {
    let resolve!: (v: unknown) => void;
    askJev.mockReturnValueOnce(new Promise((r) => { resolve = r; })).mockResolvedValue(answer({ pptx: 0.9 }));
    const p = make();
    p.prefetch('做一份 P');
    p.prefetch('做一份 PP');
    p.prefetch('做一份 PPT');
    expect(askJev).toHaveBeenCalledTimes(1);
    resolve(answer({}));
    await new Promise((r) => setTimeout(r, 0));
    expect(askJev).toHaveBeenCalledTimes(2);
    expect(askJev.mock.calls[1][1]).toEqual({ request: '做一份 PPT' });
  });

  it('请求失败不留缓存, 发送时再试一次', async () => {
    askJev.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(answer({ pptx: 0.9 }));
    const p = make();
    p.prefetch('做一份 PPT');
    await new Promise((r) => setTimeout(r, 0));
    const turn = await p.beginTurn('s', '做一份 PPT', available, true);
    expect(askJev).toHaveBeenCalledTimes(2);
    expect(await turn.late).toEqual(['deck_begin']);
  });

  it('刚开始打字 → 连发两个小请求预热连接, 期间的草稿排队; 3s 内不重复预热', async () => {
    askJev.mockImplementation(async (_s: unknown, state: Record<string, unknown>) =>
      ('x' in state ? { model: 'm', answers: {}, inputTokens: 5, ms: 1 } : answer({ scheduling: 0.95 })));
    const p = make();
    p.prefetch('列');
    p.prefetch('列出我当前所有的定时任务');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const states = askJev.mock.calls.map((c) => Object.keys(c[1] as object)[0]);
    expect(states).toEqual(['x', 'x', 'request']);
    p.prefetch('做');
    expect(askJev).toHaveBeenCalledTimes(3);
  });

  it('保温: 连接还热 (3–5s 没请求) 只发一个, 冷了 (>5s) 发两个', async () => {
    askJev.mockResolvedValue({ model: 'm', answers: {}, inputTokens: 5, ms: 1 });
    const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now');
    try {
      const p = make();
      now.mockReturnValue(t0);
      p.prefetch('…');
      await flush();
      expect(askJev).toHaveBeenCalledTimes(2);
      now.mockReturnValue(t0 + 4000);
      p.prefetch('…');
      await flush();
      expect(askJev).toHaveBeenCalledTimes(3);
      now.mockReturnValue(t0 + 4000 + 6000);
      p.prefetch('…');
      await flush();
      expect(askJev).toHaveBeenCalledTimes(5);
    } finally {
      now.mockRestore();
    }
  });

  it('没开 Jev 不预热', () => {
    enabled = false;
    make().prefetch('列');
    expect(askJev).not.toHaveBeenCalled();
  });
});
