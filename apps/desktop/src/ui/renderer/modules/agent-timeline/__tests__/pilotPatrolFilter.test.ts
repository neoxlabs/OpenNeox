import { describe, expect, it } from 'vitest';
import { dropPilotPatrolNoise } from '../pilotPatrolFilter';

type E = { type: string; text?: string; toolName?: string };
const u = (text: string): E => ({ type: 'user_message', text });
const a = (text: string): E => ({ type: 'assistant_message', text });
const tool = (name: string): E => ({ type: 'tool_call', toolName: name });

describe('dropPilotPatrolNoise', () => {
  it('没事的巡检整轮不显示 (触发 + 工具步骤 + [quiet])', () => {
    const out = dropPilotPatrolNoise([
      u('帮我看看日程'), a('好的'),
      u('<pilot-patrol>按分工看一眼</pilot-patrol>'), tool('gmail_search'), a('[quiet]'),
      u('明天呢'),
    ]);
    expect(out.map((e) => e.text ?? e.type)).toEqual(['帮我看看日程', '好的', '明天呢']);
  });

  it('有事: 只藏触发那条, 回复和步骤照常显示', () => {
    const out = dropPilotPatrolNoise([
      u('<pilot-patrol>按分工看一眼</pilot-patrol>'), tool('gcal_list_events'), a('下午三点的会被改到四点了。'),
    ]);
    expect(out.map((e) => e.text ?? e.type)).toEqual(['tool_call', '下午三点的会被改到四点了。']);
  });

  it('还在跑 (没回复) 先藏着', () => {
    const out = dropPilotPatrolNoise([u('你好'), u('<pilot-patrol>x</pilot-patrol>'), tool('web_fetch')]);
    expect(out.map((e) => e.text ?? e.type)).toEqual(['你好']);
  });

  it('没有巡检的会话原样返回 (同一个数组)', () => {
    const list = [u('a'), a('b')];
    expect(dropPilotPatrolNoise(list)).toBe(list);
  });
});
