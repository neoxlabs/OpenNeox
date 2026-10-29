/**
 * Work 进度卡: 步骤从真实工具调用推出来 (不预排), 连着的同一动作合一行, 思考 / 内部步骤只计数,
 * 要人看要人点的 (助手的话 / 结果卡 / 等你回答) 留在卡外。
 */
import { describe, test, expect } from 'vitest';
import { buildTimelineRows, __resetBuildSegmentCacheForTests, type Row } from '../timelineRows';
import { buildWorkProgress, splitPlainTitle, withWorkProgressCard } from '../workProgress';

function msg(id: string, role: 'user' | 'assistant', text: string) {
  return { kind: 'message', id, role, text, timestamp: new Date(1700000000000).toISOString() } as never;
}
function tool(id: string, title: string, extra: Record<string, unknown> = {}) {
  return { kind: 'tool', id, title, iconKind: 'read', status: 'done', startedAtMs: 1700000000000, ...extra } as never;
}
function think(id: string, status = 'done') {
  return { kind: 'tool', id, title: '思考', iconKind: 'thinking', status, content: { type: 'thinking', text: '先想想怎么做' } } as never;
}
/* Work 走 minimal 管线 (TimelineSteps: minimal = density==='minimal' || isWork) */
const build = (items: unknown[], streaming: boolean) => {
  __resetBuildSegmentCacheForTests();
  return buildTimelineRows(items as never, true, new Set(), false, streaming);
};

describe('splitPlainTitle', () => {
  test('白话标题 动作「对象」 / 旧标题 动作 · 对象 / 光动作', () => {
    expect(splitPlainTitle('做一页幻灯片「封面」')).toEqual({ verb: '做一页幻灯片', obj: '封面' });
    expect(splitPlainTitle('Read file · a.ts')).toEqual({ verb: 'Read file', obj: 'a.ts' });
    expect(splitPlainTitle('挑选版式')).toEqual({ verb: '挑选版式', obj: '' });
  });
});

describe('buildWorkProgress', () => {
  const rows = (streaming: boolean, lastStatus = 'running') => build([
    msg('u1', 'user', '帮我做一个 3 页的 PPT'),
    think('k1'),
    tool('t1', '照着方法做'),
    tool('t2', '开始做演示稿「周末露营装备清单」'),
    tool('t3', '处理中的一步'),
    tool('t4', '做一页幻灯片「封面」'),
    tool('t5', '做一页幻灯片「必带装备」'),
    tool('t6', '做一页幻灯片「出发前检查」', { status: lastStatus }),
  ], streaming);

  test('连着的同一动作合一行, 正在跑的单独一行; 思考和内部步骤只计数', () => {
    const p = buildWorkProgress(rows(true));
    expect(p.lines.map((l) => [l.verb, l.objs.join('、'), l.count, l.state])).toEqual([
      ['照着方法做', '', 1, 'done'],
      ['开始做演示稿', '周末露营装备清单', 1, 'done'],
      ['做一页幻灯片', '封面、必带装备', 2, 'done'],
      ['做一页幻灯片', '出发前检查', 1, 'now'],
    ]);
    expect(p.thinkCount).toBe(1);
    expect(p.internalCount).toBe(1);
    expect(p.art).toBe('slides');
    expect(p.name).toBe('周末露营装备清单');
    expect(p.stepCount).toBe(5);
  });

  test('没成功的那步是橙色, 不并进前面做完的', () => {
    const p = buildWorkProgress(rows(true, 'failed'));
    expect(p.lines.at(-1)).toMatchObject({ verb: '做一页幻灯片', state: 'warn' });
  });
});

describe('withWorkProgressCard', () => {
  test('正在跑: 工作行收成一张卡, 用户消息和助手的话留在外面', () => {
    const built = build([
      msg('u1', 'user', '查一下露营市场'),
      tool('t1', '上网查「露营市场 2026」'),
      tool('t2', '上网查「露营装备消费」'),
      msg('a1', 'assistant', '找到几份资料, 接着看'),
      tool('t3', '看网页「iresearch.cn」', { status: 'running' }),
    ], true);
    const out = withWorkProgressCard(built, true);
    expect(out.map((r) => r.kind)).toEqual(['message', 'work_progress', 'message']);
    const card = out[1] as Extract<Row, { kind: 'work_progress' }>;
    expect(card.ask).toBe('查一下露营市场');
    expect(buildWorkProgress(card.rows).lines.map((l) => l.verb)).toEqual(['上网查', '看网页']);
  });

  test('先开口再干活: 卡落在第一个工作行的位置, 先说的话在卡上面', () => {
    const built = build([
      msg('u1', 'user', '做一份甜啦啦调研'),
      msg('a0', 'assistant', '我来做这份调研, 先派两组同时跑'),
      tool('t1', '上网查「甜啦啦 营收」', { status: 'running' }),
    ], true);
    const out = withWorkProgressCard(built, true);
    expect(out.map((r) => r.kind)).toEqual(['message', 'message', 'work_progress']);
  });

  test('跑完 (已折成一行 / 不在跑) 原样返回', () => {
    const done = build([
      msg('u1', 'user', '查一下'),
      tool('t1', '上网查「x」'),
      msg('a1', 'assistant', '好了'),
      msg('u2', 'user', '再查'),
      tool('t2', '上网查「y」'),
      msg('a2', 'assistant', '好了'),
    ], false);
    expect(withWorkProgressCard(done, false)).toBe(done);
  });
});
