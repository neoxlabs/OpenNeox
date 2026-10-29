import { describe, expect, it, vi, beforeEach } from 'vitest';

const saveConfig = vi.fn();

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, loadConfig: () => ({ providers: {} }), saveConfig };
});

const { ProviderStore } = await import('../providerStore.js');

const image = {
  id: 'relay-img', name: 'relay-a 图片中转', protocol: 'openai-images', apiKey: 'k', baseUrl: 'https://x/v1',
  models: [{ id: 'gpt-image-2.5', name: 'gpt-image-2.5' }], defaultModel: 'gpt-image-2.5',
};
const chat = {
  id: 'deepseek', name: 'deepseek', protocol: 'openai', apiKey: 'k', baseUrl: 'https://y/v1',
  models: [{ id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' }], defaultModel: 'deepseek-v4-flash',
};

function store(defaultProviderId?: string) {
  return new ProviderStore({ providers: { [image.id]: { ...image }, [chat.id]: { ...chat } }, defaultProviderId } as any);
}

beforeEach(() => saveConfig.mockClear());

describe('ProviderStore · default provider is a chat provider', () => {
  it('fallback skips the image-only provider that sorts first, and does not persist', () => {
    const s = store('neox-cloud'); // default momentarily missing
    expect(s.getDefaultProvider()?.id).toBe('deepseek');
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('a stored image-only default is ignored, not used for chat', () => {
    expect(store('relay-img').getDefaultProvider()?.id).toBe('deepseek');
  });

  it('refuses to set an image-only provider as default', () => {
    expect(() => store('deepseek').setDefaultProvider('relay-img')).toThrow(/can't chat/);
  });
});
