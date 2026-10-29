import { describe, expect, it } from 'vitest';
import { setLanguage } from '../../../i18n/index.js';
import { formatTurnEndLine } from '../turnEndLine.js';

describe('一轮结束那条线', () => {
  it('中文: 用时 m:ss · 输入 · 输出 · 费用', () => {
    setLanguage('zh');
    expect(formatTurnEndLine(161_000, 38_200, 2_100, 0.21)).toBe('2:41 · 输入 38.2k · 输出 2.1k · $0.210');
  });

  it('不到一分钟写秒; 没有费用就不写费用', () => {
    setLanguage('en');
    expect(formatTurnEndLine(12_400, 900, 40, 0)).toBe('12s · in 900 · out 40');
  });

  it('没有任何用量的轮不画线', () => {
    expect(formatTurnEndLine(3000, 0, 0, 0)).toBeNull();
  });

  /* code:CLI-02 — 首字时间来自 run_result.iterationPerf */
  it('有首字时间就写在用时后面', () => {
    setLanguage('zh');
    expect(formatTurnEndLine(161_000, 38_200, 2_100, 0.21, 1234)).toBe('2:41 · 首字 1.2s · 输入 38.2k · 输出 2.1k · $0.210');
    setLanguage('en');
    expect(formatTurnEndLine(12_400, 900, 40, 0, 820)).toBe('12s · ttft 820ms · in 900 · out 40');
  });

  it('没测到首字 (null / 未传) 就不写这一段, 不显示 0', () => {
    setLanguage('zh');
    const base = '12s · 输入 900 · 输出 40';
    expect(formatTurnEndLine(12_400, 900, 40, 0, null)).toBe(base);
    expect(formatTurnEndLine(12_400, 900, 40, 0)).toBe(base);
  });
});
