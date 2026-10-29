/**
 * paragraphRevealEnd —— 模型出字快时整段放出 (配合 CSS 段落淡入), 慢时照常逐字。
 */
import { describe, expect, test } from 'vitest';
import { paragraphRevealEnd, pressureRevealEnd, STREAM_PARAGRAPH_BACKLOG } from '../TimelineTextRenderer';

const para = (n: number, ch = '字') => ch.repeat(n);

describe('paragraphRevealEnd', () => {
  test('积压不超过阈值 → 不跳, 照常逐字', () => {
    const target = `${para(50)}\n\n${para(50)}`;
    expect(paragraphRevealEnd(10, target, true)).toBeNull();
  });

  test('积压大且后面已有写完的整段 → 跳到最后一个空行之后', () => {
    const target = `${para(100)}\n\n${para(100)}\n\n${para(STREAM_PARAGRAPH_BACKLOG)}`;
    const lastBreak = target.lastIndexOf('\n\n') + 2;
    expect(paragraphRevealEnd(5, target, true)).toBe(lastBreak);
  });

  test('完整段落都已显示过, 只剩正在写的尾巴 → 不跳 (尾巴逐字)', () => {
    const target = `${para(20)}\n\n${para(STREAM_PARAGRAPH_BACKLOG + 50)}`;
    expect(paragraphRevealEnd(22, target, true)).toBeNull();
  });

  test('没有段落边界 (一整段还没写完) → 不跳', () => {
    expect(paragraphRevealEnd(0, para(STREAM_PARAGRAPH_BACKLOG + 100), true)).toBeNull();
  });

  test('流式已结束 → 不跳 (收尾走快速清场逐字)', () => {
    const target = `${para(100)}\n\n${para(300)}`;
    expect(paragraphRevealEnd(0, target, false)).toBeNull();
  });
});

describe('pressureRevealEnd', () => {
  test('帧时正常且积压不大 → 不跳', () => {
    const target = `${para(80)}\n${para(80)}`;
    expect(pressureRevealEnd(10, target, true, 16)).toBeNull();
  });

  test('掉帧且已有换行 → 跳到最后一个换行之后', () => {
    const target = `${para(40)}\n${para(40)}\n${para(40)}`;
    const lastBreak = target.lastIndexOf('\n') + 1;
    expect(pressureRevealEnd(5, target, true, 28)).toBe(lastBreak);
  });

  test('积压很大即使帧时正常 → 也跳到换行', () => {
    const target = `${para(200)}\n${para(200)}`;
    const lastBreak = target.lastIndexOf('\n') + 1;
    expect(pressureRevealEnd(0, target, true, 16)).toBe(lastBreak);
  });

  test('流式已结束 → 不跳', () => {
    expect(pressureRevealEnd(0, `${para(40)}\n${para(40)}`, false, 40)).toBeNull();
  });
});
