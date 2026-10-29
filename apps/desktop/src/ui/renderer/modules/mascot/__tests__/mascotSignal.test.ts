import { describe, expect, test } from 'vitest';
import {
  currentActivity, deriveMascotMood, errorSignalText, formatRunDuration, lastToolFailureId, pickMascotSignal,
} from '../mascotSignal';

describe('errorSignalText', () => {
  test('按类型说人话', () => {
    expect(errorSignalText({ code: '402', message: 'insufficient balance' }, true)).toBe('额度不够了');
    expect(errorSignalText({ message: 'HTTP 429 Too Many Requests' }, true)).toBe('请求太频繁, 等一下再试');
    expect(errorSignalText({ message: '401 Unauthorized: invalid api key' }, true)).toBe('Key 不对或过期了');
    expect(errorSignalText({ message: 'maximum context length exceeded' }, true)).toBe('对话太长了');
    expect(errorSignalText({ message: 'fetch failed: ECONNRESET' }, true)).toBe('网络好像断了');
    expect(errorSignalText({ message: '503 Service Unavailable' }, false)).toBe('The model service failed');
    expect(errorSignalText({ message: 'weird' }, true)).toBe('出错了, 看下面');
  });
});

describe('deriveMascotMood', () => {
  const run = (events: any[], extra: Partial<Parameters<typeof deriveMascotMood>[0]> = {}) =>
    deriveMascotMood({ streaming: true, waiting: false, error: false, events, ...extra });

  test('等用户 > 出错 > 在跑时看最后一条挂着的条目', () => {
    expect(run([], { waiting: true, error: true })).toBe('waiting');
    expect(run([], { streaming: false, error: true })).toBe('error');
    expect(run([{ type: 'thinking', pending: true }])).toBe('thinking');
    expect(run([{ type: 'thinking' }, { type: 'tool_call', pending: true }])).toBe('working');
    expect(run([{ type: 'tool_call' }, { type: 'assistant_message', pending: true }])).toBe('writing');
    expect(run([], { streaming: false })).toBe('idle');
  });

  test('还在跑时出错不算 error (那是上一轮留下的)', () => {
    expect(run([{ type: 'thinking', pending: true }], { error: true })).toBe('thinking');
  });
});

describe('lastToolFailureId', () => {
  test('只看本轮 (最后一条用户消息之后)', () => {
    expect(lastToolFailureId([{ id: 'a', type: 'tool_error' }, { id: 'u', type: 'user_message' }])).toBeNull();
    expect(lastToolFailureId([
      { id: 'u', type: 'user_message' }, { id: 'x', type: 'tool_call', success: false }, { id: 'y', type: 'tool_call', success: true },
    ])).toBe('x');
  });
});

describe('pickMascotSignal', () => {
  const base = { streaming: false, zh: true };

  test('等用户动手的优先: 批准 > 回答 > 出错 > 跑完', () => {
    const all = { ...base, approvalId: 'a1', askId: 'q1', errorKey: 'E:x', done: { at: 1, ranMs: 30_000 } };
    expect(pickMascotSignal(all)?.kind).toBe('approval');
    expect(pickMascotSignal({ ...all, approvalId: null })?.kind).toBe('ask');
    expect(pickMascotSignal({ ...all, approvalId: null, askId: null })?.kind).toBe('error');
    expect(pickMascotSignal({ ...base, done: { at: 1, ranMs: 72_000 } })).toEqual({
      kind: 'done', key: 'done:1', text: '好了 · 1 分 12 秒',
    });
  });

  test('还在跑时不报出错和跑完, 批准照报', () => {
    expect(pickMascotSignal({ ...base, streaming: true, errorKey: 'E:x' })).toBeNull();
    expect(pickMascotSignal({ ...base, streaming: true, done: { at: 1, ranMs: 30_000 } })).toBeNull();
    expect(pickMascotSignal({ ...base, streaming: true, approvalId: 'a1' })?.kind).toBe('approval');
  });

  test('同一件事 key 稳定, 换一件才变', () => {
    const a = pickMascotSignal({ ...base, approvalId: 'a1' });
    const b = pickMascotSignal({ ...base, approvalId: 'a1' });
    const c = pickMascotSignal({ ...base, approvalId: 'a2' });
    expect(a?.key).toBe(b?.key);
    expect(a?.key).not.toBe(c?.key);
  });

  test('英文文案', () => {
    expect(pickMascotSignal({ streaming: false, zh: false, askId: 'q' })?.text).toBe('Has a question for you');
  });
});

describe('formatRunDuration', () => {
  test('秒 / 分', () => {
    expect(formatRunDuration(400, true)).toBe('1 秒');
    expect(formatRunDuration(45_000, true)).toBe('45 秒');
    expect(formatRunDuration(120_000, true)).toBe('2 分钟');
    expect(formatRunDuration(125_000, false)).toBe('2m 5s');
  });
});

describe('currentActivity', () => {
  test('取最后一条还挂着的工具, 跳过思考', () => {
    expect(currentActivity([
      { pending: false, title: '读取 a.ts', type: 'tool' },
      { pending: true, title: '运行 npm test', type: 'tool' },
      { pending: true, title: '思考', type: 'thinking' },
    ])).toBe('运行 npm test');
    expect(currentActivity([{ pending: false, title: 'x' }])).toBeNull();
  });
});
