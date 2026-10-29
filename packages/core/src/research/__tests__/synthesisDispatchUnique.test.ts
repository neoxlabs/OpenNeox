/** 每轮归纳的派发描述包含当前账本标识，避免被重复派发闸误认为同一任务。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesisAgentDescription } from '../deepResearch.js';

describe('收尾归纳的派发描述', () => {
  it('同一个题目连着两次也不相同', () => {
    const a = synthesisAgentDescription('iphone-18-评价');
    const b = synthesisAgentDescription('iphone-18-评价');
    expect(a).not.toBe(b);
  });

  it('带上题目 —— 界面上看得出在汇总哪一个', () => {
    expect(synthesisAgentDescription('vite-vs-webpack')).toContain('vite-vs-webpack');
  });

  it('slug 为空也不炸', () => {
    expect(synthesisAgentDescription('')).toContain('汇总调研结论');
  });

  /* 光有函数不算数 —— 派发那里忘了用同样没人报错 (排掉注释, 注释里就写着这些词) */
  it('deepResearch 的派发真的用了它, 没留下固定描述', () => {
    const HERE = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(HERE, '..', 'deepResearch.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(src).toContain('description: synthesisAgentDescription(');
    expect(src).not.toMatch(/description:\s*'汇总调研结论'/);
  });
});
