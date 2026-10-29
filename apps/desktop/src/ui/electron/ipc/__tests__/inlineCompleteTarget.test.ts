import { describe, expect, it, vi, beforeEach } from 'vitest';

const state: { appState: Record<string, unknown>; inline: any } = { appState: {}, inline: { enabled: true } };
const providers: Record<string, any> = {
  'napi-grok': { id: 'napi-grok', protocol: 'openai', models: [{ name: 'Grok 4.5' }], lastSelectedModel: 'Grok 4.5' },
  'opencode-zen': { id: 'opencode-zen', protocol: 'openai', models: [{ name: 'deepseek-v4.1-flash' }] },
  'img': { id: 'img', protocol: 'openai-images', models: [{ name: 'gpt-image-2' }] },
};

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../ipcMainBridged.js', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('@neoxlabs/platform/platform/database.js', () => ({
  getDatabase: () => ({ getAppState: (k: string, d: unknown) => (k in state.appState ? state.appState[k] : d) }),
}));
vi.mock('@neoxlabs/platform/platform/configService.js', () => ({
  configService: {
    resolveInlineCompletionTarget: () => null,
    getInlineCompletionConfig: () => state.inline,
    getProviderEntryById: (id: string) => providers[id] ?? null,
    getDefaultProviderEntry: () => providers['napi-grok'],
    getProviders: () => Object.values(providers),
  },
}));

const { resolveInlineCompleteTarget } = await import('../aiHandlers.js');

describe('行内补全「默认」跟随输入框当前模型', () => {
  beforeEach(() => { state.appState = {}; state.inline = { enabled: true }; });

  it('输入框选了 deepseek → 补全用 deepseek, 不是默认服务商的 Grok', () => {
    state.appState['ui:lastModelId'] = 'opencode-zen:deepseek-v4.1-flash';
    const t = resolveInlineCompleteTarget();
    expect(t?.provider.id).toBe('opencode-zen');
    expect(t?.model).toBe('deepseek-v4.1-flash');
    expect(t?.source).toBe('auto');
  });

  it('设置里指定了服务商 → 在那家里挑, 不看输入框', () => {
    state.appState['ui:lastModelId'] = 'opencode-zen:deepseek-v4.1-flash';
    state.inline = { enabled: true, providerId: 'napi-grok' };
    expect(resolveInlineCompleteTarget()?.provider.id).toBe('napi-grok');
  });

  it('当前模型对不上已配置的服务商 / 是出图服务商 → 退回原来的默认逻辑', () => {
    state.appState['ui:lastModelId'] = 'gone:whatever';
    expect(resolveInlineCompleteTarget()?.provider.id).toBe('napi-grok');
    state.appState['ui:lastModelId'] = 'img:gpt-image-2';
    expect(resolveInlineCompleteTarget()?.provider.id).toBe('napi-grok');
  });
});
