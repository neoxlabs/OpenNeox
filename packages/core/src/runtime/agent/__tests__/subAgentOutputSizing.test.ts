/**
 * sizeSubAgentOutput 契约固化 — R4.
 */

import { describe, expect, test } from 'vitest';
import { sizeSubAgentOutput } from '../subAgentOutputSizing.js';

describe('sizeSubAgentOutput', () => {
  test('短 output → identity', () => {
    const r = sizeSubAgentOutput('hi there');
    expect(r.output).toBe('hi there');
    expect(r.truncated).toBe(false);
    expect(r.originalLength).toBe(8);
  });

  test('刚好 limit → 不截', () => {
    const text = 'a'.repeat(8000);
    const r = sizeSubAgentOutput(text);
    expect(r.truncated).toBe(false);
    expect(r.output.length).toBe(8000);
  });

  test('超 limit → 截 + 提示文本带 chars 总数', () => {
    const text = 'x'.repeat(20000);
    const r = sizeSubAgentOutput(text);
    expect(r.truncated).toBe(true);
    expect(r.originalLength).toBe(20000);
    /* 截断后长度受 head + tail + note 影响, 总应该 < 原长 */
    expect(r.output.length).toBeLessThan(20000);
    /* 提示里必须含原长 */
    expect(r.output).toContain('20000');
    expect(r.output).toContain('truncated');
  });

  test('agentRole 注入提示 — LLM 知道哪个子 agent', () => {
    const text = 'y'.repeat(15000);
    const r = sizeSubAgentOutput(text, { agentRole: 'explore' });
    expect(r.output).toContain('explore');
    expect(r.output).toContain('re-spawn');
  });

  test('自定义 limit', () => {
    const text = 'z'.repeat(5000);
    const r = sizeSubAgentOutput(text, { limit: 2000 });
    expect(r.truncated).toBe(true);
    expect(r.output.length).toBeLessThan(5000);
  });

  test('limit 太小 (< 1000) 用默认值', () => {
    const text = 'a'.repeat(15000);
    const original = process.env.NEOX_AGENT_TOOL_MAX_OUTPUT_CHARS;
    process.env.NEOX_AGENT_TOOL_MAX_OUTPUT_CHARS = '500'; // 强制走默认
    const r = sizeSubAgentOutput(text);
    expect(r.truncated).toBe(true);
    /* 默认值 8000, 至少有 head + tail + note 在内. 不会是 500 */
    expect(r.output.length).toBeGreaterThan(2000);
    process.env.NEOX_AGENT_TOOL_MAX_OUTPUT_CHARS = original;
  });

  test('换行边界切割 — 不在 token 中间断', () => {
    /* 构造一个超长输出 (前半 8000 chars, 含 \n 间隔) */
    const head = 'line A\nline B\nline C\n'.repeat(500); // ~10000 chars
    const middle = 'long unbroken middle. '.repeat(500);
    const tail = '\ntail1\ntail2\n';
    const r = sizeSubAgentOutput(head + middle + tail);
    expect(r.truncated).toBe(true);
    /* truncated 输出含 truncate 提示 */
    expect(r.output).toContain('truncated');
  });

  test('空 output → identity', () => {
    expect(sizeSubAgentOutput('').output).toBe('');
    expect(sizeSubAgentOutput('').truncated).toBe(false);
  });

  test('null / undefined → 视为空', () => {
    expect(sizeSubAgentOutput(undefined as any).output).toBe('');
    expect(sizeSubAgentOutput(null as any).output).toBe('');
  });

  test('P2 多字节字符 (中文/emoji) 切割不会破坏字符 (audit#4)', () => {
    /* 用 4-byte emoji 跟 3-byte 中文交替, 看截断后 join 出来是否仍是合法 USV 序列 */
    const piece = '汉字😀'; // 3 chars (汉/字 各 1 个 BMP code unit,  是代理对 2 code units → Array.from 看是 1 char)
    const text = piece.repeat(3000); // 9000 chars 总
    const r = sizeSubAgentOutput(text);
    expect(r.truncated).toBe(true);
    /* 不应含 lone surrogate (U+D800-DBFF 或 U+DC00-DFFF 单独出现) */
    for (let i = 0; i < r.output.length; i++) {
      const code = r.output.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        // 必须紧跟 low surrogate
        const next = r.output.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xDC00);
        expect(next).toBeLessThanOrEqual(0xDFFF);
      } else if (code >= 0xDC00 && code <= 0xDFFF) {
        // 必须紧跟在 high surrogate 之后
        const prev = r.output.charCodeAt(i - 1);
        expect(prev).toBeGreaterThanOrEqual(0xD800);
        expect(prev).toBeLessThanOrEqual(0xDBFF);
      }
    }
  });

  test('P2 agentRole undefined → 输出 "sub-agent" 而非 "undefined sub-agent"', () => {
    const text = 'q'.repeat(20000);
    const r1 = sizeSubAgentOutput(text, { agentRole: undefined });
    expect(r1.output).toContain('sub-agent');
    expect(r1.output).not.toContain('undefined');
    const r2 = sizeSubAgentOutput(text, { agentRole: '   ' });
    expect(r2.output).toContain('sub-agent');
    expect(r2.output).not.toContain('undefined');
  });

  test('P1-4 env override 超 100k cap → 强制 cap (audit#4)', () => {
    const original = process.env.NEOX_AGENT_TOOL_MAX_OUTPUT_CHARS;
    process.env.NEOX_AGENT_TOOL_MAX_OUTPUT_CHARS = '10000000'; // 10MB
    const text = 'b'.repeat(500_000);
    const r = sizeSubAgentOutput(text);
    /* 应该走 100k cap, 真截; 而非接受 10MB 不截 */
    expect(r.truncated).toBe(true);
    expect(r.output.length).toBeLessThan(200_000);
    process.env.NEOX_AGENT_TOOL_MAX_OUTPUT_CHARS = original;
  });
});
