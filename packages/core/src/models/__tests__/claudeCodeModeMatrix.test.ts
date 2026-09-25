import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '@neoxlabs/kernel/models/anthropic.js';
import { CLAUDE_CODE_SYSTEM_PROMPT } from '@neoxlabs/kernel/models/anthropicClaudeCode.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';

/* BYOK/订阅身份分层 · claudeCodeMode 三态矩阵测试
 *   auto (未配) = 按 baseUrl 判 (api.anthropic.com=Neox 原生, 其它=Claude Code 伪装)
 *   on = 强制伪装
 *   off = 强制不伪装
 * 每种模式验证 5 个输出面 (system[0] / apiPath / headers / tool 名 / user_id 长度) 一致.
 * 顺带回归 forceClaudeCodeMode legacy alias. */

const TEST_TOOLS: Tool[] = [
  { name: 'readfile', description: 'read', parameters: { type: 'object', properties: {}, additionalProperties: false }, function: () => '' },
  { name: 'write_file', description: 'write', parameters: { type: 'object', properties: {}, additionalProperties: false }, function: () => '' },
];

interface Facet {
  /** system[0].text = CLAUDE_CODE_SYSTEM_PROMPT ? */
  hasClaudeCodeSystemPrefix: boolean;
  /** tool 名是否 PascalCase (Read/Write) 而不是 readfile/write_file ? */
  toolsRemapped: boolean;
  /** headers 是否是 Claude Code 风格 (Bearer + claude-cli UA + anthropic-beta) ? */
  claudeCodeHeaders: boolean;
  /** apiPath 含 ?beta=true ? */
  betaApiPath: boolean;
  /** metadata.user_id 长度 (Claude Code 格式约 120+ 字符; Neox 原生约 52) */
  userIdLen: number;
}

/** 灰盒: 直接读 provider 内部输出面 */
function inspect(provider: any): Facet {
  const payload = provider.buildPayload([
    { role: 'user', content: 'hi' },
  ], {
    model: 'claude-opus-4-6',
    tools: TEST_TOOLS,
  });

  const headers = provider.buildHeaders('stream');
  const apiPath: string = provider.isProxyMode ? '/v1/messages?beta=true' : '/v1/messages';

  const system0Text: string = payload.system?.[0]?.text ?? '';
  const toolNames: string[] = (payload.tools || []).map((t: any) => t.name);

  return {
    hasClaudeCodeSystemPrefix: system0Text === CLAUDE_CODE_SYSTEM_PROMPT,
    toolsRemapped: toolNames.includes('Read') && toolNames.includes('Write'),
    claudeCodeHeaders: !!(headers['Authorization']?.startsWith('Bearer ')
      && String(headers['User-Agent'] || '').includes('claude-cli')
      && headers['anthropic-beta']),
    betaApiPath: apiPath.includes('?beta=true'),
    userIdLen: (payload.metadata?.user_id || '').length,
  };
}

describe('claudeCodeMode 三态矩阵 · api.anthropic.com', () => {
  const baseUrl = 'https://api.anthropic.com';

  it('auto (default) → Neox 原生: 无 CC 前缀 / 不 remap / 无 CC headers / 无 beta path', () => {
    const p = new AnthropicProvider({ authToken: 'test-key', baseUrl, defaultModel: 'x' });
    const f = inspect(p);
    expect(f.hasClaudeCodeSystemPrefix).toBe(false);
    expect(f.toolsRemapped).toBe(false);
    expect(f.claudeCodeHeaders).toBe(false);
    expect(f.betaApiPath).toBe(false);
    /* Neox 原生 user_id 短格式 */
    expect(f.userIdLen).toBeLessThan(100);
  });

  it("mode='on' + 官方 URL → 强制伪装: 全 CC 特征", () => {
    const p = new AnthropicProvider({ authToken: 'test-key', baseUrl, defaultModel: 'x', claudeCodeMode: 'on' });
    const f = inspect(p);
    expect(f.hasClaudeCodeSystemPrefix).toBe(true);
    expect(f.toolsRemapped).toBe(true);
    expect(f.claudeCodeHeaders).toBe(true);
    expect(f.betaApiPath).toBe(true);
    expect(f.userIdLen).toBeGreaterThan(100);
  });

  it("mode='off' + 官方 URL → 显式不伪装 (auto 同结果)", () => {
    const p = new AnthropicProvider({ authToken: 'test-key', baseUrl, defaultModel: 'x', claudeCodeMode: 'off' });
    const f = inspect(p);
    expect(f.hasClaudeCodeSystemPrefix).toBe(false);
    expect(f.toolsRemapped).toBe(false);
    expect(f.claudeCodeHeaders).toBe(false);
    expect(f.betaApiPath).toBe(false);
  });
});

describe('claudeCodeMode 三态矩阵 · 第三方代理 (timicc.com)', () => {
  const baseUrl = 'https://timicc.com';

  it('auto (default) → 伪装 CC (baseUrl 非 official)', () => {
    const p = new AnthropicProvider({ authToken: 'test-key', baseUrl, defaultModel: 'x' });
    const f = inspect(p);
    expect(f.hasClaudeCodeSystemPrefix).toBe(true);
    expect(f.toolsRemapped).toBe(true);
    expect(f.claudeCodeHeaders).toBe(true);
    expect(f.betaApiPath).toBe(true);
    expect(f.userIdLen).toBeGreaterThan(100);
  });

  it("mode='on' + 第三方 URL → 与 auto 相同 (显式强制)", () => {
    const p = new AnthropicProvider({ authToken: 'test-key', baseUrl, defaultModel: 'x', claudeCodeMode: 'on' });
    const f = inspect(p);
    expect(f.hasClaudeCodeSystemPrefix).toBe(true);
    expect(f.toolsRemapped).toBe(true);
    expect(f.claudeCodeHeaders).toBe(true);
    expect(f.betaApiPath).toBe(true);
  });

  it("mode='off' + 第三方 URL → 强制不伪装, 走 Neox 原生", () => {
    const p = new AnthropicProvider({ authToken: 'test-key', baseUrl, defaultModel: 'x', claudeCodeMode: 'off' });
    const f = inspect(p);
    expect(f.hasClaudeCodeSystemPrefix).toBe(false);
    expect(f.toolsRemapped).toBe(false);
    expect(f.claudeCodeHeaders).toBe(false);
    expect(f.betaApiPath).toBe(false);
    /* Neox 原生 buildOfficialHeaders 应同时发 anthropic-api-key + Bearer 让定制代理都能通 */
    const headers = (p as any).buildOfficialHeaders();
    expect(headers['anthropic-api-key']).toBe('test-key');
    expect(headers['Authorization']).toBe('Bearer test-key');
  });
});

describe('forceClaudeCodeMode legacy alias', () => {
  it('forceClaudeCodeMode=true 视作 mode=on (向后兼容老配置)', () => {
    const p = new AnthropicProvider({
      authToken: 'test-key',
      baseUrl: 'https://api.anthropic.com',
      defaultModel: 'x',
      forceClaudeCodeMode: true,   // 老字段, 应等效 mode='on'
    });
    const f = inspect(p);
    expect(f.hasClaudeCodeSystemPrefix).toBe(true);
    expect(f.toolsRemapped).toBe(true);
    expect(f.claudeCodeHeaders).toBe(true);
  });

  it('claudeCodeMode 优先级高于 forceClaudeCodeMode', () => {
    /* 老代码可能同时设了 forceClaudeCodeMode=true, 用户新表单选 off — 应以新字段为准 */
    const p = new AnthropicProvider({
      authToken: 'test-key',
      baseUrl: 'https://third-party.example',
      defaultModel: 'x',
      forceClaudeCodeMode: true,
      claudeCodeMode: 'off',   // 优先
    });
    const f = inspect(p);
    expect(f.hasClaudeCodeSystemPrefix).toBe(false);
    expect(f.toolsRemapped).toBe(false);
  });
});
