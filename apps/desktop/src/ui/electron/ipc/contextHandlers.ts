import { ipcMain } from './ipcMainBridged.js';
import { modelRegistry } from '@neoxlabs/platform/models/registry/index.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { loadConfig, saveConfig } from '@neoxlabs/platform/utils/config.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { makeOptionalBridgeResolver } from './scopeResolvers.js';

interface RegisterContextIpcHandlersOptions {
  projectManager: ProjectManager;
  sessionsCache: Map<string, any>;
}

export function registerContextIpcHandlers(options: RegisterContextIpcHandlersOptions): void {
  const { projectManager, sessionsCache } = options;
  const bridgeOf = makeOptionalBridgeResolver(projectManager);

  ipcMain.handle('context:get-usage', async (event, rawSessionId: string) => {
    const bridge = bridgeOf(event);
    if (!bridge) return null;
    try {
      const db = getDatabase();
      const getMergedSession = (sid: string): any | null => {
        const cached = sessionsCache.get(sid);
        const persisted = db.getSession(sid);
        if (cached && persisted) {
          // 智能合并：persisted 为 null/undefined/0 时保留 cached 的有效值
          const merged = { ...cached };
          for (const [key, val] of Object.entries(persisted)) {
            if (val !== null && val !== undefined) {
              (merged as any)[key] = val;
            }
          }
          return merged;
        }
        return cached || persisted || null;
      };
      const getSessionPersistedTokens = (session: any): number => {
        const latestUsage = session?.latestRequestUsage;
        const latestUsageTokens = latestUsage?.totalTokens || latestUsage?.breakdown?.totalTokens || 0;
        return session?.contextUsed || latestUsageTokens || session?.totalTokens || 0;
      };
      const resolveRegistryMaxTokens = (modelId?: string): number | undefined => {
        if (!modelId) return undefined;
        const direct = modelRegistry.getModel(modelId)?.maxInputTokens;
        if (direct && direct > 0) return direct;
        const splitIdx = modelId.indexOf(':');
        if (splitIdx > 0 && splitIdx < modelId.length - 1) {
          const normalizedModel = modelId.slice(splitIdx + 1);
          const normalized = modelRegistry.getModel(normalizedModel)?.maxInputTokens;
          if (normalized && normalized > 0) return normalized;
        }
        return undefined;
      };

      // ── 1. 解析 session ID ──
      let sessionId = rawSessionId;
      if (!sessionId || sessionId === 'current') {
        sessionId = bridge.getCurrentSessionId() || '';
      }

      // ── 2. 读取会话数据：只读这一个会话 ──
      const session = sessionId ? getMergedSession(sessionId) : null;
      if (!session) return null;

      // 从 bridge 缓存的 memory snapshot 获取实时 contextWindow（最可靠）
      const memSnap = bridge.getLastMemorySnapshot(sessionId);
      const registryMaxTokens = resolveRegistryMaxTokens(session.modelId);
      const persistedMaxTokens = typeof session.contextWindow === 'number' && session.contextWindow > 0
        ? session.contextWindow
        : undefined;
      const latestRequestUsage = session.latestRequestUsage || null;
      const persistedTokens = getSessionPersistedTokens(session);
      const currentTokens = memSnap?.tokensUsed && memSnap.tokensUsed > 0
        ? memSnap.tokensUsed
        : persistedTokens;
      // 取所有来源中最大的 contextWindow — 避免旧 modelId / 空 DB 导致降级到 128k
      const maxTokens = Math.max(
        memSnap?.contextWindow || 0,
        persistedMaxTokens || 0,
        registryMaxTokens || 0,
      ) || 128000;
      const messageCount = db.getMessageCount(sessionId);
      /* 累积用量双源: sessions.session_usage(forwarder 快照, NeoxCloud 唯一来源, 含 breakdown)
       * vs token_usage SUM(BYOK 历史)。取 requests 更多的一边 — 快照做过 DB 种子, 正常应 ≥。 */
      const tokenSummary = db.getSessionTokenUsageSummary(sessionId);
      const persistedSessionUsage = session.sessionUsage || null;
      const sessionCacheResolved = (persistedSessionUsage
        && persistedSessionUsage.requests >= (tokenSummary?.requests || 0))
        ? persistedSessionUsage
        : tokenSummary;

      // ── 3. breakdown → byRole（优先 memory snapshot，fallback DB） ──
      const bd = memSnap?.breakdown || session.contextBreakdown || latestRequestUsage?.breakdown || {};
      const details = bd.details || {};

      const byRole: Record<string, { count: number; tokens: number }> = {};
      if (bd.systemTokens)  byRole.system    = { count: 1, tokens: bd.systemTokens };
      if (bd.messageTokens) byRole.user      = { count: 0, tokens: bd.messageTokens };
      if (bd.toolTokens)    byRole.tool      = { count: 0, tokens: bd.toolTokens };
      // 如果有 details，拆出 assistant
      if (details.assistantTextTokens) {
        byRole.assistant = { count: 0, tokens: details.assistantTextTokens };
        // user 只算 userText（去掉 assistant 部分）
        if (details.userTextTokens !== undefined) {
          byRole.user = { count: 0, tokens: details.userTextTokens };
        }
      }

      return {
        currentTokens,
        maxTokens,
        usagePercent: maxTokens > 0 ? Math.round((currentTokens / maxTokens) * 100) : 0,
        messageCount,
        toolMessageCount: 0,
        toolResultRatio: 0,
        warnings: [],
        byType: {},
        byRole,
        breakdown: bd,
        sessionCache: sessionCacheResolved,
        latestRequestUsage,
      };
    } catch (error: any) {
      console.error('[context:get-usage] Error:', error.message);
      return null;
    }
  });

  ipcMain.handle('context:get-config', async () => {
    try {
      const config = loadConfig();
      return {
        compressionMode: config.context?.compressionMode ?? 'sync',
        thresholdPercent: config.context?.thresholdPercent ?? 85,
        profile: config.context?.profile ?? 'full',
      };
    } catch {
      return { compressionMode: 'sync', thresholdPercent: 85, profile: 'full' };
    }
  });

  ipcMain.handle('context:set-config', async (event, updates: {
    compressionMode?: 'sync' | 'async';
    thresholdPercent?: number;
    /** 标准 / 极简模式。runtime 每轮开头读盘 (agenticRuntime → isLeanContext), 下一句就生效, 不用推 */
    profile?: 'full' | 'lean';
  }) => {
    try {
      const config = loadConfig();
      const context = { ...(config.context ?? {}) };
      if (updates.compressionMode !== undefined) context.compressionMode = updates.compressionMode;
      if (updates.thresholdPercent !== undefined) context.thresholdPercent = updates.thresholdPercent;
      if (updates.profile === 'full' || updates.profile === 'lean') context.profile = updates.profile;
      saveConfig({ ...config, context });

      /* P1-21: silent catch 改透传 runtimeWarning, 跟 P0-5 TTS/MCP 同款套路.
       *  config 落盘成功 → success: true, runtime push 失败时 warning 让 UI 提示重启. */
      let runtimeWarning: string | undefined;
      if (updates.compressionMode !== undefined || updates.thresholdPercent !== undefined) {
        const bridge = bridgeOf(event);
        if (bridge) {
          const sessionId = bridge.getCurrentSessionId() || 'cli';
          const client = await bridge.getClientAsync();
          if (client) {
            const next: { mode?: 'sync' | 'async'; threshold?: number; autoEnabled?: boolean } = {};
            if (updates.compressionMode !== undefined) next.mode = updates.compressionMode;
            if (updates.thresholdPercent !== undefined) {
              const pct = updates.thresholdPercent;
              next.autoEnabled = pct < 100;
              next.threshold = pct < 100 ? pct / 100 : undefined;
            }
            runtimeWarning = await (client as any).setContextCompression?.(sessionId, next)
              ?.then(() => undefined)
              ?.catch((err: unknown) => err instanceof Error ? err.message : String(err));
          }
        }
      }
      return { success: true, ...(runtimeWarning ? { runtimeWarning } : {}) };
    } catch (error: any) {
      console.error('[context:set-config] Error:', error.message);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('context:trigger-compaction', async (event, sessionId: string) => {
    try {
      const bridge = bridgeOf(event);
      if (!bridge) return { success: false, error: 'No active project' };
      const resolvedSessionId = (sessionId === 'current' || !sessionId)
        ? bridge.getCurrentSessionId()
        : sessionId;
      if (!resolvedSessionId) return { success: false, error: 'No active session' };
      await bridge.compactSession(resolvedSessionId);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });
}
