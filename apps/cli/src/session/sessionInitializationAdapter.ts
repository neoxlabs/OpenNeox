import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { resolveStartupSession } from './startupSessionResolver.js';
import { getGlobalCostTracker } from '@neoxlabs/platform/platform/costTracker.js';
import { NeoxDatabase } from '@neoxlabs/platform/platform/database.js';
import { SessionContext } from '@neoxlabs/platform/platform/sessionContext.js';
import { isCompactionSummaryMessage } from '@neoxlabs/kernel/utils/compression/llmSummarizer.js';
import type { Session } from '@neoxlabs/kernel/types/session.js';
import type { CLIArgs } from '../args.js';

/** Minimal shape expected from the SDK client for session initialization */
interface SessionSdkClient {
  createCheckpoint(sessionId: string, label: string): Promise<unknown>;
  getSessionInfo(sessionId: string): Promise<{ messageCount?: number; messages?: any[] } | null>;
  announceSession?(sessionId: string, info: { providerId?: string; modelName?: string; workspacePath?: string }): Promise<void>;
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
/** 会话最后用的对话模型 (runtime 每次 chat 写 sessions.chat_model); 没记过 / 读不到 → null */
export function readSessionChatModel(sessionId: string): { providerId: string; model: string } | null {
  try {
    return new NeoxDatabase().getSessionChatModel(sessionId);
  } catch (err: unknown) {
    cliLogger.debug('SESSION', `read chat_model failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function readSessionContextUsed(sessionId: string): {
  contextUsed: number;
  breakdown?: unknown;
  latestRequestUsage?: {
    billableInputTokens?: number; outputTokens?: number;
    cacheReadTokens?: number; cacheWriteTokens?: number; breakdown?: unknown;
  } | null;
} | null {
  try {
    const s = new NeoxDatabase().getSession(sessionId);
    const contextUsed = Number(s?.contextUsed) || 0;
    if (!contextUsed) return null;
    return { contextUsed, breakdown: s?.contextBreakdown, latestRequestUsage: s?.latestRequestUsage ?? null };
  } catch {
    return null;
  }
}

export function buildHistoryRecap(
  sessionId: string,
  opts: { turns?: number; width?: number } = {},
): Array<{ role: string; text: string }> {
  const turns = opts.turns ?? 3;
  const width = opts.width ?? 76;

  const db = new NeoxDatabase();
  /* 多取一些再筛 —— 中间夹着 tool/reasoning 之类的条目。
   * 排除压缩快照行 (LLM 投影专用的整段上下文副本, 单行可达几十 MB)。 */
  const rows = db.getMessages(sessionId, turns * 12, { excludeItemTypes: ['compaction_snapshot'] });

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

/**
 * 恢复会话时模型实际会拿到的那份历史 —— 跟服务端 SessionSyncManager.loadHistory 同一个来源和筛法:
 * SessionContext (messages 表单源, 压缩过的会话从最新快照起读), 普通 system 跳过 (每轮重新注入),
 * 压缩摘要保留 (原文已压掉, 摘要就是那段历史)。只用来估表盘, 不写任何东西。
 */
export function loadHistoryForEstimate(sessionId: string): Array<{ role: string; content: unknown }> {
  const out: Array<{ role: string; content: unknown }> = [];
  for (const item of SessionContext.get(sessionId).getAll()) {
    if (item.role === 'system' && !isCompactionSummaryMessage(item)) continue;
    out.push(item.raw && typeof item.raw === 'object'
      ? { ...item.raw, role: item.role, content: item.raw.content ?? item.content }
      : { role: item.role, content: item.content });
  }
  return out;
}

export function buildHistoryReplay(sessionId: string, turns = 3): Array<{ user: string; assistant: string }> {
  const db = new NeoxDatabase();
  const rows = db.getMessages(sessionId, 400, { excludeItemTypes: ['compaction_snapshot'] });
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

export type TimelineReplayItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'target'; header: string; count: number }
  | { kind: 'tool'; id: string; name: string; args: Record<string, unknown>; result?: string; isError?: boolean };

const TARGET_CONTINUATION = /^\[Target · [^\]]*\]/;

export function buildTimelineReplay(sessionId: string, maxItems = 16): TimelineReplayItem[] {
  const db = new NeoxDatabase();
  const rows = db.getMessages(sessionId, 600, { excludeItemTypes: ['compaction_snapshot'] });
  const items: TimelineReplayItem[] = [];
  const toolById = new Map<string, Extract<TimelineReplayItem, { kind: 'tool' }>>();
  for (const row of rows) {
    if (row.itemType !== 'message') continue;
    const data = row.itemData as {
      role?: string; content?: unknown; tool_call_id?: string;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    } | null;
    if (!data) continue;
    if (data.role === 'tool') {
      const t = data.tool_call_id ? toolById.get(data.tool_call_id) : undefined;
      if (t) {
        let out = extractText(data.content);
        let isError = /^(error|错误)[:：]/i.test(out.trim());
        /* edit / write_file 等回的是 {"status","summary",...} 信封, 卡片只要 summary */
        if (out.trimStart().startsWith('{')) {
          try {
            const env = JSON.parse(out);
            if (typeof env?.summary === 'string') out = env.summary;
            if (env?.status === 'error' || env?.success === false) isError = true;
          } catch { /* 不是信封, 原样 */ }
        }
        t.result = out;
        t.isError = isError;
      }
      continue;
    }
    let text = extractText(data.content).trim();
    if (data.role === 'user') {
      if (!text || text.startsWith('<')) continue;
      const m = TARGET_CONTINUATION.exec(text);
      if (m) {
        const last = items[items.length - 1];
        if (last?.kind === 'target') { last.header = m[0]; last.count++; }
        else items.push({ kind: 'target', header: m[0], count: 1 });
        continue;
      }
      text = text.replace(/(\s*<([a-z][a-z0-9-]*)>[\s\S]*?<\/\2>)+\s*$/, '').trim();
      const last = items[items.length - 1];
      if (last?.kind === 'user' && last.text === text) continue;
      items.push({ kind: 'user', text });
    } else if (data.role === 'assistant') {
      if (text) items.push({ kind: 'assistant', text });
      for (const tc of data.tool_calls ?? []) {
        const name = tc.function?.name;
        if (!tc.id || !name) continue;
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* 半截参数 */ }
        const item = { kind: 'tool' as const, id: tc.id, name, args };
        toolById.set(tc.id, item);
        items.push(item);
      }
    }
  }
  const tail = items.slice(-maxItems);
  if (!tail.some((i) => i.kind === 'user')) {
    const lastUser = [...items].reverse().find((i) => i.kind === 'user');
    if (lastUser) tail.unshift(lastUser);
  }
  return tail;
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
  /** 载入的消息 (服务端 getSessionInfo 带回来的) —— 恢复后立刻估一份上下文给表盘, 不等第一条消息 */
  onHistoryLoaded?: (messages: any[]) => void;
  /** 当前用的模型 —— 一打开就登记到本机会话列表, 别的会话发来消息时用它起一轮 (还没说过话也叫得醒) */
  announce?: { providerId?: string; modelName?: string };
}): Promise<number> {
  params.setCurrentSession(params.session);
  if (params.session?.sessionId && params.sdkClient?.announceSession) {
    void params.sdkClient.announceSession(params.session.sessionId, { ...params.announce, workspacePath: process.cwd() })
      .catch(() => { /* 只影响本机会话列表 */ });
  }

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

  if (params.options?.loadHistory !== false && params.session?.sessionId && params.onHistoryLoaded) {
    try {
      const history = loadHistoryForEstimate(params.session.sessionId);
      if (history.length > 0) params.onHistoryLoaded(history);
    } catch (err: unknown) {
      cliLogger.debug('SESSION', `resume context estimate skipped: ${err instanceof Error ? err.message : String(err)}`);
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
