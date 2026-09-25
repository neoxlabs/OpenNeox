import { describe, expect, it } from 'vitest';
import { shouldUseClaudeCodeIdentity } from '../anthropicClaudeCode.js';
import { AnthropicProvider } from '../anthropic.js';

describe('shouldUseClaudeCodeIdentity', () => {
  it('auto: 官方与厂商端点走原生, 中转站伪装', () => {
    expect(shouldUseClaudeCodeIdentity('https://api.anthropic.com', 'auto')).toBe(false);
    expect(shouldUseClaudeCodeIdentity('https://api.deepseek.com/anthropic', 'auto')).toBe(false);
    expect(shouldUseClaudeCodeIdentity('https://api.moonshot.cn/anthropic', 'auto')).toBe(false);
    expect(shouldUseClaudeCodeIdentity('https://open.bigmodel.cn/api/anthropic', 'auto')).toBe(false);
    expect(shouldUseClaudeCodeIdentity('https://apicc.lucoo.net', 'auto')).toBe(true);
    /* 只认 host, 路径里带厂商名的中转站不算 */
    expect(shouldUseClaudeCodeIdentity('https://proxy.example.com/api.deepseek.com', 'auto')).toBe(true);
  });

  it('显式 on / off 照办', () => {
    expect(shouldUseClaudeCodeIdentity('https://api.deepseek.com/anthropic', 'on')).toBe(true);
    expect(shouldUseClaudeCodeIdentity('https://apicc.lucoo.net', 'off')).toBe(false);
  });
});

describe('DeepSeek 官方端点的请求体', () => {
  const build = (baseUrl: string) =>
    (new AnthropicProvider({ authToken: 'k', baseUrl, defaultModel: 'deepseek-flash' } as any) as any)
      .buildPayload(
        [
          { role: 'system', content: 'You are Neox.\n\n## Environment\n- Working directory: /tmp' },
          { role: 'user', content: 'hi' },
        ],
        {
          model: 'deepseek-flash',
          tools: [{ name: 'readfile', description: 'read', parameters: { type: 'object', properties: {} } }],
        },
      );

  it('无 Claude Code 身份声明、工具名不改、cache_control 不带 scope', () => {
    const payload = build('https://api.deepseek.com/anthropic');
    const systemText = payload.system.map((b: any) => b.text).join('\n');
    expect(systemText).not.toMatch(/Claude Code/);
    expect(payload.tools.map((t: any) => t.name)).toContain('readfile');
    for (const b of payload.system) expect(b.cache_control?.scope).toBeUndefined();
  });

  const toolTurn = (extra: Record<string, unknown>) => [
    { role: 'user', content: 'read it' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'readfile', arguments: '{}' } }],
      ...extra,
    },
    { role: 'tool', tool_call_id: 't1', content: 'ok' },
  ];
  const convert = (baseUrl: string, model: string, msgs: any[]) =>
    (new AnthropicProvider({ authToken: 'k', baseUrl, defaultModel: model } as any) as any)
      .convertMessages(msgs, { model, disableCaching: true }).anthropicMessages;

  it('DeepSeek: 没有 thinking_blocks 的工具轮用 reasoning_content 补一块无签名 thinking', () => {
    const out = convert('https://api.deepseek.com/anthropic', 'deepseek-flash', toolTurn({ reasoning_content: '先读文件' }));
    expect(out[1].content[0]).toEqual({ type: 'thinking', thinking: '先读文件' });
    /* 没有 reasoning 也要有这一块 (DeepSeek 只认"有没有", 空文本也收) */
    const bare = convert('https://api.deepseek.com/anthropic', 'deepseek-flash', toolTurn({}));
    expect(bare[1].content[0]).toEqual({ type: 'thinking', thinking: '' });
  });

  it('Claude: 不补无签名 thinking, 且丢掉别家 (UUID 签名) 的 thinking', () => {
    const none = convert('https://api.anthropic.com', 'claude-opus-5', toolTurn({ reasoning_content: 'x' }));
    expect(none[1].content.some((b: any) => b.type === 'thinking')).toBe(false);
    const foreign = convert('https://api.anthropic.com', 'claude-opus-5', toolTurn({
      thinking_blocks: [{ type: 'thinking', thinking: 'ds', signature: '61d46eb4-6129-4097-b87e-65f61301eea1' }],
    }));
    expect(foreign[1].content.some((b: any) => b.type === 'thinking')).toBe(false);
    const own = convert('https://api.anthropic.com', 'claude-opus-5', toolTurn({
      thinking_blocks: [{ type: 'thinking', thinking: 'c', signature: 'EqQBCkgIARABGAIiQL' }],
    }));
    expect(own[1].content[0]).toEqual({ type: 'thinking', thinking: 'c', signature: 'EqQBCkgIARABGAIiQL' });
  });

  it('中转站仍按 Claude Code 伪装 (行为不变)', () => {
    const payload = build('https://apicc.lucoo.net');
    expect(payload.system[0].text).toMatch(/Claude Code/);
    expect(payload.tools.map((t: any) => t.name)).toContain('Read');
  });
});
