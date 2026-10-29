/**
 * snipOversizedToolResults —— 超大单条消息裁剪 (死路修复).
 *
 * 背景: 用户贴 146KB 日志, 单条 user 消息 ≈40K tokens 超过整个 32K 窗口;
 * snip 层只裁 tool/function, user 消息直通摘要层又被 tail 保护整条保留 →
 * 压缩数学上不可能压进预算, UI 挂"134%, 必须 /compact"而 /compact 同样无解。
 */
import { describe, it, expect } from 'vitest';
import { snipOversizedToolResults } from '../runnerCompressionUtils.js';

const noop = () => {};

describe('snipOversizedToolResults', () => {
  it('超大 user 消息被裁剪 (死路修复的核心)', () => {
    const huge = 'x'.repeat(120_000);
    const r = snipOversizedToolResults([{ role: 'user', content: huge }], 50_000, noop);
    expect(r.snippedCount).toBe(1);
    expect(r.messages[0].content.length).toBeLessThan(60_000);
    expect(r.messages[0].content).toContain('snipped');
    expect(r.freedTokens).toBeGreaterThan(0);
  });

  it('user 阈值是 tool 的 1.6 倍 —— 用户亲手给的内容只在真正巨大时才动', () => {
    const mid = 'y'.repeat(60_000);  // 超 tool 阈值(50K) 但低于 user 阈值(80K)
    const r = snipOversizedToolResults(
      [{ role: 'user', content: mid }, { role: 'tool', content: mid }], 50_000, noop);
    expect(r.messages[0].content).toBe(mid);           // user 不动
    expect(r.messages[1].content).toContain('snipped'); // tool 被裁
    expect(r.snippedCount).toBe(1);
  });

  it('多模态(数组 content)的 user 消息跳过', () => {
    const arr = [{ type: 'text', text: 'x'.repeat(100_000) }];
    const r = snipOversizedToolResults([{ role: 'user', content: arr }], 50_000, noop);
    expect(r.snippedCount).toBe(0);
    expect(r.messages[0].content).toBe(arr);
  });

  it('assistant / system 永不裁剪', () => {
    const huge = 'z'.repeat(200_000);
    const r = snipOversizedToolResults(
      [{ role: 'assistant', content: huge }, { role: 'system', content: huge }], 50_000, noop);
    expect(r.snippedCount).toBe(0);
  });

  it('裁剪保留头尾并标注省略量', () => {
    const content = Array.from({ length: 9000 }, (_, i) => `line-${i}`).join('\n');
    const r = snipOversizedToolResults([{ role: 'tool', content }], 50_000, noop);
    const out = r.messages[0].content;
    expect(out.startsWith('line-0')).toBe(true);
    expect(out.trimEnd().endsWith('line-8999')).toBe(true);
    expect(out).toMatch(/snipped \d+ lines/);
  });

  it('emoji 边界截断不产生孤立 surrogate', () => {
    const content = Array.from({ length: 40_000 }, () => '🔥').join('');
    const r = snipOversizedToolResults([{ role: 'tool', content }], 50_000, noop);
    expect(r.snippedCount).toBe(1);
    const out = r.messages[0].content as string;
    for (let i = 0; i < out.length; i++) {
      const c = out.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF) {
        const n = out.charCodeAt(i + 1);
        expect(n >= 0xDC00 && n <= 0xDFFF).toBe(true);
        i++;
      } else if (c >= 0xDC00 && c <= 0xDFFF) {
        expect.fail(`lone low surrogate at ${i}`);
      }
    }
  });
});
