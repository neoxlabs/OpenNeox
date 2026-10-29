/**
 * 流式事件会话归属守卫
 *
 * 锁的是一条**否定性**契约: 取不到 sessionId 时必须返回 undefined (让调用方丢弃),
 * 绝不能回落到"当前打开的那个会话"。
 *
 * 这条契约被破坏过两次, 两次都表现为跨会话串味:
 *   · 主进程 `eventData?.sessionId || this.currentSessionId` → B 只发了"你好",
 *     timeline 里却长出 A 的搜索结果和答案
 *   · 后来又以"新会话仍见「思考 · 1.0s · 162 字」"被报过来
 * 猜错归属比丢一条事件严重得多: 猜错会把 A 的内容写进 B 的历史并让用户看到别人的回答。
 */
import { describe, test, expect } from 'vitest';
import { resolveStreamEventSessionId, normalizeEventSessionId } from '../streamSessionGuard';

describe('streamSessionGuard', () => {
  test('★ 拿不到 id 就是 undefined —— 不许回落到任何"当前会话"', () => {
    expect(resolveStreamEventSessionId({ type: 'token', text: 'hi' })).toBeUndefined();
    expect(resolveStreamEventSessionId({})).toBeUndefined();
    expect(resolveStreamEventSessionId(null)).toBeUndefined();
    expect(resolveStreamEventSessionId(undefined)).toBeUndefined();
  });

  test('__unknown__ 等同于没有归属 —— 它是历史占位值, 不是一个会话', () => {
    expect(normalizeEventSessionId('__unknown__')).toBeUndefined();
    expect(resolveStreamEventSessionId({ sessionId: '__unknown__' })).toBeUndefined();
    /* 外层是占位值时也不能被内层"救活"成占位值本身 */
    expect(resolveStreamEventSessionId({ sessionId: '__unknown__', data: { sessionId: 's-1' } })).toBe('s-1');
  });

  test('空串 / 纯空白 / 非字符串都算没有归属', () => {
    for (const v of ['', '   ', 0, 1, false, true, {}, [], null, undefined]) {
      expect(normalizeEventSessionId(v as unknown)).toBeUndefined();
    }
  });

  test('认多种信封形状, 但只从事件自身取', () => {
    expect(resolveStreamEventSessionId({ sessionId: ' s-1 ' })).toBe('s-1');
    expect(resolveStreamEventSessionId({ session_id: 's-2' })).toBe('s-2');
    expect(resolveStreamEventSessionId({ data: { sessionId: 's-3' } })).toBe('s-3');
    expect(resolveStreamEventSessionId({ data: { session_id: 's-4' } })).toBe('s-4');
    expect(resolveStreamEventSessionId({ payload: { sessionId: 's-5' } })).toBe('s-5');
    expect(resolveStreamEventSessionId({ payload: { session_id: 's-6' } })).toBe('s-6');
  });

  test('优先级: 顶层 > data > payload (信封外层最可信)', () => {
    expect(resolveStreamEventSessionId({
      sessionId: 'top', data: { sessionId: 'mid' }, payload: { sessionId: 'low' },
    })).toBe('top');
    expect(resolveStreamEventSessionId({
      data: { sessionId: 'mid' }, payload: { sessionId: 'low' },
    })).toBe('mid');
  });
});
