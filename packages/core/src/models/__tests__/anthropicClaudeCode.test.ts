import { describe, expect, it } from 'vitest';
import { AnthropicAdapter } from '../adapters/anthropic.js';
import { AnthropicProvider } from '@neoxlabs/kernel/models/anthropic.js';
import {
  CLAUDE_CODE_SYSTEM_PROMPT,
  PROMPT_CACHING_SCOPE_BETA_FEATURE,
  buildClaudeCodeHeaders,
  buildAnthropicAuthHeaders,
  isAnthropicOAuthToken,
  splitSystemPromptForCaching,
} from '@neoxlabs/kernel/models/anthropicClaudeCode.js';
import { buildLayeredPrompt } from '../../runtime/prompts/layers/index.js';
import { VERSION } from '@neoxlabs/kernel/version.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';

describe('Anthropic Claude Code alignment', () => {
  it('does not inject a second default system prompt when caller already provides one', () => {
    const adapter = new AnthropicAdapter({
      authToken: 'test-key',
      baseUrl: 'https://timicc.com',
      defaultModel: 'claude-opus-4-6',
    });

    const prepared = adapter.prepareRequest([
      { role: 'system', content: 'caller system' },
      { role: 'user', content: 'hi' },
    ], {
      model: 'claude-opus-4-6',
    });

    expect(prepared.messages).toHaveLength(2);
    expect(prepared.messages[0]).toEqual({ role: 'system', content: 'caller system' });
  });

  it('splits dynamic environment section out of the cacheable system prompt', () => {
    const prompt = buildLayeredPrompt({ workDir: '/tmp/neox', language: 'zh' });
    const blocks = splitSystemPromptForCaching(prompt);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.cacheMode).toBe('global');
    expect(blocks[1]?.cacheMode).toBe('none');
    expect(blocks[1]?.text).toContain('当前日期');
  });

  it('uses updated Claude-style headers with prompt-caching scope beta', () => {
    const headers = buildClaudeCodeHeaders({ authToken: 'test-key' });

    expect(headers['User-Agent']).toBe(`claude-cli/${VERSION} (external, cli)`);
    expect(headers['anthropic-beta']).toContain(PROMPT_CACHING_SCOPE_BETA_FEATURE);
    expect(headers['X-Stainless-Package-Version']).toBe('0.80.0');
  });

  it('API key 走 x-api-key (Anthropic 官方唯一的 key 头), 同时保留 Bearer 给只认它的代理', () => {
    const headers = buildAnthropicAuthHeaders('sk-proxy-abc123');

    expect(headers['x-api-key']).toBe('sk-proxy-abc123');
    expect(headers.Authorization).toBe('Bearer sk-proxy-abc123');

    /* Claude Code 伪装身份走同一份 —— 非官方网关默认落在这条路上 */
    expect(buildClaudeCodeHeaders({ authToken: 'sk-proxy-abc123' })['x-api-key']).toBe('sk-proxy-abc123');
  });

  it('OAuth token 只走 Bearer, 绝不进 x-api-key (订阅登录会被官方直接判 401)', () => {
    for (const token of ['sk-ant-oat01-xxx', 'sk-ant-ort01-xxx']) {
      expect(isAnthropicOAuthToken(token)).toBe(true);
      const headers = buildAnthropicAuthHeaders(token);
      expect(headers.Authorization).toBe(`Bearer ${token}`);
      expect(headers['x-api-key']).toBeUndefined();
      expect(buildClaudeCodeHeaders({ authToken: token })['x-api-key']).toBeUndefined();
    }
    /* 普通 API key 不能被误判成 OAuth —— 误判的代价是它永远不发 x-api-key */
    expect(isAnthropicOAuthToken('sk-ant-api03-xxx')).toBe(false);
    expect(buildAnthropicAuthHeaders('sk-ant-api03-xxx')['x-api-key']).toBe('sk-ant-api03-xxx');
  });

  it('builds cache-stable system blocks and sorts tool payloads deterministically', () => {
    const provider = new AnthropicProvider({
      authToken: 'test-key',
      baseUrl: 'https://timicc.com',
      defaultModel: 'claude-sonnet-4-5-20250929',
    });

    const prompt = buildLayeredPrompt({ workDir: '/tmp/neox', language: 'zh' });
    const tools: Tool[] = [
      {
        name: 'write_file',
        description: 'write file',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        function: () => '',
      },
      {
        name: 'readfile',
        description: 'read file',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        function: () => '',
      },
    ];

    const payload = (provider as any).buildPayload([
      { role: 'system', content: prompt },
      { role: 'user', content: 'hi' },
    ], {
      model: 'claude-sonnet-4-5-20250929',
      tools,
    });

    expect(payload.system).toHaveLength(3);
    /* CLAUDE_CODE_SYSTEM_PROMPT 只 15 tokens, 不再单独 breakpoint —— 由 system[1] 的
     *  cache_control 一并覆盖. cache-analysis WARN "system[0] cached block is short" 消除. */
    expect(payload.system[0]).toMatchObject({
      type: 'text',
      text: CLAUDE_CODE_SYSTEM_PROMPT,
    });
    expect(payload.system[0]?.cache_control).toBeUndefined();
    expect(payload.system[1]?.cache_control).toEqual({ type: 'ephemeral', scope: 'global' });
    expect(payload.system[2]?.cache_control).toBeUndefined();
    expect(payload.tools.map((tool: any) => tool.name)).toEqual(['Read', 'Write']);
  });

  it('respects request-scoped max tokens and skips auto-thinking for tiny side queries', () => {
    const provider = new AnthropicProvider({
      authToken: 'test-key',
      baseUrl: 'https://timicc.com',
      defaultModel: 'claude-opus-4-6',
    });

    const payload = (provider as any).buildPayload([
      { role: 'user', content: 'reply with a tiny JSON blob' },
    ], {
      model: 'claude-opus-4-6',
      maxInputTokens: 600,
    });

    expect(payload.max_tokens).toBe(600);
    expect(payload.thinking).toBeUndefined();
  });

  it('uses request maxTokens and disables SSE when side-agent asks for stream:false', () => {
    const provider = new AnthropicProvider({
      authToken: 'test-key',
      baseUrl: 'https://api.anthropic.com',
      defaultModel: 'claude-opus-4-6',
    });

    const payload = (provider as any).buildPayload([
      { role: 'user', content: 'reply with a tiny JSON blob' },
    ], {
      model: 'claude-opus-4-6',
      maxTokens: 321,
      stream: false,
      thinking: { type: 'disabled' },
    });

    expect(payload.max_tokens).toBe(321);
    expect(payload.stream).toBe(false);
    expect(payload.thinking).toBeUndefined();
  });

  it('does NOT add cache_reference in any mode (removed as universal dead weight)', () => {
    const provider = new AnthropicProvider({
      authToken: 'test-key',
      baseUrl: 'https://timicc.com',
      defaultModel: 'claude-sonnet-4-5-20250929',
    });

    const payload = (provider as any).buildPayload([
      { role: 'user', content: 'inspect first file' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'readfile', arguments: '{"path":"a.ts"}' } }],
      } as any,
      { role: 'tool', tool_call_id: 'toolu_1', content: 'file-a' } as any,
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'toolu_2', type: 'function', function: { name: 'readfile', arguments: '{"path":"b.ts"}' } }],
      } as any,
      { role: 'tool', tool_call_id: 'toolu_2', content: 'file-b' } as any,
    ], {
      model: 'claude-sonnet-4-5-20250929',
    });

    const firstToolResult = payload.messages[2].content[0];
    const lastToolResult = payload.messages[4].content[0];

    /* cache_control 仍然给最后一条 tool_result — prefix caching 全靠它 */
    expect(lastToolResult.cache_control).toEqual({ type: 'ephemeral' });
    /* cache_reference 一处都不能有 (proxy 模式也不加, 老 gate 已废) */
    expect(firstToolResult.cache_reference).toBeUndefined();
    expect(lastToolResult.cache_reference).toBeUndefined();
  });

  /* 官方 Anthropic API (api.anthropic.com) 拒绝 cache_reference — schema 严格,
   *   见到未知字段直接 INVALID_REQUEST: "Extra inputs are not permitted".
   *   cache_reference 只是 Claude Code 客户端专有字段, prefix caching 靠 cache_control 就够。
   *   守住这条修, 防止将来重新对齐 Claude Code 格式时又误加回来打挂用户。 */
  it('does NOT add cache_reference when baseUrl is official Anthropic API', () => {
    const provider = new AnthropicProvider({
      authToken: 'test-key',
      baseUrl: 'https://api.anthropic.com',
      defaultModel: 'claude-sonnet-4-5-20250929',
    });

    const payload = (provider as any).buildPayload([
      { role: 'user', content: 'inspect first file' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'readfile', arguments: '{"path":"a.ts"}' } }],
      } as any,
      { role: 'tool', tool_call_id: 'toolu_1', content: 'file-a' } as any,
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'toolu_2', type: 'function', function: { name: 'readfile', arguments: '{"path":"b.ts"}' } }],
      } as any,
      { role: 'tool', tool_call_id: 'toolu_2', content: 'file-b' } as any,
    ], {
      model: 'claude-sonnet-4-5-20250929',
    });

    const firstToolResult = payload.messages[2].content[0];
    const lastToolResult = payload.messages[4].content[0];

    /* cache_control 仍在最后一条 tool_result 上 — 官方 API 需要它做 prefix caching */
    expect(lastToolResult.cache_control).toEqual({ type: 'ephemeral' });
    /* cache_reference 完全没加 — 任何 tool_result 都不能带这个字段 */
    expect(firstToolResult.cache_reference).toBeUndefined();
    expect(lastToolResult.cache_reference).toBeUndefined();
  });

  /* 老会话痛点: gate 修好前, addCacheReferencesBeforeBreakpoint 已经把 cache_reference
   *   原地 mutate 到 in-memory 消息 block 里. 用户"继续"发送, 携带残留字段, 官方 API
   *   继续 INVALID_REQUEST. 官方 API 路径必须主动 strip. */
  /* E2 修复回归: tools 分区排序 (built-in 前, custom 后) + cache_control anchor 打在
   *   built-in 段末尾, 而不是 flat localeCompare + 打到 tail custom.
   *   证据: analyzeAnthropicCachePayload 应报告 officialBuiltInPrefixCompatible=true, 无 interleaved WARN. */
  it('partitions built-in tools before custom tools and anchors cache_control on last built-in', async () => {
    const provider = new AnthropicProvider({
      authToken: 'test-key',
      baseUrl: 'https://timicc.com',
      defaultModel: 'claude-sonnet-4-5-20250929',
    });
    /* 混内部名 (代理模式会 remap) + custom 名, 故意让 flat alpha 会打散 built-in:
     *   flat 结果: [abandon_target, activate_target, ask_user, edit_file, execute_shell, readfile, write_file, agent_x]
     *              remap 后: [AbandonTarget, ActivateTarget, AskUserQuestion, Edit, Bash, Read, Write, AgentX]
     *              第 0 位是 custom → built_in_prefix=0.
     *   分区后:     [built-in 6 排字母] + [custom 排字母]
     *              = [AskUserQuestion, Bash, Edit, Read, Write, AbandonTarget, ActivateTarget, AgentX] */
    const tools: Tool[] = [
      { name: 'abandon_target', description: 'x', parameters: { type: 'object', properties: {}, additionalProperties: false }, function: () => '' },
      { name: 'activate_target', description: 'x', parameters: { type: 'object', properties: {}, additionalProperties: false }, function: () => '' },
      { name: 'ask_user', description: 'x', parameters: { type: 'object', properties: {}, additionalProperties: false }, function: () => '' },
      { name: 'edit_file', description: 'x', parameters: { type: 'object', properties: {}, additionalProperties: false }, function: () => '' },
      { name: 'execute_shell', description: 'x', parameters: { type: 'object', properties: {}, additionalProperties: false }, function: () => '' },
      { name: 'readfile', description: 'x', parameters: { type: 'object', properties: {}, additionalProperties: false }, function: () => '' },
      { name: 'write_file', description: 'x', parameters: { type: 'object', properties: {}, additionalProperties: false }, function: () => '' },
      { name: 'agent_x', description: 'x', parameters: { type: 'object', properties: {}, additionalProperties: false }, function: () => '' },
    ];

    const payload = (provider as any).buildPayload([
      { role: 'user', content: 'hi' },
    ], {
      model: 'claude-sonnet-4-5-20250929',
      tools,
    });

    const names = payload.tools.map((t: any) => t.name);
    /* 前 5 位必须全是 built-in (5 因为 8 个工具里 built-in remap 后共 5: AskUserQuestion/Bash/Edit/Read/Write) */
    expect(names.slice(0, 5)).toEqual(['AskUserQuestion', 'Bash', 'Edit', 'Read', 'Write']);
    /* 后 3 位是 custom, 字母序 */
    expect(names.slice(5)).toEqual(['AbandonTarget', 'ActivateTarget', 'AgentX']);

    /* cache_control 锚在 built-in 段末尾 (index 4 = Write), 不再在数组末尾 (AgentX). */
    expect(payload.tools[4].cache_control).toEqual({ type: 'ephemeral' });
    expect(payload.tools[payload.tools.length - 1].cache_control).toBeUndefined();

    /* 用 cache-analysis 自诊断确认 WARN 全消 */
    const { analyzeAnthropicCachePayload } = await import('../../../../../packages/kernel/dist/utils/anthropicCachePayloadAnalysis.js');
    const analysis = analyzeAnthropicCachePayload(payload);
    expect(analysis.tools.officialBuiltInPrefixCompatible).toBe(true);
    expect(analysis.tools.interleavedBuiltInsAfterDynamic).toEqual([]);
    /* 关键 WARN 不再出现 */
    const bannedWarnPatterns = [
      /tool order is not official-prefix-compatible/,
      /built-in tools appear after MCP\/custom tools/,
      /tool cache_control is after first MCP\/custom tool/,
      /tools look flat alphabetically sorted/,
      /system\[0\] cached block is short/,
    ];
    for (const pat of bannedWarnPatterns) {
      const hit = analysis.warnings.find((w: string) => pat.test(w));
      expect(hit, `unexpected warn: ${hit}`).toBeUndefined();
    }
  });

  /* 兜底: 纯 custom tools (built-in remap set 里一个都没匹配上, 比如 isProxyMode=false 场景)
   *   分区退化为 all-custom, cache_control 仍应落在数组末尾 (原行为), 不能崩. */
  it('falls back to tail anchor when no built-in tools match', () => {
    const provider = new AnthropicProvider({
      authToken: 'test-key',
      baseUrl: 'https://api.anthropic.com',   // 非代理: transformToolDefinition 不 remap
      defaultModel: 'claude-sonnet-4-5-20250929',
    });
    const tools: Tool[] = [
      { name: 'aaa_custom', description: 'x', parameters: { type: 'object', properties: {}, additionalProperties: false }, function: () => '' },
      { name: 'zzz_custom', description: 'x', parameters: { type: 'object', properties: {}, additionalProperties: false }, function: () => '' },
    ];
    const payload = (provider as any).buildPayload([
      { role: 'user', content: 'hi' },
    ], {
      model: 'claude-sonnet-4-5-20250929',
      tools,
    });
    /* 官方 API 模式下 tool.name 保持原样, 分区 set 匹不上, 全走 custom 分区 alpha 序 */
    expect(payload.tools.map((t: any) => t.name)).toEqual(['aaa_custom', 'zzz_custom']);
    expect(payload.tools[payload.tools.length - 1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('strips pre-existing cache_reference from history when talking to official Anthropic API', () => {
    const provider = new AnthropicProvider({
      authToken: 'test-key',
      baseUrl: 'https://api.anthropic.com',
      defaultModel: 'claude-sonnet-4-5-20250929',
    });

    /* 模拟老会话残留: tool 消息里已经带着 cache_reference. 传给 provider (buildPayload
     *   会先做 OpenAI→Anthropic 转换 — 转换器不会主动加 cache_reference, 所以我们造一个
     *   assistant 里带 tool_use + user 里带含 cache_reference 的 tool_result 的场景).
     *   直接调 stripCacheReferences 更直接地锁行为. */
    const contaminated: any[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'x', cache_reference: 'toolu_1' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'y', cache_reference: 'toolu_2' },
        ],
      },
    ];
    const stripped = (provider as any).stripCacheReferences(contaminated);
    expect(stripped).toBe(2);
    expect(contaminated[1].content[0]).not.toHaveProperty('cache_reference');
    expect(contaminated[1].content[1]).not.toHaveProperty('cache_reference');
    /* 别的字段无损 */
    expect(contaminated[1].content[0].tool_use_id).toBe('toolu_1');
    expect(contaminated[1].content[1].content).toBe('y');
  });
});
