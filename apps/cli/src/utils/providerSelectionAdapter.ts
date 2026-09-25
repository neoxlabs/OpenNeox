import type { ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';
import { PROTOCOL_LABELS } from '../constants.js';
import type { SelectionChoice } from '../cliTypes.js';

export async function selectProviderFromListForMain(params: {
  providerStore: any;
  providerId: string;
  message: string;
  promptSelect: (question: string, choices: SelectionChoice[], defaultValue?: string, hint?: string) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
}): Promise<ProviderConfigEntry | null> {
  /* sentinel 'neox-cloud' 不在这显示 — 订阅模型走单独菜单 (runSubscriptionModelMenu),
   * BYOK 菜单只列 BYOK provider, 否则用户在 "Custom" 二级又看到一个 'neox-cloud' 项
   * 跟订阅菜单功能重叠. */
  const allProviders = params.providerStore.getProviders();
  const providers = (allProviders as ProviderConfigEntry[]).filter((p) => p.id !== 'neox-cloud');
  if (providers.length === 0) {
    params.logInfo('No providers configured', 'Use /provider add to create one.');
    return null;
  }

  const choices: SelectionChoice[] = [
    { label: '← 返回', value: '__back__' },
    { label: '+ 添加 Provider', value: '__add__' },
    ...providers.map((provider: ProviderConfigEntry) => {
      const proto = (PROTOCOL_LABELS[provider.protocol] || 'OpenAI').replace(/\s*\((?:[^()]|\([^()]*\))*\)\s*$/, '');
      const names = provider.models.map(m => m.name);
      const models = names.length === 0 ? '还没有模型'
        : `${names.length} 个模型 · ${names.slice(0, 2).join(', ')}${names.length > 2 ? ' …' : ''}`;
      return {
        label: `${provider.name} — ${proto}`,
        value: provider.id,
        description: models,
        isCurrent: provider.id === params.providerId,
      };
    }),
  ];

  const choice = await params.promptSelect(
    params.message,
    choices,
    params.providerId
  );

  if (choice === '__back__') {
    return null;
  }

  if (choice === '__add__') {
    // Return special marker to trigger add flow
    return { id: '__add__' } as ProviderConfigEntry;
  }

  return params.providerStore.getProvider(choice) || null;
}

export async function selectModelFromProviderForMain(params: {
  provider: ProviderConfigEntry;
  providerId: string;
  model: string;
  promptSelect: (question: string, choices: SelectionChoice[], defaultValue?: string, hint?: string) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
  message: string;
}): Promise<string | null> {
  if (!params.provider || params.provider.models.length === 0) {
    params.logInfo('No models configured', `Use /model add to register a model for ${params.provider?.name || 'provider'}.`);
    return null;
  }

  const initial =
    (params.provider.id === params.providerId ? params.model : null) ||
    params.provider.lastSelectedModel ||
    params.provider.defaultModel ||
    params.provider.models[0].name;

  const choices: SelectionChoice[] = [
    { label: '← 返回', value: '__back__' },
    { label: '+ 添加模型', value: '__add__' },
    { label: '删除模型', value: '__delete__' },
  ];

  const configuredNames = new Set(params.provider.models.map(m => m.name));
  let discoveredOnly: string[] = [];
  try {
    const { discoverModels } = await import('../provider/discoverModels.js');
    const DISCOVER_BUDGET_MS = 700;
    const discovering = discoverModels(params.provider);
    void Promise.resolve(discovering).catch(() => { /* 后台跑完即可, 失败无需打扰 */ });
    const result = await Promise.race([
      Promise.resolve(discovering).catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), DISCOVER_BUDGET_MS)),
    ]);
    if (result) {
      discoveredOnly = result.models
        .map(m => m.id)
        .filter(name => name && !configuredNames.has(name));
    }
  } catch { /* discoverModels 失败不阻塞 */ }

  /* configured model 先列 (用户手动配的优先), discovered 接在后面 dim */
  for (const model of params.provider.models) {
    const isCurrent = params.provider.id === params.providerId && model.name === params.model;
    choices.push({ label: model.name, value: model.name, isCurrent });
  }
  for (const name of discoveredOnly) {
    choices.push({ label: name, value: name, description: '服务端可用, 选中后自动加入' });
  }

  const result = await params.promptSelect(
    params.message,
    choices,
    initial
  );

  if (result === '__back__') return null;
  if (result === '__add__') return '__add__';
  if (result === '__delete__') return '__delete__';

  /* 用户选了 discovered (非 configured) → 自动加到 provider.models, 下次直接列 */
  if (result && discoveredOnly.includes(result) && !configuredNames.has(result)) {
    try {
      const { loadConfig, saveConfig } = await import('@neoxlabs/platform/utils/config.js');
      const config = loadConfig();
      const p = config.providers?.[params.provider.id];
      if (p) {
        const ts = new Date().toISOString();
        p.models = [...(p.models || []), { name: result, createdAt: ts }];
        p.lastSelectedModel = result;
        p.updatedAt = ts;
        saveConfig(config);
      }
    } catch { /* persist 失败不影响本次切换 */ }
  }

  return result;
}
