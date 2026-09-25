/**
 * `/research <题目>` → deep_research 硬指令。
 * 斜杠命令为 deep_research 提供明确入口。
 */
import { describe, it, expect } from 'vitest';
import { buildSlashResearchDirective } from '../router.js';

describe('buildSlashResearchDirective', () => {
  it('开头的 /research 带题目 → 指令点名 deep_research 并带上题目', () => {
    const d = buildSlashResearchDirective('/research 上海产品经理求职市场');
    expect(d).toContain('deep_research');
    expect(d).toContain('上海产品经理求职市场');
    /* 不许让模型拿 web_search 糊弄过去 */
    expect(d).toContain('禁止改用 web_search');
  });

  it('题目可以换行, 前导空白也认', () => {
    expect(buildSlashResearchDirective('  /research\nA 和 B 怎么选')).toContain('A 和 B 怎么选');
  });

  it('空题目 → 先问题目, 不凭空开跑', () => {
    const d = buildSlashResearchDirective('/research');
    expect(d).toContain('没给题目');
  });

  it('不是开头 / 只是前缀相同 → 不触发', () => {
    expect(buildSlashResearchDirective('帮我看看 /research 这个命令')).toBeNull();
    expect(buildSlashResearchDirective('/researcher 是谁')).toBeNull();
    expect(buildSlashResearchDirective('')).toBeNull();
    expect(buildSlashResearchDirective(undefined)).toBeNull();
  });
});
