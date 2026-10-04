/**
 * addModel 幂等 —— "已存在"不是错误
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── 修的是什么 ──────────────────────────────────────────────────────────────
 * 保存 Provider 表单时弹过这条 toast:
 *
 *   「更新 Provider失败: Error invoking remote method 'model:add':
 *     NeoxError: Model "mimo-v2.5" already exists for provider "opencode".」
 *
 * 两个问题叠在一起:
 *   1. 用户要的结果("这个模型在列表里")本来就已经是真的 —— 报错却把整次保存判成失败;
 *   2. 报错文案里 'model:add' 是 IPC 频道名、NeoxError 是类名, 对用户是纯噪音,
 *      而且没有任何下一步动作可做。
 *
 * 触发它的是 SettingsPage 那边 editingProvider.models 过期 (同一次保存里 updateProvider
 * 已经落过盘, 或模型是从"拉取模型"那条路进来的), toAdd 的去重去了个寂寞。
 * 去重判据放在每个调用方 = 每个入口各写一遍, 漏一个就弹一次假错 —— 所以幂等放在这一层。
 *
 * ──  这个文件绝不碰真实 config.json ──────────────────────────────────────
 * ProviderStore.persist() 是无条件 saveConfig()。 有过血泪教训: 单测构造
 * ProviderStore 就把用户真实 ~/.neox/config.json 全量顶掉("BYOK 神秘消失"元凶)。
 * 所以这里 mock 掉 config 模块的读写, 一个字节都不落盘。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const saveConfig = vi.fn();

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    /* 无参构造走 loadConfig —— 本文件全部传 in-memory config, 这条只是保险丝:
     * 万一哪天有人写了无参构造, 拿到的也是空配置而不是用户真实配置。 */
    loadConfig: () => ({ providers: {} }),
    saveConfig,
  };
});

const { ProviderStore } = await import('../providerStore.js');

function makeConfig() {
  return {
    providers: {
      opencode: {
        id: 'opencode',
        name: 'opencode',
        protocol: 'openai',
        models: [{ name: 'mimo-v2.5', createdAt: '2026-09-01T00:00:00.000Z' }],
        defaultModel: 'mimo-v2.5',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    },
  } as any;
}

beforeEach(() => saveConfig.mockClear());

describe('addModel 已存在时不报错', () => {
  it('重复添加同一个模型不抛 —— 用户要的结果已经达成了', () => {
    const store = new ProviderStore(makeConfig());
    expect(() => store.addModel('opencode', 'mimo-v2.5')).not.toThrow();
  });

  it('不会添成两条 —— 幂等不是"再塞一份"', () => {
    const store = new ProviderStore(makeConfig());
    store.addModel('opencode', 'mimo-v2.5');
    store.addModel('opencode', 'mimo-v2.5');
    const models = store.getProviderRaw('opencode')!.models.map((m: any) => m.name);
    expect(models).toEqual(['mimo-v2.5']);
  });

  it('两端空白视作同一个模型 (表单里粘进来常带空格)', () => {
    const store = new ProviderStore(makeConfig());
    store.addModel('opencode', '  mimo-v2.5  ');
    expect(store.getProviderRaw('opencode')!.models).toHaveLength(1);
  });

  it('已存在但带 makeDefault: 附带意图要生效, 不能因为"已存在"就整个跳过', () => {
    const cfg = makeConfig();
    cfg.providers.opencode.models.push({ name: 'kimi-k3', createdAt: '2026-09-01T00:00:00.000Z' });
    const store = new ProviderStore(cfg);
    store.addModel('opencode', 'kimi-k3', true);
    expect(store.getProviderRaw('opencode')!.defaultModel).toBe('kimi-k3');
  });

  it('已存在但带 modelConfig: 合并进那条模型而不是新增一条', () => {
    const store = new ProviderStore(makeConfig());
    store.addModel('opencode', 'mimo-v2.5', false, { maxTokens: 8192 } as any);
    const models = store.getProviderRaw('opencode')!.models;
    expect(models).toHaveLength(1);
    expect((models[0] as any).maxTokens).toBe(8192);
    /* createdAt 是"什么时候加的", 幂等再调一次不该把它刷新掉 */
    expect(models[0]!.createdAt).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('该报的错一个都不能少', () => {
  it('provider 不存在仍然报错 —— 这个用户改得动(去建 provider)', () => {
    const store = new ProviderStore(makeConfig());
    expect(() => store.addModel('nope', 'x')).toThrow(/does not exist/i);
  });

  it('空模型名仍然报错', () => {
    const store = new ProviderStore(makeConfig());
    expect(() => store.addModel('opencode', '   ')).toThrow();
  });
});

describe('新模型照旧能加进去 (别把幂等写成"什么都不做")', () => {
  it('没见过的模型正常追加, 不影响已有的', () => {
    const store = new ProviderStore(makeConfig());
    store.addModel('opencode', 'glm-5.3-flash');
    expect(store.getProviderRaw('opencode')!.models.map((m: any) => m.name))
      .toEqual(['mimo-v2.5', 'glm-5.3-flash']);
  });
});
