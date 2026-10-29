import { describe, it, expect } from 'vitest';
import {
  buildLowProgressReplanPrompt,
  buildEvidenceRequiredPrompt,
  enrichToolResult,
  buildPerformanceHint,
  buildToolUsageNudge,
} from '../runnerHintUtils.js';

describe('buildLowProgressReplanPrompt', () => {
  it('包含连续轮次与失败工具名', () => {
    const p = buildLowProgressReplanPrompt(3, [
      { name: 'edit', status: 'error' },
      { name: 'search', status: 'error' },
    ]);
    expect(p).toContain('[PROGRESS GATE]');
    expect(p).toContain('连续 3 轮');
    expect(p).toContain('edit 失败');
    expect(p).toContain('搜索失败');
  });

  it('readfile / execute_shell 各有针对性提示', () => {
    const p = buildLowProgressReplanPrompt(2, [
      { name: 'readfile', status: 'error' },
      { name: 'execute_shell', status: 'error' },
    ]);
    expect(p).toContain('读文件失败');
    expect(p).toContain('Shell 命令失败');
  });

  it('失败工具去重（同名多次只提示一次）', () => {
    const p = buildLowProgressReplanPrompt(2, [
      { name: 'edit', status: 'error' },
      { name: 'edit', status: 'error' },
      { name: 'edit', status: 'error' },
    ]);
    expect(p.split('edit 失败').length - 1).toBe(1);
  });

  it('没有失败 / 未知失败工具时给通用建议', () => {
    const a = buildLowProgressReplanPrompt(2, []);
    const b = buildLowProgressReplanPrompt(2, [{ name: 'custom_tool', status: 'error' }]);
    for (const p of [a, b]) {
      expect(p).toContain('分析前几次失败的具体错误信息');
      expect(p).toContain('考虑完全不同的方法');
    }
  });

  it('成功 / already_done 不算失败', () => {
    const p = buildLowProgressReplanPrompt(2, [
      { name: 'edit', status: 'success' },
      { name: 'search', status: 'already_done' },
    ]);
    expect(p).not.toContain('edit 失败');
    expect(p).toContain('分析前几次失败');
  });

  it('结尾固定要求先解释再换策略', () => {
    expect(buildLowProgressReplanPrompt(1, [])).toContain('不要重复同样的操作');
  });
});

describe('buildEvidenceRequiredPrompt', () => {
  it('已知 reason 用对应中文提示', () => {
    expect(buildEvidenceRequiredPrompt('no_tool_execution')).toContain('必须先实际调用工具');
    expect(buildEvidenceRequiredPrompt('missing_mutation_evidence')).toContain('真实改动证据');
    expect(buildEvidenceRequiredPrompt('empty_final_output')).toContain('不要留空');
    expect(buildEvidenceRequiredPrompt('continuation_intent_detected')).toContain('直接调用工具');
  });

  it('未知 reason 用兜底提示', () => {
    const p = buildEvidenceRequiredPrompt('something_new');
    expect(p).toContain('Cannot conclude task yet: something_new');
    expect(p).toContain('请补齐可验证的执行证据');
  });

  it('带固定验证要求', () => {
    const p = buildEvidenceRequiredPrompt('no_tool_execution');
    expect(p).toContain('[COMPLETION GATE]');
    expect(p).toContain('read/test/build/lint/check');
  });
});

describe('enrichToolResult', () => {
  it('少于 1 秒不加头', () => {
    expect(enrichToolResult('ok', 'readfile', 999)).toBe('ok');
    expect(enrichToolResult('ok', 'readfile', 0)).toBe('ok');
  });

  it('超过 1 秒加耗时头', () => {
    expect(enrichToolResult('ok', 'readfile', 1500)).toBe('⏱️ [readfile took 1.5s]\n\nok');
    expect(enrichToolResult('ok', 'bash', 10_000)).toContain('10.0s');
  });
});

describe('buildPerformanceHint', () => {
  it('少于 5 条记录不提示', () => {
    expect(buildPerformanceHint(Array.from({ length: 4 }, () => ({ name: 'x', duration: 3000, success: true })))).toBeNull();
  });

  it('慢工具调用 >= 3 次时提示缓存', () => {
    const p = buildPerformanceHint([
      { name: 'slow', duration: 3000, success: true },
      { name: 'slow', duration: 3000, success: true },
      { name: 'slow', duration: 3000, success: true },
      { name: 'fast', duration: 10, success: true },
      { name: 'fast', duration: 10, success: true },
    ])!;
    expect(p).toContain('[Performance Notice]');
    expect(p).toContain('"slow" is slow');
    expect(p).toContain('called 3 times');
  });

  it('失败率 >= 50% 且样本 >= 3 时提示', () => {
    const p = buildPerformanceHint([
      { name: 'flaky', duration: 10, success: false },
      { name: 'flaky', duration: 10, success: false },
      { name: 'flaky', duration: 10, success: true },
      { name: 'ok', duration: 10, success: true },
      { name: 'ok', duration: 10, success: true },
    ])!;
    expect(p).toContain('67% failure rate (2/3)');
  });

  it('失败率低于 50% 时不提示', () => {
    expect(buildPerformanceHint([
      { name: 'flaky', duration: 10, success: true },
      { name: 'flaky', duration: 10, success: true },
      { name: 'flaky', duration: 10, success: false },
      { name: 'a', duration: 10, success: true },
      { name: 'b', duration: 10, success: true },
    ])).toBeNull();
  });

  it('只看最近 15 条', () => {
    const history = [
      ...Array.from({ length: 3 }, () => ({ name: 'oldslow', duration: 5000, success: true })),
      ...Array.from({ length: 15 }, () => ({ name: 'fast', duration: 1, success: true })),
    ];
    expect(buildPerformanceHint(history)).toBeNull();
  });
});

describe('buildToolUsageNudge', () => {
  it('默认模板替换工具名', () => {
    const p = buildToolUsageNudge('readfile, search');
    expect(p).toContain('readfile, search');
    expect(p).not.toContain('{toolNames}');
    expect(p).toContain('直接调用合适的工具');
  });

  it('自定义模板同样替换占位符', () => {
    expect(buildToolUsageNudge('x', 'tools: {toolNames}!')).toBe('tools: x!');
  });
});
