import { ipcMain } from './ipcMainBridged.js';
import { loadConfig, saveConfig } from '@neoxlabs/platform/utils/config.js';
import { resolveBuiltinModelProfile } from '@neoxlabs/kernel/profiles/index.js';
import { ALL_TOOLS } from '@neoxlabs/core/tools/runtimeTools.js';

function normalizeModelKey(model: string): string {
  return (model || '').trim().toLowerCase();
}

function normalizeDisabledTools(disabledTools: unknown): string[] {
  if (!Array.isArray(disabledTools)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of disabledTools) {
    if (typeof item !== 'string') continue;
    const toolName = item.trim();
    if (!toolName || seen.has(toolName)) continue;
    seen.add(toolName);
    normalized.push(toolName);
  }
  return normalized;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function resolveToolsetOverride(config: ReturnType<typeof loadConfig>, model: string, profileId?: string): {
  modelKey: string;
  modelDisabledTools: string[] | null;
  profileDisabledTools: string[] | null;
} {
  const modelKey = normalizeModelKey(model);
  const modelOverrides = config.toolsetOverridesByModel || {};
  const profileOverrides = config.toolsetOverrides || {};

  const modelDisabledTools = modelKey && hasOwn(modelOverrides, modelKey)
    ? normalizeDisabledTools(modelOverrides[modelKey])
    : null;
  const profileDisabledTools = profileId && hasOwn(profileOverrides, profileId)
    ? normalizeDisabledTools(profileOverrides[profileId])
    : null;

  return { modelKey, modelDisabledTools, profileDisabledTools };
}

const EDITABLE_PROFILE_PATHS = new Set<string>([
  'reasoning.effort',
  'reasoning.summary',
  'completion.unknownTaskFallback',
  'transport.openai.parallelToolCalls',
  'transport.openai.requestTimeoutMs',
  'transport.openai.streamRequestTimeoutMs',
  'behavior.retryOnIncompleteStream',
  /* behavior.suspectTruncationOnStopWithoutTools 同日移出 —— runner 里命中后只在 CLI_DEBUG 下打一行日志,
   * 注释写明「不在此处重试流」; 设置页「把无工具的停止当截断」开了也不会有任何不同。 */
  'prompt.language',
  'prompt.appendInstructions',
  'prompt.userInstructions',
]);

export function registerModelProfileIpcHandlers(): void {
  ipcMain.handle('model-profile:list-tools', async () => {
    try {
      return ALL_TOOLS.map(t => ({
        name: t.name,
        /* 描述里第一句话就够 UI 展示了; 完整描述是给模型看的, 很长。 */
        description: String(t.description || '').split(/[。.\n]/)[0].trim().slice(0, 120),
      })).sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      console.error('[modelProfile] list-tools failed:', err);
      return [];
    }
  });

  ipcMain.handle('model-profile:get-current', async () => {
    try {
      const config = loadConfig();
      const defaultProvider = config.defaultProviderId ? config.providers?.[config.defaultProviderId] : undefined;
      if (!defaultProvider) return null;

      const model = defaultProvider.lastSelectedModel || defaultProvider.models?.[0]?.name || '';
      const profile = resolveBuiltinModelProfile({
        protocol: defaultProvider.protocol || 'anthropic',
        model,
        baseUrl: defaultProvider.baseUrl || '',
      });
      const override = resolveToolsetOverride(config, model, profile.id);
      const effectiveDisabledTools = override.modelDisabledTools
        ?? override.profileDisabledTools
        ?? profile.toolset?.disabledTools
        ?? [];

      return {
        profileId: profile.id,
        model,
        providerId: config.defaultProviderId,
        protocol: defaultProvider.protocol || 'anthropic',
        sourceProfileIds: profile.sourceProfileIds || [],
        prompt: profile.prompt ?? null,
        completion: profile.completion ?? null,
        transport: profile.transport ?? null,
        behavior: profile.behavior ?? null,
        toolset: {
          ...(profile.toolset ?? {}),
          disabledTools: effectiveDisabledTools,
        },
        builtinDisabledTools: profile.toolset?.disabledTools ?? [],
        modelOverrideDisabledTools: override.modelDisabledTools,
        profileOverrideDisabledTools: override.profileDisabledTools,
        reasoning: profile.reasoning ?? null,
        are: profile.are ?? null,
      };
    } catch (e) {
      console.error('Failed to resolve model profile:', e);
      return null;
    }
  });

  ipcMain.handle('model-profile:get-all', async () => {
    try {
      const config = loadConfig();
      const results: any[] = [];
      if (!config.providers) return results;

      for (const [providerId, provider] of Object.entries(config.providers)) {
        const models = provider.models ?? [];
        for (const m of models) {
          try {
            const profile = resolveBuiltinModelProfile({
              protocol: provider.protocol || 'anthropic',
              model: m.name,
              baseUrl: provider.baseUrl || '',
            });
            const override = resolveToolsetOverride(config, m.name, profile.id);
            const disabledTools = override.modelDisabledTools
              ?? override.profileDisabledTools
              ?? profile.toolset?.disabledTools
              ?? [];
            results.push({
              providerId,
              providerName: provider.name || providerId,
              model: m.name,
              profileId: profile.id,
              isDefault: config.defaultProviderId === providerId && provider.lastSelectedModel === m.name,
              sourceProfileIds: profile.sourceProfileIds || [],
              disabledTools,
              builtinDisabledTools: profile.toolset?.disabledTools ?? [],
              modelOverrideDisabledTools: override.modelDisabledTools,
              profileOverrideDisabledTools: override.profileDisabledTools,
              maxTokens: provider.maxTokens,
            });
          } catch {
            // skip models that fail profile resolution
          }
        }
      }
      return results;
    } catch (e) {
      console.error('Failed to get all model profiles:', e);
      return [];
    }
  });

  ipcMain.handle('model-profile:get-task-agent-map', async () => {
    try {
      return { success: true, map: loadConfig().taskAgentByModel || {} };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('model-profile:set-task-agent-for-model', async (_event, params?: {
    mainModel?: string; providerId?: string; model?: string;
  }) => {
    try {
      const key = normalizeModelKey(params?.mainModel || '');
      if (!key) return { success: false, error: 'mainModel is required' };
      const config = loadConfig();
      if (!config.taskAgentByModel) config.taskAgentByModel = {};
      /* 不传 providerId/model = 这个主模型改回"自动" → 删掉映射, 别留空壳 */
      if (!params?.providerId || !params?.model) delete config.taskAgentByModel[key];
      else config.taskAgentByModel[key] = { providerId: params.providerId, model: params.model };
      if (Object.keys(config.taskAgentByModel).length === 0) delete config.taskAgentByModel;
      saveConfig(config);
      return { success: true, map: config.taskAgentByModel || {} };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('model-profile:resolve', async (_event, params?: { model?: string; providerId?: string }) => {
    try {
      const model = (params?.model || '').trim();
      if (!model) return { success: false, error: 'model is required' };
      const config = loadConfig();
      const provider = params?.providerId ? config.providers?.[params.providerId] : undefined;
      const input = {
        protocol: provider?.protocol || 'anthropic',
        model,
        baseUrl: provider?.baseUrl || '',
      };
      const modelKey = normalizeModelKey(model);
      const overrides = (config.modelProfileOverrides || {})[modelKey] || {};
      /* effective = 含用户覆盖 (resolver 自己会读 config 合并最后一层)。
         builtin  = 把覆盖临时摘掉再解析一次, 得到"没有你的改动时是什么样"。 */
      const effective = resolveBuiltinModelProfile(input);
      let builtin = effective;
      if (Object.keys(overrides).length > 0) {
        const saved = config.modelProfileOverrides;
        try {
          (config as any).modelProfileOverrides = undefined;
          /* loadConfig 有缓存与否都不影响: resolver 读的是 kernelConfigBridge 提供的
             实时 config 对象, 这里改的就是同一个对象。 */
          builtin = resolveBuiltinModelProfile(input);
        } finally {
          (config as any).modelProfileOverrides = saved;
        }
      }
      const pick = (p: any) => ({
        prompt: p.prompt ?? null,
        completion: p.completion ?? null,
        transport: p.transport ?? null,
        behavior: p.behavior ?? null,
        reasoning: p.reasoning ?? null,
        are: p.are ?? null,
        loop: p.loop ?? null,
      });
      return {
        success: true,
        profileId: effective.id,
        sourceProfileIds: effective.sourceProfileIds || [],
        effective: pick(effective),
        builtin: pick(builtin),
        overrides,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('model-profile:set-field-override', async (_event, params?: { model?: string; path?: string; value?: unknown }) => {
    try {
      const model = (params?.model || '').trim();
      const path = (params?.path || '').trim();
      if (!model || !path) return { success: false, error: 'model and path are required' };
      if (!EDITABLE_PROFILE_PATHS.has(path)) return { success: false, error: `path not editable: ${path}` };
      const modelKey = normalizeModelKey(model);
      const config = loadConfig();
      if (!config.modelProfileOverrides) config.modelProfileOverrides = {};
      const cur = { ...(config.modelProfileOverrides[modelKey] || {}) } as Record<string, any>;
      const segs = path.split('.');
      /* value === undefined / null 表示"恢复内置默认" → 把这条路径删掉, 而不是写个 null 进去
         (写 null 会被 deepMerge 当成有效值, 反而把内置值抹成 null)。 */
      const clearing = params?.value === undefined || params?.value === null;
      let node: Record<string, any> = cur;
      for (let i = 0; i < segs.length - 1; i++) {
        const k = segs[i]!;
        if (clearing && (node[k] === undefined || node[k] === null)) { node = {}; break; }
        node[k] = { ...(node[k] || {}) };
        node = node[k];
      }
      const leaf = segs[segs.length - 1]!;
      if (clearing) delete node[leaf]; else node[leaf] = params!.value;
      /* 空对象一路收掉, 别在配置里留下 {} 垃圾 */
      const prune = (o: Record<string, any>): Record<string, any> => {
        for (const k of Object.keys(o)) {
          if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) {
            prune(o[k]);
            if (Object.keys(o[k]).length === 0) delete o[k];
          }
        }
        return o;
      };
      prune(cur);
      if (Object.keys(cur).length === 0) delete config.modelProfileOverrides[modelKey];
      else config.modelProfileOverrides[modelKey] = cur;
      if (Object.keys(config.modelProfileOverrides).length === 0) delete config.modelProfileOverrides;
      saveConfig(config);
      return { success: true, overrides: cur };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('model-profile:get-field-overrides', async (_event, params?: { model?: string }) => {
    try {
      const modelKey = normalizeModelKey(params?.model || '');
      const config = loadConfig();
      return { success: true, overrides: (config.modelProfileOverrides || {})[modelKey] || {} };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('model-profile:get-toolset-override', async (_event, params?: { model?: string; profileId?: string; builtinDisabledTools?: string[] }) => {
    try {
      const model = (params?.model || '').trim();
      if (!model) {
        return { success: false, error: 'model is required' };
      }
      const config = loadConfig();
      const override = resolveToolsetOverride(config, model, params?.profileId);
      const builtinDisabledTools = normalizeDisabledTools(params?.builtinDisabledTools ?? []);
      const effectiveDisabledTools = override.modelDisabledTools
        ?? override.profileDisabledTools
        ?? builtinDisabledTools;
      const source = override.modelDisabledTools
        ? 'model'
        : override.profileDisabledTools
          ? 'profile'
          : 'builtin';
      return {
        success: true,
        modelKey: override.modelKey,
        source,
        modelDisabledTools: override.modelDisabledTools,
        profileDisabledTools: override.profileDisabledTools,
        effectiveDisabledTools,
      };
    } catch (e) {
      console.error('Failed to get model toolset override:', e);
      return { success: false, error: String(e) };
    }
  });

  ipcMain.handle('model-profile:set-toolset-override', async (_event, params?: { model?: string; disabledTools?: string[] }) => {
    try {
      const model = (params?.model || '').trim();
      if (!model) {
        return { success: false, error: 'model is required' };
      }
      const modelKey = normalizeModelKey(model);
      if (!modelKey) {
        return { success: false, error: 'model is required' };
      }

      const config = loadConfig();
      const disabledTools = normalizeDisabledTools(params?.disabledTools ?? []);
      if (!config.toolsetOverridesByModel) {
        config.toolsetOverridesByModel = {};
      }
      config.toolsetOverridesByModel[modelKey] = disabledTools;
      saveConfig(config);

      return {
        success: true,
        modelKey,
        disabledTools,
      };
    } catch (e) {
      console.error('Failed to set model toolset override:', e);
      return { success: false, error: String(e) };
    }
  });

  ipcMain.handle('model-profile:clear-toolset-override', async (_event, params?: { model?: string }) => {
    try {
      const model = (params?.model || '').trim();
      if (!model) {
        return { success: false, error: 'model is required' };
      }
      const modelKey = normalizeModelKey(model);
      const config = loadConfig();

      if (config.toolsetOverridesByModel && hasOwn(config.toolsetOverridesByModel, modelKey)) {
        delete config.toolsetOverridesByModel[modelKey];
        if (Object.keys(config.toolsetOverridesByModel).length === 0) {
          delete config.toolsetOverridesByModel;
        }
        saveConfig(config);
      }

      return { success: true, modelKey };
    } catch (e) {
      console.error('Failed to clear model toolset override:', e);
      return { success: false, error: String(e) };
    }
  });
}
