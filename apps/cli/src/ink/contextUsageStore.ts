import { useEffect, useState } from 'react';

export interface ContextCategories {
  systemPrompt: number;
  toolDefinitions: number;
  user: number;
  assistant: number;
  toolCalls: number;
  toolResults: number;
}

export interface ContextUsage {
  /** 本轮请求的上下文总量 (= 非缓存输入 + 缓存读 + 缓存写) */
  contextTokens: number;
  categories?: ContextCategories;
  /** 本轮: 非缓存输入 / 缓存命中 / 写入缓存 / 输出 */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

let current: ContextUsage | null = null;
const listeners = new Set<(u: ContextUsage | null) => void>();

function publish(u: ContextUsage | null): void {
  current = u;
  for (const fn of listeners) {
    try { fn(u); } catch { /* */ }
  }
}

/** token_usage 事件 (主 agent) → 存一份。breakdown 是 kernel ContextTokenBreakdown (已归一化) */
export function recordContextUsage(event: {
  contextTokens?: number; promptTokens?: number; completionTokens?: number;
  cacheReadTokens?: number; cacheWriteTokens?: number;
  breakdown?: { details?: Record<string, number> };
}): void {
  const d = event.breakdown?.details;
  const categories: ContextCategories | undefined = d
    ? {
      systemPrompt: (d.systemPromptTokens || 0) + (d.hiddenInstructionsTokens || 0) + (d.agentPrefixTokens || 0),
      toolDefinitions: d.toolDefinitionsTokens || 0,
      user: (d.userTextTokens || 0) + (d.attachmentTextTokens || 0) + (d.imageDescriptionTokens || 0) + (d.fileDescriptionTokens || 0),
      assistant: d.assistantTextTokens || 0,
      toolCalls: d.toolCallTokens || 0,
      toolResults: d.toolResultTokens || 0,
    }
    : undefined;
  const input = event.promptTokens || 0;
  const cacheRead = event.cacheReadTokens || 0;
  const cacheWrite = event.cacheWriteTokens || 0;
  publish({
    contextTokens: event.contextTokens || input + cacheRead + cacheWrite,
    categories,
    input, cacheRead, cacheWrite,
    output: event.completionTokens || 0,
  });
}

/** 压缩完成 / 清空 / 换会话: 旧分类作废 (总量由状态行那份 tokenStats 负责) */
export function clearContextUsage(): void {
  publish(null);
}

export function useContextUsage(): ContextUsage | null {
  const [u, setU] = useState<ContextUsage | null>(current);
  useEffect(() => {
    listeners.add(setU);
    setU(current);
    return () => { listeners.delete(setU); };
  }, []);
  return u;
}
