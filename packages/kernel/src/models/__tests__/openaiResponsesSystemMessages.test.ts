import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAIProvider } from '../openai.js';
import { setInstructionsBuilder } from '../../core/instructionsBridge.js';
import { COMPACTION_SUMMARY_MARKER } from '../../utils/compression/llmSummarizer.js';


const CODEX = 'CODEX_INSTRUCTIONS_STUB';
const TOOL = { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } };

function makeProvider(codexPrompt?: boolean): OpenAIProvider {
  const provider = new OpenAIProvider({
    apiKey: 'test-key',
    baseUrl: 'https://api.example.com/v1',
    defaultModel: 'gpt-6-sol',
    protocol: 'openai-responses',
    codexPrompt,
  } as any);
  provider.setSessionId('session-responses-system');
  return provider;
}

function build(provider: OpenAIProvider, messages: any[], tools?: any[]) {
  return (provider as any).buildResponsesAPIPayload(messages, {
    model: 'gpt-6-sol', temperature: 1, tools,
  });
}

function inputMessages(payload: any): Array<{ role: string; text: string }> {
  return (payload.input as any[])
    .filter((item) => item.type === 'message')
    .map((item) => ({ role: item.role, text: item.content.map((c: any) => c.text ?? '').join('') }));
}

const record = `${COMPACTION_SUMMARY_MARKER} — 42 earlier messages summarized]\n\n已完成: server.js / index.html`;

describe('Responses · 默认 (自己的协议)', () => {
  beforeEach(() => setInstructionsBuilder(() => CODEX));
  afterEach(() => setInstructionsBuilder(null));

  it('agent 回合: 身份 prompt 就是 instructions, 不带 Codex 指令 / AGENTS 前缀', () => {
    const payload = build(makeProvider(), [
      { role: 'system', content: 'Neox layered prompt\n## 项目记忆\n用 pnpm' },
      { role: 'user', content: 'build an app' },
    ], [TOOL]);
    expect(payload.instructions).toBe('Neox layered prompt\n## 项目记忆\n用 pnpm');
    expect(inputMessages(payload)).toEqual([{ role: 'user', text: 'build an app' }]);
  });

  it('开头连续多段 system 一起进 instructions (每轮上下文注入不再被丢)', () => {
    const payload = build(makeProvider(), [
      { role: 'system', content: 'identity' },
      { role: 'system', content: '<context_injection>当前打开的文件: a.ts</context_injection>' },
      { role: 'user', content: 'go' },
    ], [TOOL]);
    expect(payload.instructions).toContain('identity');
    expect(payload.instructions).toContain('当前打开的文件: a.ts');
  });

  it('压缩工作记录原位作 developer, 排在最新用户消息之前', () => {
    const payload = build(makeProvider(), [
      { role: 'system', content: 'identity' },
      { role: 'system', content: record },
      { role: 'user', content: '继续' },
    ], [TOOL]);
    expect(payload.instructions).toBe('identity');
    const msgs = inputMessages(payload);
    const recordIdx = msgs.findIndex((m) => m.text.includes('已完成: server.js'));
    expect(msgs[recordIdx].role).toBe('developer');
    expect(recordIdx).toBeLessThan(msgs.findIndex((m) => m.text === '继续'));
  });

  it('独立请求: 调用方 system 就是 instructions', () => {
    const payload = build(makeProvider(), [
      { role: 'system', content: 'Return ONLY a JSON object.' },
      { role: 'user', content: 'transcript' },
    ]);
    expect(payload.instructions).toBe('Return ONLY a JSON object.');
    expect(inputMessages(payload)).toEqual([{ role: 'user', text: 'transcript' }]);
  });

  it('没有 system: 回落到 Neox 指令构建器', () => {
    const payload = build(makeProvider(), [{ role: 'user', content: 'hi' }]);
    expect(payload.instructions).toBe(CODEX);
  });
});

describe('Responses · Codex 官方模式', () => {
  beforeEach(() => setInstructionsBuilder(() => CODEX));
  afterEach(() => setInstructionsBuilder(null));

  it('agent 回合: instructions 固定 Codex 指令, 身份 prompt 不重复发', () => {
    const payload = build(makeProvider(true), [
      { role: 'system', content: 'Neox layered prompt' },
      { role: 'user', content: 'build an app' },
    ], [TOOL]);
    expect(payload.instructions).toBe(CODEX);
    expect(inputMessages(payload).map((m) => m.text).join('\n')).not.toContain('Neox layered prompt');
  });

  it('独立请求借用会话 provider: instructions 仍是 Codex, 自己的 system 作 developer 送达, 不加 AGENTS 前缀', () => {
    const provider = makeProvider(true);
    build(provider, [
      { role: 'system', content: 'Neox layered prompt' },
      { role: 'user', content: 'build an app' },
    ], [TOOL]);
    const payload = build(provider, [
      { role: 'system', content: 'Summarize as JSON.' },
      { role: 'user', content: 'transcript' },
    ]);
    expect(payload.instructions).toBe(CODEX);
    expect(inputMessages(payload)).toEqual([
      { role: 'developer', text: 'Summarize as JSON.' },
      { role: 'user', text: 'transcript' },
    ]);
  });

  it('压缩工作记录原位作 developer', () => {
    const payload = build(makeProvider(true), [
      { role: 'system', content: 'Neox layered prompt' },
      { role: 'system', content: record },
      { role: 'user', content: '继续' },
    ], [TOOL]);
    const msgs = inputMessages(payload);
    const recordIdx = msgs.findIndex((m) => m.text.includes('已完成: server.js'));
    expect(recordIdx).toBeGreaterThanOrEqual(0);
    expect(msgs[recordIdx].role).toBe('developer');
    expect(recordIdx).toBeLessThan(msgs.findIndex((m) => m.text === '继续'));
  });
});
