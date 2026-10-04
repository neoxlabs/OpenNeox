import { colors } from '../constants.js';
import { cliPrintln } from '../utils/output.js';
import type { Session as PersistedSession } from '@neoxlabs/kernel/types/session.js';
import type { CLIArgs } from '../args.js';

interface SessionManagerLike {
  getMostRecent: () => Promise<PersistedSession | null>;
  getSession: (id: string) => Promise<PersistedSession | null>;
  createSession: (options: { model: string }) => Promise<PersistedSession>;
  listSessions?: () => Promise<Array<{ sessionId: string; itemCount?: number }>>;
}

async function mostRecentWithMessages(sm: SessionManagerLike): Promise<PersistedSession | null> {
  if (sm.listSessions) {
    try {
      /* 每个会话一建就有一条 meta 记录 —— 空会话的 itemCount 是 1, 要 >1 才算聊过 (hero 的"最近会话"同一判据) */
      const hit = (await sm.listSessions()).find(s => (s.itemCount ?? 0) > 1);
      if (hit) return await sm.getSession(hit.sessionId);
    } catch { /* 退回 getMostRecent */ }
  }
  return sm.getMostRecent();
}

interface ResolveStartupSessionOptions {
  cliArgs: CLIArgs;
  sessionManager: SessionManagerLike;
  model: string;
  showSessionSelector: () => Promise<PersistedSession | null>;
}

export async function resolveStartupSession(
  options: ResolveStartupSessionOptions,
): Promise<{ session: PersistedSession; loadHistory: boolean }> {
  const { cliArgs, sessionManager, model, showSessionSelector } = options;

  if (cliArgs.continue) {
    const existing = await mostRecentWithMessages(sessionManager);
    /* 不再在 hero 上面打 "↪ Continuing session: <内部 id>" —— 时间线里回放的
     * "之前的对话 · 最近 N 轮" 已经说明接的是哪段 (main.ts flushHistoryReplay) */
    if (existing) return { session: existing, loadHistory: true };

    const created = await sessionManager.createSession({ model });
    cliPrintln(colors.dim(`  ✦ New session: ${created.sessionId}`));
    return { session: created, loadHistory: true };
  }

  if (cliArgs.resume) {
    if (typeof cliArgs.resume === 'string') {
      const existing = await sessionManager.getSession(cliArgs.resume);
      if (existing) return { session: existing, loadHistory: true };

      cliPrintln(colors.error(`  [x] Session not found: ${cliArgs.resume}`));
      const created = await sessionManager.createSession({ model });
      return { session: created, loadHistory: true };
    }

    const selected = await showSessionSelector();
    if (selected) {
      return { session: selected, loadHistory: true };
    }

    const created = await sessionManager.createSession({ model });
    cliPrintln(colors.dim(`  ✦ New session: ${created.sessionId}`));
    return { session: created, loadHistory: true };
  }

  const created = await sessionManager.createSession({ model });
  return { session: created, loadHistory: false };
}
