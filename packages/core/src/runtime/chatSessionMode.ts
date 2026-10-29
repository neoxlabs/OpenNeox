import { getDatabase } from '@neoxlabs/platform/platform/database.js';

/** 手机本机会话记在 agent_mode 上的 Chat 值。 */
export const CHAT_AGENT_MODE = 'chat';

export interface ChatSessionFacts {
  /** 会话用途模式: 'chat' (本机对话) / 'work' / 'code' / 'pilot' / null (未记) */
  agentMode?: string | null;
  /** 会话记录上的聊天开关; null/undefined = 没设过 */
  chatMode?: boolean | null;
}

/** 显式聊天标记优先; 否则手机本机的 agent_mode='chat' 也算。其余一律不是 Chat。 */
export function isChatSession(facts: ChatSessionFacts): boolean {
  if (facts.chatMode === true) return true;
  return facts.agentMode === CHAT_AGENT_MODE;
}

/**
 * 运行时一轮该不该走聊天档: 客户端显式带了 chatMode 就以它为准 (用户刚在界面上切过),
 * 没带 (手机 / 旧客户端) 才回落到会话记录 sessions.chat_mode (chat:C1-01)。
 * 读库失败 (CLI / eval / 旧库没这一列) 当没设过, 不挡这一轮。
 */
export function resolveChatMode(
  request: { agentMode?: string | null; chatMode?: unknown },
  sessionId?: string | null,
): boolean {
  if (typeof request.chatMode === 'boolean') {
    return isChatSession({ agentMode: request.agentMode, chatMode: request.chatMode });
  }
  let stored: boolean | null = null;
  if (sessionId) {
    try {
      const db = getDatabase() as { getSessionChatMode?: (id: string) => boolean | null };
      stored = db.getSessionChatMode?.(sessionId) ?? null;
    } catch {
      stored = null;
    }
  }
  return isChatSession({ agentMode: request.agentMode, chatMode: stored });
}
