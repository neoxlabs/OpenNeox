import { describe, expect, it } from 'vitest';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { cloneToolPreservingAccessors } from '../toolClone.js';

function toolWithLiveDescription(getLine: () => string): Tool {
  return {
    name: 'generate_image',
    get description() { return `base\n${getLine()}`; },
    parameters: {
      type: 'object',
      properties: { model: { type: 'string', get description() { return getLine(); } } },
    },
    execute: async () => 'ok',
  } as unknown as Tool;
}

describe('cloneToolPreservingAccessors', () => {
  it('克隆后 description 仍是 getter, 跟随底层状态变化', () => {
    let line = 'UNAVAILABLE right now';
    const clone = cloneToolPreservingAccessors(toolWithLiveDescription(() => line), {
      capabilities: ['gui'],
    } as any);

    expect(clone.description).toContain('UNAVAILABLE');
    line = 'Available right now — gpt-image-2, grok-image';
    expect(clone.description).toContain('gpt-image-2');   /* 展开克隆这里会还是 UNAVAILABLE */
    expect(clone.capabilities).toEqual(['gui']);
  });

  it('嵌套参数里的 getter 也还活着', () => {
    let line = 'a';
    const clone = cloneToolPreservingAccessors(toolWithLiveDescription(() => line));
    line = 'b';
    expect((clone.parameters as any).properties.model.description).toBe('b');
  });

  it('普通展开 (对照) 会把 getter 冻成字符串 —— 这正是曾经的 bug', () => {
    let line = 'UNAVAILABLE';
    const tool = toolWithLiveDescription(() => line);
    const spread = { ...tool };
    line = 'Available';
    expect(spread.description).toContain('UNAVAILABLE');
  });
});
