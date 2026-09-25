import { describe, it, expect } from 'vitest';
import { buildInstructions } from '../systemPrompt.js';

/**
 *  · codex_official prompt 按 provider 分流 (用户已确认):
 * Codex 官方 instructions 只该发给真·Codex API 路径 (openai-responses 协议 / 官方域名);
 * 第三方 chat-completions 代理跑 GPT 必须走 layered — 之前按模型名 ^gpt-5 一刀切,
 * 第三方用户被塞进 Codex CLI 的 sandbox/approval 叙事且"改不了约束"。
 */
const CODEX_MARKER = 'You are Codex, based on GPT-5';

describe('codex prompt routing by provider path', () => {
  it('official openai-responses protocol → codex instructions', () => {
    const prompt = buildInstructions({
      workDir: '/tmp/x',
      model: 'gpt-5.5',
      protocol: 'openai-responses',
    });
    expect(prompt).toContain(CODEX_MARKER);
  });

  it('third-party chat-completions proxy running gpt-5 → layered (no codex)', () => {
    const prompt = buildInstructions({
      workDir: '/tmp/x',
      model: 'gpt-5.5',
      protocol: 'openai',
      baseUrl: 'https://my-proxy.example.com/v1',
    });
    expect(prompt).not.toContain(CODEX_MARKER);
  });

  it('official api.openai.com base with openai protocol → codex ok', () => {
    const prompt = buildInstructions({
      workDir: '/tmp/x',
      model: 'gpt-5.5',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(prompt).toContain(CODEX_MARKER);
  });

  it('explicit useCodexStyle still wins regardless of provider', () => {
    const prompt = buildInstructions({
      workDir: '/tmp/x',
      model: 'gpt-5.5',
      protocol: 'openai',
      baseUrl: 'https://my-proxy.example.com/v1',
      useCodexStyle: true,
    });
    expect(prompt).toContain(CODEX_MARKER);
  });
});
