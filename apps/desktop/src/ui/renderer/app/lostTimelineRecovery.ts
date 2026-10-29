import type { TimelineEntry } from '../utils/workspaceUtils';
import { getGlobalLanguage } from '../hooks/useI18n';

/**
 * 冷打开后真源是空的才动手: 再向主进程要一次消息原文, 有正文就重建并落盘。
 * 调用方只在"不是子会话、没在跑"时调 —— 子会话的真源是服务端 sub- 行, 在跑的会话
 * 空表只说明还没写到。
 */
export async function recoverLostTimeline(
  sessionId: string,
  loaded: TimelineEntry[],
  append: (sessionId: string, entry: TimelineEntry) => void,
  stillActive: () => boolean,
): Promise<void> {
  if (loaded.length > 0) return;
  const session = await window.neox?.getSession?.(sessionId);
  if (!stillActive()) return;
  const lang = getGlobalLanguage() === 'zh' ? 'zh' : 'en';
  for (const entry of timelineFromStoredMessages(session?.messages as StoredMessage[] | undefined, lang)) {
    append(sessionId, entry);
  }
}

type StoredMessage = {
  id?: string;
  role?: string;
  text?: string;
  timestamp?: number;
  sequence?: number;
};

/* 发送时拼进用户消息的运行时标签 —— 用户没打过这些字, 重建时去掉 */
const INJECTED_TAGS = /<(reply-language|current-time)>[\s\S]*?<\/\1>/g;

export function timelineFromStoredMessages(
  messages: StoredMessage[] | undefined,
  lang: 'zh' | 'en',
): TimelineEntry[] {
  const turns = (messages ?? []).filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string',
  );
  const out: TimelineEntry[] = [];
  for (const [index, m] of turns.entries()) {
    const text = m.role === 'user' ? m.text!.replace(INJECTED_TAGS, '').trim() : m.text!.trim();
    if (!text) continue;
    const key = m.id || `idx-${index}`;
    out.push({
      id: `recovered-${key}`,
      type: m.role === 'user' ? 'user_message' : 'assistant_message',
      title: m.role === 'user' ? 'User' : 'Assistant',
      detail: text,
      timestamp: m.timestamp ?? 0,
      sequence: typeof m.sequence === 'number' ? m.sequence * 2 + 2 : index * 2 + 2,
      pending: false,
      messageId: m.id,
    } as TimelineEntry);
  }
  if (out.length === 0) return out;
  const first = out[0]!;
  out.unshift({
    id: 'recovered-notice',
    type: 'log',
    level: 'warning',
    title: lang === 'zh' ? '步骤记录已丢失' : 'Step history lost',
    detail: lang === 'zh'
      ? '这个会话的工具调用和中间步骤没有保存下来, 下面只有对话原文。'
      : 'Tool calls and intermediate steps of this session were not kept; only the conversation text is shown.',
    timestamp: first.timestamp,
    sequence: 1,
    pending: false,
  } as TimelineEntry);
  return out;
}
