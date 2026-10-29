import { beforeEach, describe, expect, it, vi } from 'vitest';

const configState = vi.hoisted(() => ({
  config: {} as any,
}));

/** 可编程 ask_user 假通道 — 控制 propose_set 确认卡的用户答复 */
const askUserState = vi.hoisted(() => ({
  answer: null as null | ((args: any) => string),
  calls: [] as any[],
}));

vi.mock('@neoxlabs/platform/utils/config.js', () => ({
  CONFIG_FILE: '/tmp/neox/config.json',
  loadConfig: () => configState.config,
  saveConfig: vi.fn((config: any) => {
    configState.config = config;
  }),
  onUserIdChange: () => {},
}));

vi.mock('../askUserTool.js', () => ({
  askUserTool: {
    name: 'ask_user',
    function: vi.fn(async (args: any) => {
      askUserState.calls.push(args);
      if (!askUserState.answer) {
        return JSON.stringify({ status: 'success', skipped: true, reason: 'no_interactive_ui' });
      }
      return askUserState.answer(args);
    }),
  },
}));

import { createNeoxConfigTools } from '../neoxConfigTool.js';
import { saveConfig } from '@neoxlabs/platform/utils/config.js';
import { refreshAgentRuntimeConfig } from '@neoxlabs/platform/runtime/agentRuntimeConfig.js';

const findTool = (name: string) => createNeoxConfigTools().find(tool => tool.name === name);

describe('neox config tools', () => {
  const secret = 'sk-live-1234567890abcdef';

  beforeEach(() => {
    configState.config = {
      defaultProviderId: 'openai',
      providers: {
        openai: {
          name: 'OpenAI',
          protocol: 'openai',
          apiKey: secret,
          baseUrl: 'https://api.openai.com/v1',
          defaultModel: 'gpt-4.1',
          models: [{ name: 'gpt-4.1' }],
        },
      },
      webSearch: {
        enabled: true,
        accessToken: 'web-search-token-secret',
      },
    };
    askUserState.answer = null;
    askUserState.calls = [];
    vi.mocked(saveConfig).mockClear();
    delete process.env.NEOX_MODEL_ORCHESTRATION;
    delete process.env.NEOX_SANDBOX_MODE;
    delete process.env.NEOX_OS_SANDBOX;
    refreshAgentRuntimeConfig();
  });

  it('redacts provider secrets when reading a config section', async () => {
    const readConfig = findTool('read_neox_config');
    const output = await readConfig!.function({ key: 'providers' });

    expect(output).not.toContain(secret);
    expect(output).toContain('sk-l...cdef');
  });

  it('always redacts secrets when exporting config', async () => {
    const exportConfig = findTool('neox_export_config');
    const output = await exportConfig!.function({ includeKeys: true });

    expect(output).not.toContain(secret);
    expect(output).not.toContain('web-search-token-secret');
    expect(output).toContain('includeKeys=true 已被安全策略忽略');
  });
});

describe('neox_config unified tool (Team P1 能力1)', () => {
  const secret = 'sk-live-1234567890abcdef';
  const tool = () => findTool('neox_config')!;

  beforeEach(() => {
    configState.config = {
      language: 'zh',
      defaultProviderId: 'anthropic',
      providers: {
        anthropic: {
          name: 'Anthropic',
          protocol: 'anthropic',
          apiKey: secret,
          defaultModel: 'claude-sonnet-4-6',
          models: [{ name: 'claude-sonnet-4-6' }],
        },
        'neox-cloud': {
          name: 'Neox 订阅',
          protocol: 'openai',
          apiKey: 'neox-managed',
          models: [],
        },
      },
      agentRuntime: {},
    };
    askUserState.answer = null;
    askUserState.calls = [];
    vi.mocked(saveConfig).mockClear();
    delete process.env.NEOX_MODEL_ORCHESTRATION;
    delete process.env.NEOX_SANDBOX_MODE;
    delete process.env.NEOX_OS_SANDBOX;
    delete process.env.NEOX_SANDBOX;
    refreshAgentRuntimeConfig();
  });

  it('schema 级危险面排除: domain 枚举只有 5 个常规域', () => {
    const domainEnum = (tool().parameters as any).properties.domain.enum;
    expect(domainEnum).toEqual(['models', 'routing', 'team', 'runtime', 'appearance']);
    // 审批/沙箱/密钥面不在枚举里
    expect(domainEnum).not.toContain('approval');
    expect(domainEnum).not.toContain('sandbox');
    expect(domainEnum).not.toContain('providers');
  });

  it('get models: 返回池清单 + registry 能力分数, 且不泄漏 API key', async () => {
    const out = await tool().function({ action: 'get', domain: 'models' });
    expect(out).not.toContain(secret);
    const parsed = JSON.parse(out);
    expect(parsed.domain).toBe('models');
    const byok = parsed.pools.find((p: any) => p.providerId === 'anthropic');
    expect(byok.kind).toBe('byok');
    expect(byok.isDefault).toBe(true);
    expect(byok.keyConfigured).toBe(true);
    // claude-sonnet-4-6 在模型注册表有档案 → 带能力分数
    const model = byok.models.find((m: any) => m.name === 'claude-sonnet-4-6');
    expect(model.scores).toBeTruthy();
    expect(typeof model.scores.coding).toBe('number');
    // 订阅池标注
    const sub = parsed.pools.find((p: any) => p.providerId === 'neox-cloud');
    expect(sub.kind).toBe('subscription');
  });

  it('get routing: 反映编排开关与偏好提示', async () => {
    configState.config.agentRuntime = {
      modelOrchestration: 'on',
      modelOrchestrationHints: ['审查都用 GPT'],
    };
    refreshAgentRuntimeConfig();
    const parsed = JSON.parse(await tool().function({ action: 'get', domain: 'routing' }));
    expect(parsed.orchestration).toBe('on');
    expect(parsed.preferences).toEqual(['审查都用 GPT']);
  });

  it('get team: RoleRegistry 未落地时返回内置四角色静态描述', async () => {
    const parsed = JSON.parse(await tool().function({ action: 'get', domain: 'team' }));
    expect(parsed.status).toBe('builtin_static');
    expect(parsed.roles.map((r: any) => r.id)).toEqual(['planner', 'implementer', 'reviewer', 'researcher']);
  });

  it('get runtime: 并发/超时/沙箱只读展示', async () => {
    const parsed = JSON.parse(await tool().function({ action: 'get', domain: 'runtime' }));
    expect(parsed.concurrency.backgroundAgentLimit).toBeGreaterThanOrEqual(1);
    expect(parsed.sandbox.mode).toBe('workspace-write');
    expect(parsed.writable).toEqual(['concurrencyProfile']);
  });

  it('list: 列出全部域与可写键白名单', async () => {
    const parsed = JSON.parse(await tool().function({ action: 'list' }));
    expect(parsed.domains).toHaveLength(5);
    const routing = parsed.domains.find((d: any) => d.domain === 'routing');
    expect(routing.writable.map((w: any) => w.key)).toEqual(['orchestration', 'preferences']);
    const models = parsed.domains.find((d: any) => d.domain === 'models');
    expect(models.writable).toEqual([]);
  });

  it('propose_set: 不可写键被拒并列出该域可写键', async () => {
    const out = await tool().function({ action: 'propose_set', domain: 'appearance', key: 'theme', value: 'dark' });
    expect(out).toContain('❌');
    expect(out).toContain('language');
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('propose_set: 值校验失败即拒, 不弹确认卡', async () => {
    const out = await tool().function({ action: 'propose_set', domain: 'routing', key: 'orchestration', value: 'yes' });
    expect(out).toContain('❌');
    expect(askUserState.calls).toHaveLength(0);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('propose_set: 用户点"应用变更"后才落盘 (含 agentRuntime 热刷)', async () => {
    askUserState.answer = (args) => `Q: ${args.questions[0].question}\nA: 应用变更`;
    const out = await tool().function({ action: 'propose_set', domain: 'routing', key: 'orchestration', value: 'on' });
    expect(askUserState.calls).toHaveLength(1);
    expect(out).toContain('✅');
    expect(saveConfig).toHaveBeenCalledTimes(1);
    expect(configState.config.agentRuntime.modelOrchestration).toBe('on');
  });

  it('propose_set: 用户取消 → 返回提案原文, 不落盘', async () => {
    askUserState.answer = (args) => `Q: ${args.questions[0].question}\nA: 取消`;
    const out = await tool().function({ action: 'propose_set', domain: 'routing', key: 'orchestration', value: 'on' });
    expect(out).toContain('未应用');
    expect(out).toContain('"proposed": "on"');
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('propose_set: 无交互通道 (headless) → 提案文本 + 引导设置页, 不落盘', async () => {
    askUserState.answer = null; // fake 返回 no_interactive_ui
    const out = await tool().function({ action: 'propose_set', domain: 'routing', key: 'orchestration', value: 'on' });
    expect(out).toContain('未应用');
    expect(out).toContain('设置页');
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('propose_set: 只读沙箱会话直接拒绝提案', async () => {
    configState.config.agentRuntime = { osSandbox: { enabled: true, mode: 'read-only' } };
    refreshAgentRuntimeConfig();
    const out = await tool().function({ action: 'propose_set', domain: 'appearance', key: 'language', value: 'en' });
    expect(out).toContain('只读沙箱');
    expect(askUserState.calls).toHaveLength(0);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('propose_set: preferences 接受字符串数组并限制条数', async () => {
    askUserState.answer = (args) => `Q: ${args.questions[0].question}\nA: 应用变更`;
    await tool().function({ action: 'propose_set', domain: 'routing', key: 'preferences', value: ['审查都用 GPT', 'explore 用最快的'] });
    expect(configState.config.agentRuntime.modelOrchestrationHints).toEqual(['审查都用 GPT', 'explore 用最快的']);

    const tooMany = Array.from({ length: 11 }, (_, i) => `p${i}`);
    const out = await tool().function({ action: 'propose_set', domain: 'routing', key: 'preferences', value: tooMany });
    expect(out).toContain('最多 10 条');
  });

  it('propose_set: 值未变化时短路返回, 不弹卡', async () => {
    const out = await tool().function({ action: 'propose_set', domain: 'routing', key: 'orchestration', value: 'off' });
    expect(out).toContain('已是该值');
    expect(askUserState.calls).toHaveLength(0);
  });
});
