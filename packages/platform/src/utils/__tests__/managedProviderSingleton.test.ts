import { describe, expect, it, vi } from 'vitest';

const saveConfig = vi.fn();

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, loadConfig: () => ({ providers: {} }), saveConfig };
});

const { ProviderStore } = await import('../providerStore.js');

const managed = { id: 'neox-cloud', name: 'Neox Cloud', protocol: 'openai' as any, apiKey: 'neox-managed', baseUrl: '', models: [] };

describe('托管 provider 重复添加', () => {
  it('已有 neox-cloud 时再加一次: 返回现有的, 不落 neox-cloud-2, 默认不变', () => {
    const cfg: any = { providers: {}, defaultProviderId: undefined };
    const store = new ProviderStore(cfg);
    store.addProvider({ ...managed, setAsDefault: true } as any);
    const again = store.addProvider({ ...managed, setAsDefault: true } as any);
    expect(again.id).toBe('neox-cloud');
    expect(Object.keys(cfg.providers)).toEqual(['neox-cloud']);
    expect(cfg.defaultProviderId).toBe('neox-cloud');
  });

  it('普通 provider 同 id 照旧加成 "-2" (迁移导入要用)', () => {
    const cfg: any = { providers: {} };
    const store = new ProviderStore(cfg);
    const byok = { id: 'openai', name: 'OpenAI', protocol: 'openai' as any, apiKey: 'sk-a', models: ['gpt-x'] };
    store.addProvider(byok as any);
    const second = store.addProvider({ ...byok, apiKey: 'sk-b' } as any);
    expect(second.id).toBe('openai-2');
  });
});
