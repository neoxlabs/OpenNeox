/**
 * isSameUserMessage —— 自动「继续」不能重复追加同一条用户消息。
 *
 *   比较逻辑需要忽略注入内容中的动态时间等元数据，避免同一消息在续跑时被视为新消息。
 */
import { describe, expect, it } from 'vitest';
import { isSameUserMessage, stripInjectedTimeTail } from '../runnerUserMessageDedup.js';

const raw = '这是 eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.token';
const at = (hm: string) => `${raw}\n\n<current-time>2026-09-13 周日 ${hm}</current-time>`;

describe('stripInjectedTimeTail', () => {
  it('去掉尾部 <current-time>, 没有就原样', () => {
    expect(stripInjectedTimeTail(at('23:09'))).toBe(raw);
    expect(stripInjectedTimeTail(raw)).toBe(raw);
  });

  it('只剥尾部 —— 正文中间出现的同名标记不动', () => {
    const mid = `看这个 <current-time>x</current-time> 字样\n继续说`;
    expect(stripInjectedTimeTail(mid)).toBe(mid);
  });
});

describe('isSameUserMessage', () => {
  it('核心: 历史是「原话+23:09」, 这次是「原话+23:16」→ 同一句 (真机那一次)', () => {
    expect(isSameUserMessage(at('23:09'), at('23:16'))).toBe(true);
  });

  it('原有口径保留: 历史存原话, task 是注入版 → 同一句', () => {
    expect(isSameUserMessage(raw, at('23:16'))).toBe(true);
  });

  it('真的是另一句话 → 不同 (不能把用户新说的话吞掉)', () => {
    expect(isSameUserMessage(at('23:09'), `要请求慢点等 注意风险\n\n<current-time>2026-09-13 周日 23:18</current-time>`)).toBe(false);
  });

  it('历史为空 / 只剩时间标记 → 一律不同 (否则 startsWith 恒真, 用户的话被吃掉)', () => {
    expect(isSameUserMessage('', at('23:16'))).toBe(false);
    expect(isSameUserMessage('<current-time>2026-09-13 周日 23:09</current-time>', at('23:16'))).toBe(false);
  });
});
