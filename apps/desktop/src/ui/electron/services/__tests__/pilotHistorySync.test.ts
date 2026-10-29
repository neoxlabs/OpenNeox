import { describe, expect, it, vi } from 'vitest';

vi.mock('@neoxlabs/platform/platform/database.js', () => ({ getDatabase: () => ({}) }));
vi.mock('../../lazyElectron.js', () => ({ lazyElectron: () => ({ getAllWindows: () => [] }) }));

import { missingLedgerEntries } from '../pilotHistorySync.js';

const msg = (id: number, role: string, text: string, at = 1000 + id) => ({ id, role, text, device: 'cloud', at });
const user = (detail: string) => ({ type: 'user_message', detail });
const bot = (detail: string) => ({ type: 'assistant_message', detail });

describe('missingLedgerEntries', () => {
  it('2026-10-04 实况: 第一次问天气的回话电脑没收到, 只补那一条', () => {
    const local = [user('今天蚌埠天气怎么样？'), user('今天蚌埠天气怎么样?'), bot('刚又查了一遍，蚌埠这会儿多云转晴。')];
    const ledger = [
      msg(18, 'user', '今天蚌埠天气怎么样？'),
      msg(19, 'assistant', '蚌埠今天阴天，气温大概十七度。'),
      msg(20, 'user', '今天蚌埠天气怎么样?'),
      msg(21, 'assistant', '刚又查了一遍，蚌埠这会儿多云转晴。'),
    ];
    const out = missingLedgerEntries(local, ledger);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'ledger-19', type: 'assistant_message', detail: '蚌埠今天阴天，气温大概十七度。', timestamp: 1019 });
    expect(out[0]).not.toHaveProperty('sequence');
  });

  it('全角 / 半角、空白不同算同一句; 同一句问两遍按次数比', () => {
    const out = missingLedgerEntries([user('你好 ?')], [msg(1, 'user', '你好？'), msg(2, 'user', '你好？')]);
    expect(out.map((e) => e.id)).toEqual(['ledger-2']);
  });

  it('手机上的对话电脑上没有 → 整轮补上; event 不补', () => {
    const out = missingLedgerEntries([], [msg(1, 'user', '提醒我八点开会'), msg(2, 'event', '提醒已设'), msg(3, 'assistant', '好的')]);
    expect(out.map((e) => e.type)).toEqual(['user_message', 'assistant_message']);
  });

  it('本地分段显示的回话是账本整段的一部分 → 不重复补', () => {
    const out = missingLedgerEntries([bot('先帮你查一下明天的天气')], [msg(1, 'assistant', '先帮你查一下明天的天气\n\n明天不下雨')]);
    expect(out).toEqual([]);
  });

  it('落位: 挂在时间上前一条有 sequence 的本地条目后面, 不排到下一句提问后面', () => {
    const local = [
      { id: 'u1', type: 'user_message', detail: '今天天气', sequence: 1949, timestamp: 100 },
      { id: 'u2', type: 'user_message', detail: '再查一次', sequence: 1950, timestamp: 400 },
      { id: 'a2', type: 'assistant_message', detail: '晴', sequence: 0, timestamp: 410 },
    ];
    const out = missingLedgerEntries(local, [msg(19, 'assistant', '阴天', 107), msg(20, 'user', '手机上问的', 500), msg(21, 'assistant', '手机上答的', 505)]);
    expect(out.map((e) => [e.id, e.sequence])).toEqual([['ledger-19', 1949.5], ['ledger-20', 1950.5], ['ledger-21', 1950.501]]);
  });

  it('以前补过的 (ledger-*) 按账本重写, 不当本地已有', () => {
    const out = missingLedgerEntries([{ id: 'ledger-19', type: 'assistant_message', detail: '阴天' }], [msg(19, 'assistant', '阴天')]);
    expect(out.map((e) => e.id)).toEqual(['ledger-19']);
  });

  it('剥掉运行时注入标记再比', () => {
    const out = missingLedgerEntries([user('几点了')], [msg(1, 'user', '几点了<current-time>2026-10-04 18:00</current-time>')]);
    expect(out).toEqual([]);
  });
});
