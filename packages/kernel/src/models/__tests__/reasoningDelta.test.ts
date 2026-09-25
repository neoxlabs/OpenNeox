import { describe, expect, it } from 'vitest';
import { normalizeReasoningDelta } from '../reasoningDelta';

const chunk = (delta: any) => ({ choices: [{ delta }] });

describe('normalizeReasoningDelta', () => {
  it('OpenRouter 的 delta.reasoning 收进 reasoning_content', () => {
    const c = chunk({ reasoning: '先看看' });
    normalizeReasoningDelta(c);
    expect(c.choices[0].delta.reasoning_content).toBe('先看看');
  });

  it('reasoning_details 数组拼成文本', () => {
    const c = chunk({ reasoning_details: [{ type: 'reasoning.text', text: 'a' }, { type: 'reasoning.text', text: 'b' }] });
    normalizeReasoningDelta(c);
    expect(c.choices[0].delta.reasoning_content).toBe('ab');
  });

  it('已有 reasoning_content 不覆盖; 没有思考字段不动', () => {
    const a = chunk({ reasoning_content: 'x', reasoning: 'y' });
    normalizeReasoningDelta(a);
    expect(a.choices[0].delta.reasoning_content).toBe('x');
    const b = chunk({ content: 'hi' });
    normalizeReasoningDelta(b);
    expect(b.choices[0].delta.reasoning_content).toBeUndefined();
    expect(() => normalizeReasoningDelta(null)).not.toThrow();
  });
});
