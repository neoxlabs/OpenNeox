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

  /* pilot:H-07/H-08 — 设备状态 / 未完成的事也挂在尾部, 跟时间戳一样属于注入 */
  it('去掉尾部 <device-state> / <open-loops> 块', () => {
    const injected = `${raw}\n\n<current-time>2026-10-18 周日 12:00</current-time>\n\n<device-state>\n- 手机: 在线\n</device-state>\n\n<open-loops>\n- 进行中: 写周报\n</open-loops>`;
    expect(stripInjectedTimeTail(injected)).toBe(raw);
  });

  it('正文里的 <open-loops> 字样不被当注入剥掉', () => {
    const mid = `文档里要写 <open-loops> 这个标签\n继续说`;
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

  /* 设备电量 / 网络每轮都在变: 自动继续时必须仍认得出是同一句话, 不能复读一遍 */
  it('尾部设备状态变了 → 仍然算同一句', () => {
    const withDevice = (pct: number) => `${raw}\n\n<current-time>2026-10-18 周日 12:00</current-time>\n\n<device-state>\n- 手机: 在线 · 电量 ${pct}%\n</device-state>`;
    expect(isSameUserMessage(withDevice(80), withDevice(79))).toBe(true);
  });

  it('尾部的未完成事项变了 → 仍然算同一句', () => {
    const withLoops = (title: string) => `${raw}\n\n<open-loops>\n- 进行中: ${title}\n</open-loops>`;
    expect(isSameUserMessage(withLoops('写周报'), withLoops('整理报表'))).toBe(true);
  });
});
