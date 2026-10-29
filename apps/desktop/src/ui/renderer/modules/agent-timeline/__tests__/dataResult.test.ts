import { describe, it, expect } from 'vitest';
import { parseDataResult } from '../dataResult';

const gcalList = JSON.stringify([
  {
    kind: 'calendar#event', etag: '"1"', id: 'a', status: 'confirmed',
    htmlLink: 'https://www.google.com/calendar/event?eid=a',
    summary: '起床啦',
    start: { dateTime: '2015-04-22T06:40:00+08:00', timeZone: 'Asia/Shanghai' },
    end: { dateTime: '2015-04-22T06:40:00+08:00', timeZone: 'Asia/Shanghai' },
  },
  {
    kind: 'calendar#event', id: 'b', status: 'confirmed', summary: '生日快乐！',
    start: { date: '1995-10-10' }, end: { date: '1995-10-11' },
  },
  {
    kind: 'calendar#event', id: 'c', status: 'confirmed', summary: 'Neox OAuth demo',
    htmlLink: 'https://www.google.com/calendar/event?eid=c',
    start: { dateTime: '2026-09-12T15:00:00+08:00' }, end: { dateTime: '2026-09-12T15:15:00+08:00' },
  },
], null, 2);

describe('parseDataResult', () => {
  it('日历事件数组 → 标题 + 时间 + 状态 + 链接, kind/etag 之类不上卡', () => {
    const r = parseDataResult(gcalList)!;
    expect(r.total).toBe(3);
    expect(r.records![0]).toEqual({
      title: '起床啦', when: '2015-04-22 06:40', status: 'confirmed',
      link: 'https://www.google.com/calendar/event?eid=a',
    });
    expect(r.records![1]!.when).toBe('1995-10-10');
    /* 同一天的起止只补结束时刻, 不做时区换算 */
    expect(r.records![2]!.when).toBe('2026-09-12 15:00–15:15');
    expect(r.raw).toContain('"etag"');
  });

  it('对象里的主列表 (items) 当记录, 其余标量当键值', () => {
    const r = parseDataResult(JSON.stringify({ nextPageToken: 'x', items: [{ name: 'A' }, { name: 'B' }] }))!;
    expect(r.records!.map((x) => x.title)).toEqual(['A', 'B']);
    expect(r.fields).toEqual([{ k: 'nextPageToken', v: 'x' }]);
  });

  it('空列表要说出来, 不退回键值', () => {
    const r = parseDataResult(JSON.stringify({ items: [] }))!;
    expect(r.records).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('刚建好的单个事件 → 一条记录', () => {
    const r = parseDataResult(JSON.stringify({
      id: 'c', summary: 'Neox OAuth demo', htmlLink: 'https://x.test/e',
      start: { dateTime: '2026-09-12T15:00:00+08:00' }, end: { dateTime: '2026-09-12T15:15:00+08:00' },
    }))!;
    expect(r.records).toHaveLength(1);
    expect(r.records![0]!.title).toBe('Neox OAuth demo');
  });

  it('普通对象 → 键值 (一层嵌套写成 a.b)', () => {
    const r = parseDataResult(JSON.stringify({ ok: true, user: { id: 7, login: 'mk' } }))!;
    expect(r.records).toBeUndefined();
    expect(r.fields).toEqual([{ k: 'ok', v: 'true' }, { k: 'user.id', v: '7' }, { k: 'user.login', v: 'mk' }]);
  });

  it('只截前 8 条, total 报真实条数', () => {
    const r = parseDataResult(JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ title: `t${i}` }))))!;
    expect(r.records).toHaveLength(8);
    expect(r.total).toBe(20);
  });

  it('不是 JSON 就不接 —— 调用方照旧走代码块', () => {
    expect(parseDataResult('hello')).toBeUndefined();
    expect(parseDataResult('[not json')).toBeUndefined();
    expect(parseDataResult('{}')).toBeUndefined();
  });

  it('Linear 工单: identifier 做编号, state.name 做状态', () => {
    const r = parseDataResult(JSON.stringify([{
      id: 'uuid', identifier: 'MIK-8', title: '深色模式对比度不足', url: 'https://linear.app/x/issue/MIK-8',
      updatedAt: '2026-09-25T00:32:33.349Z', state: { name: 'Backlog' }, assignee: null,
    }]))!;
    expect(r.records![0]).toMatchObject({ ref: 'MIK-8', title: '深色模式对比度不足', status: 'Backlog', when: '2026-09-25 00:32' });
  });

  it('Jira 工单: 标题和状态在 fields 里, key 做编号而不是标题', () => {
    const r = parseDataResult(JSON.stringify({ issues: [{
      id: '10001', key: 'PROJ-3', self: 'https://x.atlassian.net/rest/api/3/issue/10001',
      fields: { summary: '支付回调超时', status: { name: 'In Progress' }, updated: '2026-09-24T10:00:00.000+0800' },
    }] }))!;
    expect(r.records![0]).toMatchObject({ ref: 'PROJ-3', title: '支付回调超时', status: 'In Progress', when: '2026-09-24 10:00' });
  });

  it('Notion 页面和块: 标题从富文本里拼, 不退回 UUID', () => {
    const page = {
      object: 'page', id: '3e6284ee-afa8-8087', last_edited_time: '2026-09-25T01:07:00.000Z',
      url: 'https://app.notion.com/p/x',
      properties: { Name: { id: 'title', type: 'title', title: [{ plain_text: '周会' }, { plain_text: '纪要' }] } },
    };
    const r = parseDataResult(JSON.stringify([page]))!;
    expect(r.records![0]).toMatchObject({ title: '周会纪要', when: '2026-09-25 01:07', link: 'https://app.notion.com/p/x' });
    const blocks = parseDataResult(JSON.stringify([
      { object: 'block', id: 'b1', type: 'paragraph', paragraph: { rich_text: [{ plain_text: '啊哈哈' }] } },
      { object: 'block', id: 'b2', type: 'child_page', child_page: { title: '子页面' } },
      { object: 'block', id: 'b3', type: 'to_do', last_edited_time: '2026-09-25T01:07:00.000Z', to_do: { rich_text: [{ plain_text: '上架' }], checked: true } },
    ]))!;
    expect(blocks.records!.map((x) => x.title)).toEqual(['啊哈哈', '子页面', '上架']);
    /* 块不挂时间, 待办带勾选状态 */
    expect(blocks.records![2]).toEqual({ title: '上架', status: '☑' });
  });

  it('GitHub issue: number 做 #编号', () => {
    const r = parseDataResult(JSON.stringify([{ number: 128, title: 'Crash on start', state: 'open', html_url: 'https://github.com/a/b/issues/128' }]))!;
    expect(r.records![0]).toMatchObject({ ref: '#128', title: 'Crash on start', status: 'open' });
  });
});
