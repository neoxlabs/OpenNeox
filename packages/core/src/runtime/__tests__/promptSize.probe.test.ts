import { describe, it, expect } from 'vitest';
import { buildInstructions } from '../systemPrompt.js';

describe('prompt size probe (2026-07-03 rewrite)', () => {
  it('layered zh base is materially smaller than pre-rewrite (~18-20K chars)', () => {
    const prompt = buildInstructions({ workDir: '/tmp/x', language: 'zh', model: 'claude-opus-4-8', protocol: 'anthropic' });
    // eslint-disable-next-line no-console
    console.log(`[prompt-size] chars=${prompt.length} ≈tokens=${Math.round(prompt.length / 1.7)}`);
    expect(prompt.length).toBeLessThan(14000);
    /* 冒进总开关必须不在 */
    expect(prompt).not.toContain('最高优先级');
    expect(prompt).not.toContain('80% 的把握');
    /* GUI 引导不在无 gui 的 base 里 (gate 到 browser-surface section) */
    expect(prompt).not.toContain('vibe IDE 主反馈通道');
  });
});
