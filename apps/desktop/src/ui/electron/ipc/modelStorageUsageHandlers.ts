import { ipcMain } from './ipcMainBridged.js';
/* ipcMain 走桥的替身 (electron 不能顶层静态 import, 见 lazyElectron.ts); 打开 / 定位统一走 openPathFallback。 */
import { configService } from '@neoxlabs/platform/platform/configService.js';
import { storageInfoService } from '../../../platform-electron/storageService.js';
import { tokenUsageService } from '@neoxlabs/platform/platform/tokenUsageService.js';
import { getSchemaRegistry, type EffortLevel } from '@neoxlabs/kernel/schemas/index.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { resolveSchemaModel, sortEffortLevels } from './schemaModelId';
import { openSafeExternalFromIpc } from './safeExternalOpen.js';
import { revealPathWithFallback } from './openPathFallback.js';

interface RegisterModelStorageUsageIpcHandlersOptions {
  projectManager: ProjectManager;
}

export function registerModelStorageUsageIpcHandlers(options: RegisterModelStorageUsageIpcHandlersOptions): void {
  ipcMain.handle('model:set-selected', (_event, providerId: string, modelName: string) => {
    return configService.setSelectedModel(providerId, modelName);
  });

  ipcMain.handle('model:get-available', () => {
    return configService.getAvailableModels();
  });

  const FAMILY_SAFE_LEVELS = ['off', 'low', 'medium', 'high'] as const;

  function familyFallbackInfo(registry: ReturnType<typeof getSchemaRegistry>, modelId: string) {
    try {
      const bare = modelId.includes(':') ? modelId.slice(modelId.indexOf(':') + 1) : modelId;
      const family = registry.detectFamily({ model: bare }) ?? registry.detectFamily({ model: modelId });
      const re = family?.capabilities?.reasoning_effort as
        | { supported?: boolean; values?: string[]; default?: string }
        | undefined;
      if (!family) return null;

      const nativeThinking = !!(family.capabilities?.thinking as { native?: boolean } | undefined)?.native;
      let levels: EffortLevel[];
      let def: EffortLevel;
      const declared = new Set((re?.values ?? []).map((v) => String(v)));
      const graded = re?.supported
        ? (FAMILY_SAFE_LEVELS.filter((l) => l !== 'off' && declared.has(l)) as EffortLevel[])
        : [];
      if (graded.length > 0) {
        levels = ['off' as EffortLevel, ...graded];
        def = re?.default && levels.includes(re.default as EffortLevel)
          ? (re.default as EffortLevel)
          : (levels.includes('medium' as EffortLevel) ? ('medium' as EffortLevel) : graded[graded.length - 1]);
      } else if (nativeThinking) {
        /* 走到这里的两种情况都退成开关:
         *   · 这一家明确不支持分档 (claude/gemini/glm/kimi/qwen/豆包);
         *   · 支持分档但 family yaml **没写 values** (deepseek 就是这样, 它的档位
         *     写在各 model yaml 里)。不知道有哪些档时给开关是安全的, 编三档不是
         *     —— deepseek 实际是 low|high|max, 给 medium 会被上游拒。 */
        /* 开关型: off/on 两档。不编 low/high —— 这一家的 yaml 明确说了不支持分档,
         * 硬给三档就是让用户点一个上游会拒收的值。 */
        levels = ['off', 'on'] as EffortLevel[];
        def = 'on' as EffortLevel;
      } else {
        return null;
      }
      return {
        id: bare,
        family: family.id,
        source: 'family' as const,
        /* yaml 里没有 effort_map —— 这个字段就是这个意思, 不能为了点亮 UI 而撒谎 */
        hasEffortMap: false,
        effectiveLevels: levels,
        defaultEffortLevel: def,
        billingMultipliers: {},
        capabilities: {
          promptCacheSupported: !!family.capabilities?.prompt_cache,
          thinkingSupported: true,
          reasoningEffortSupported: !!re?.supported,
        },
      };
    } catch {
      return null;
    }
  }

  ipcMain.handle('schema:model-info', (_event, modelId: string) => {
    try {
      const registry = getSchemaRegistry();
      const model = resolveSchemaModel(modelId, (id) => registry.resolveModel(id));
      if (!model) return familyFallbackInfo(registry, modelId);
      const LEVELS: EffortLevel[] = sortEffortLevels(Object.keys(model.effort_map ?? {})) as EffortLevel[];
      const META = new Set(['billing_multiplier', 'upstream_slug_override']);
      const multipliers: Partial<Record<EffortLevel, number>> = {};
      const effectiveLevels: EffortLevel[] = [];
      for (const lvl of LEVELS) {
        const entry = model.effort_map?.[lvl];
        if (entry && typeof entry.billing_multiplier === 'number') {
          multipliers[lvl] = entry.billing_multiplier;
        }
        if (!entry) continue;
        const hasPayloadField = Object.keys(entry).some((k) => !META.has(k));
        const hasSlugOverride =
          !!entry.upstream_slug_override && Object.keys(entry.upstream_slug_override).length > 0;
        if (hasPayloadField || hasSlugOverride) {
          effectiveLevels.push(lvl);
        }
      }
      const meaningful = effectiveLevels.length > 0;
      const thinkingDefault = (model.capabilities?.thinking as any)?.default_level;
      const capabilityDefault = model.capabilities?.reasoning_effort?.default;
      const nonOffEffective = effectiveLevels.filter((l) => l !== 'off' && l !== 'fast');
      const defaultEffortLevel =
        (thinkingDefault && LEVELS.includes(thinkingDefault) && thinkingDefault)
        || (capabilityDefault && LEVELS.includes(capabilityDefault) && capabilityDefault)
        || (LEVELS.includes('standard') && 'standard')
        || (LEVELS.includes('medium') && 'medium')
        || (LEVELS.includes('on') && 'on')
        || (LEVELS.includes('high') && 'high')
        || nonOffEffective[0]
        || effectiveLevels[0];
      return {
        id: model.id,
        family: model.family,
        /* 'model' = 这个模型自己的 yaml 说的; 'family' = 按家族推断 (见 familyFallbackInfo) */
        source: 'model' as const,
        hasEffortMap: meaningful,
        effectiveLevels,
        defaultEffortLevel,
        billingMultipliers: multipliers,
        capabilities: {
          promptCacheSupported: !!model.capabilities?.prompt_cache?.supported,
          thinkingSupported: !!model.capabilities?.thinking?.supported,
          reasoningEffortSupported: !!model.capabilities?.reasoning_effort?.supported,
        },
      };
    } catch {
      return null;
    }
  });

  ipcMain.handle('config:get-path', () => {
    return configService.getConfigPath();
  });

  ipcMain.handle('storage:get-info', async () => {
    return storageInfoService.getStorageInfo();
  });

  ipcMain.handle('storage:read-file', async (_event, filePath: string) => {
    return storageInfoService.readConfigFile(filePath);
  });

  ipcMain.handle('storage:list-dir', async (_event, dirPath: string) => {
    return storageInfoService.listConfigDir(dirPath);
  });

  ipcMain.handle('storage:open-in-finder', async (_event, filePath: string) => {
    await revealPathWithFallback(filePath);
  });

  ipcMain.handle('external:open', async (event, url: string) => {
    await openSafeExternalFromIpc(options.projectManager, event, url);
  });

  ipcMain.handle('storage:clear-checkpoint', async (_event, workspacePath: string) => {
    return storageInfoService.clearCheckpointStorage(workspacePath);
  });

  ipcMain.handle('storage:clear-all-checkpoints', async () => {
    return storageInfoService.clearAllCheckpointStorage();
  });

  ipcMain.handle('storage:clear-stale-db-backups', async () => {
    return storageInfoService.cleanupStaleDbBackups();
  });

  ipcMain.handle('storage:clear-stale-cli-binaries', async () => {
    return storageInfoService.cleanupStaleCliBinaries();
  });

  ipcMain.handle('storage:clear-orphan-semantic', async () => {
    return storageInfoService.cleanupOrphanSemanticIndexes();
  });

  ipcMain.handle('usage:get-summary', async () => {
    return tokenUsageService.getSummary();
  });

  ipcMain.handle('usage:get-daily', async (_event, days?: number) => {
    return tokenUsageService.getDaily(typeof days === 'number' ? days : 30);
  });

  /* 历史消息 footer 的回填源 —— 按会话取每轮的用量+模型, 渲染端按时间戳跟消息配对 */
  ipcMain.handle('usage:get-session-turns', async (_event, sessionId: string) => {
    if (!sessionId) return [];
    try {
      return await tokenUsageService.getSessionTurns(String(sessionId));
    } catch {
      return [];
    }
  });

  ipcMain.handle('usage:get-provider-stats', async () => {
    return tokenUsageService.getProviderStats();
  });

  ipcMain.handle('usage:get-provider-records', async (_event, provider: string, limit?: number) => {
    return tokenUsageService.getProviderRecords(provider, limit);
  });

  ipcMain.handle('usage:get-recent-records', async (_event, limit?: number) => {
    return tokenUsageService.getRecentRecords(limit);
  });

  ipcMain.handle('usage:clear-all', async () => {
    return tokenUsageService.clearAll();
  });

  ipcMain.handle('usage:clear-provider', async (_event, provider: string) => {
    return tokenUsageService.clearProvider(provider);
  });
}
