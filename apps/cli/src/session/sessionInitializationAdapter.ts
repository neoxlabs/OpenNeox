import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { resolveStartupSession } from './startupSessionResolver.js';
import { getGlobalCostTracker } from '@neoxlabs/platform/platform/costTracker.js';
import { NeoxDatabase } from '@neoxlabs/platform/platform/database.js';
import type { Session } from '@neoxlabs/kernel/types/session.js';
import type { CLIArgs } from '../args.js';

/** Minimal shape expected from the SDK client for session initialization */
interface SessionSdkClient {
  createCheckpoint(sessionId: string, label: string): Promise<unknown>;
  getSessionInfo(sessionId: string): Promise<{ messageCount?: number } | null>;
}

/** Minimal session-manager surface used during initialization */
interface SessionManagerLike {
  getMostRecent(): Promise<Session | null>;
  getSession(id: string): Promise<Session | null>;
  createSession(options: { model: string }): Promise<Session>;
  listSessions?(): Promise<Array<{ sessionId: string; itemCount?: number }>>;
}

/** User config subset relevant to session init */
interface SessionUserConfig {
  experimental?: { enableCheckpoint?: boolean };
}

/** 从消息体里抠出可读文本 —— content 可能是字符串, 也可能是 block 数组 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
        ? (b as { text: string }).text
        : ''))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

/**
 * 恢复会话时的"接上文"回顾 —— 最近几轮各一行。
 *
 * 只读本地库 (messages 表, item_type='message', item_data={role,content}),
 * 不依赖服务端计数; 取不到就返回空数组, 绝不阻塞启动。
 */
export function buildHistoryRecap(
  sessionId: string,
  opts: { turns?: number; width?: number } = {},
): Array<{ role: string; text: string }> {
  const turns = opts.turns ?? 3;
  const width = opts.width ?? 76;

  const db = new NeoxDatabase();
  /* 多取一些再筛 —— 中间夹着 tool/reasoning 之类的条目 */
  const rows = db.getMessages(sessionId, turns * 12);

  const out: Array<{ role: string; text: string }> = [];
  for (const row of rows) {
    if (row.itemType !== 'message') continue;
    const data = row.itemData as { role?: string; content?: unknown } | null;
    const role = data?.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const text = extractText(data?.content).replace(/\s+/g, ' ').trim();
    if (!text) continue;

    out.push({ role, text: text.length > width ? `${text.slice(0, width - 1)}…` : text });
  }

  /* 只留最后 turns*2 条 (约 turns 个来回) */
  return out.slice(-turns * 2);
}

export function buildHistoryReplay(sessionId: string, turns = 3): Array<{ user: string; assistant: string }> {
  const db = new NeoxDatabase();
  const rows = db.getMessages(sessionId, 400);
  const out: Array<{ user: string; assistant: string }> = [];
  for (const row of rows) {
    if (row.itemType !== 'message') continue;
    const data = row.itemData as { role?: string; content?: unknown } | null;
    let text = extractText(data?.content).trim();
    if (!text) continue;
    if (data?.role === 'user') {
      if (text.startsWith('<')) continue;
      /* 发给模型的那份用户消息后面挂着注入块 (<reply-language> / <current-time> …), 库里原文和注入版各一条 */
      text = text.replace(/(\s*<([a-z][a-z0-9-]*)>[\s\S]*?<\/\2>)+\s*$/, '').trim();
      const last = out[out.length - 1];
      if (last && last.user === text && !last.assistant) continue;
      out.push({ user: text, assistant: '' });
    } else if (data?.role === 'assistant' && out.length > 0) {
      out[out.length - 1]!.assistant = text;
    }
  }
  return out.slice(-turns);
}

export async function initializeSessionFromMain(params: {
  sessionEnabled: boolean;
  cliArgs: CLIArgs;
  sessionManager: SessionManagerLike;
  model: string;
  showSessionSelector: () => Promise<Session | null>;
  activateSession: (session: Session, options?: { loadHistory?: boolean }) => Promise<number>;
  sdkClient: SessionSdkClient | null;
  userConfig: SessionUserConfig | null;
  printLoadedHistory: (loaded: number) => void;
  printHistoryRecap: (turns: Array<{ role: string; text: string }>) => void;
  printSessionInitFailed: (message: string) => boolean | Promise<boolean>;
  disableSession: () => void;
}): Promise<void> {
  if (!params.sessionEnabled) {
    return;
  }

  const initializeOnce = async (): Promise<number> => {
    const { session, loadHistory } = await resolveStartupSession({
      cliArgs: params.cliArgs,
      sessionManager: params.sessionManager,
      model: params.model,
      showSessionSelector: () => params.showSessionSelector(),
    });

    const loaded = await params.activateSession(session, {
      loadHistory,
    });

    if (loadHistory && session?.sessionId) {
      try {
        const recap = buildHistoryRecap(session.sessionId);
        if (recap.length > 0) params.printHistoryRecap(recap);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        cliLogger.warn('SESSION', `History recap failed: ${msg}`);
      }
    }

    if (loaded > 0) {
      params.printLoadedHistory(loaded);
    } else if (params.sdkClient && params.userConfig?.experimental?.enableCheckpoint) {
      // 后台创建 checkpoint，仅在用户开启 enableCheckpoint 时执行
      params.sdkClient.createCheckpoint(session?.sessionId ?? 'cli', 'session_start')
        .then((res: unknown) => {
          const id = typeof res === 'string' ? res : (res as Record<string, unknown>)?.id ?? 'ok';
          cliLogger.info('CLI', `Checkpoint created: ${id}`);
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          cliLogger.warn('CLI', `Checkpoint creation failed: ${msg}`);
        });
    }

    return loaded;
  };

  try {
    await initializeOnce();
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : undefined;
    cliLogger.warn('BOOT', `initializeSession failed: ${errMsg}`, { stack: errStack });
    const recovered = await params.printSessionInitFailed(errMsg);
    if (recovered) {
      try {
        await initializeOnce();
        cliLogger.info('BOOT', 'Session initialization recovered after retry');
        return;
      } catch (retryError: unknown) {
        const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
        const retryStack = retryError instanceof Error ? retryError.stack : undefined;
        cliLogger.warn('BOOT', `initializeSession retry failed: ${retryMsg}`, { stack: retryStack });
        await params.printSessionInitFailed(retryMsg);
      }
    }
    params.disableSession();
  }
}

export async function activateSessionFromMain(params: {
  session: Session;
  options?: { loadHistory?: boolean };
  setCurrentSession: (session: Session) => void;
  sdkClient: SessionSdkClient | null;
}): Promise<number> {
  params.setCurrentSession(params.session);

  if (params.options?.loadHistory !== false && params.session?.sessionId) {
    try {
      const db = new NeoxDatabase();
      const usageByModel = db.getSessionTokenUsageByModel(params.session.sessionId);
      if (usageByModel.length > 0) {
        const costTracker = getGlobalCostTracker();
        costTracker.restoreFromRecords(usageByModel.map(r => ({
          model: r.model,
          provider: r.provider,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cachedTokens: r.cachedTokens,
          cacheCreationTokens: r.cacheWriteTokens,
          requests: r.requests,
        })));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      cliLogger.warn('SESSION', `Failed to restore cost tracker: ${msg}`);
    }
  }

  // Server manages session sync and memory — we just track the session locally
  if (params.sdkClient && params.options?.loadHistory !== false) {
    try {
      const info = await params.sdkClient.getSessionInfo(params.session.sessionId);
      return info?.messageCount ?? 0;
    } catch {
      return 0;
    }
  }
  return 0;
}
