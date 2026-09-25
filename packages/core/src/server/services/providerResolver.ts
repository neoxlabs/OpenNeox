import fs from 'node:fs';
import type { NeoxConfig, ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';
import { loadConfig, getActiveConfigFile } from '@neoxlabs/platform/utils/config.js';
import { ProviderStore } from '@neoxlabs/platform/utils/providerStore.js';
import type { ProviderResolution } from '../../runtime/runtimeOrchestrator.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { resolveProviderEntry } from '@neoxlabs/platform/platform/providerResolver.js';
import { resolveModelCapabilities } from '@neoxlabs/platform/platform/modelCapabilities.js';
import { toModelId } from './modelIdNormalize.js';

export class ProviderResolver {
  private providerStore: ProviderStore;
  private configMtimeMs: number;
  private activeConfigFile: string;

  constructor(config: NeoxConfig) {
    this.providerStore = new ProviderStore(config);
    this.activeConfigFile = getActiveConfigFile();
    this.configMtimeMs = this.getConfigMtimeMs();
  }

  private getConfigMtimeMs(): number {
    try {
      return fs.statSync(this.activeConfigFile).mtimeMs;
    } catch {
      return 0;
    }
  }

  private ensureFreshStore(): ProviderStore {
    /* 双条件触发重建:
     *  1. active config 路径变
     *  2. 当前 active 文件 mtime 变 (用户编辑配置 / neoxCloudProviderSync 写入)
     */
    const nextActiveFile = getActiveConfigFile();
    if (nextActiveFile !== this.activeConfigFile) {
      this.activeConfigFile = nextActiveFile;
      this.providerStore = new ProviderStore(loadConfig());
      this.configMtimeMs = this.getConfigMtimeMs();
      return this.providerStore;
    }
    const currentMtimeMs = this.getConfigMtimeMs();
    if (currentMtimeMs !== this.configMtimeMs) {
      this.configMtimeMs = currentMtimeMs;
      this.providerStore = new ProviderStore(loadConfig());
    }
    return this.providerStore;
  }

  private reloadStore(): ProviderStore {
    this.providerStore = new ProviderStore(loadConfig());
    this.configMtimeMs = this.getConfigMtimeMs();
    return this.providerStore;
  }

  /** 全部 provider (apiKey 已解密, 随 config 文件 mtime 自动刷新). imageGenService 等
   *  需要"实时 + 明文 key"的消费方用这个, 别再直接读 loadConfig().providers (那是 wrapped 密文). */
  getAllProviders(): ProviderConfigEntry[] {
    return this.ensureFreshStore().getProviders();
  }

  getDefaultProvider(): ProviderConfigEntry | undefined {
    const provider = this.ensureFreshStore().getDefaultProvider();
    if (provider) {
      return resolveProviderEntry(provider, { intent: 'agent' });
    }
    return resolveProviderEntry(this.reloadStore().getDefaultProvider(), { intent: 'agent' });
  }

  resolve(providerId?: string, modelName?: string): ProviderResolution {
    let entry = this.ensureFreshStore().getProvider(providerId);

    if (!entry && providerId) {
      entry = this.reloadStore().getProvider(providerId);
      if (entry) {
        cliLogger.info('SERVER', `Provider "${providerId}" found after config reload`);
      }
    }

    if (!entry && !providerId) {
      if (modelName) {
        const declaring = this.ensureFreshStore().getProviders()
          .filter((p) => (p.models || []).some((m) => m.name === modelName));
        if (declaring.length === 1) entry = declaring[0];
      }
    }
    if (!entry && !providerId) {
      entry = this.reloadStore().getDefaultProvider();
    }

    if (!entry) {
      return { provider: null, llmConfig: null };
    }

    const resolved = resolveProviderEntry(entry, { intent: 'agent' })!;
    const isNeoxCloud = resolved.id === 'neox-cloud' || (resolved as any).apiKey === 'neox-managed';

    let model: string | undefined;
    if (isNeoxCloud) {
      /* 订阅模式：调用者传了 model 就直接用，网关负责校验合法性。
       * 客户端不查本地模型列表（neox-cloud sentinel 的 models[] 本来就是空的）。 */
      model = modelName;
      if (!model) {
        const lastSelected = (resolved as any).lastSelectedModel as string | undefined;
        model = lastSelected;
      }
    } else {
      /* BYOK 模式：用户自己配的 provider，走完整查找链。
       * 调用者传的 modelName 优先，否则按 lastSelected → defaultModel → models[0] 降级。 */
      const lastSelected = (resolved as any).lastSelectedModel as string | undefined;
      /* 显示名 → 模型 id (导入条目 { id:'grok-4.5', name:'Grok 4.5' } 被存成了显示名, 见 modelIdNormalize.ts) */
      model = toModelId(resolved as any, modelName || lastSelected || resolved.defaultModel || resolved.models?.[0]?.name);
    }

    if (!model) {
      cliLogger.warn('SERVER',
        `resolveProvider: no model (provider=${resolved.id}, isNeoxCloud=${isNeoxCloud}, caller=${modelName || 'none'})`);
    }

    const capabilities = model
      ? resolveModelCapabilities(resolved, model)
      : null;

    return {
      provider: resolved,
      llmConfig: {
        model,
        providerName: resolved.name || resolved.id,
        maxInputTokens: capabilities?.contextWindow ?? 128000,
        compatProfile: capabilities?.compatProfile ?? null,
      },
    };
  }
}
