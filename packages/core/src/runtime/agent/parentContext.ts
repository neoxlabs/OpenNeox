/**
 * ParentContext - 对话历史提取
 *
 * 从主 agent 的 ShortTermMemory 中提取最近对话，
 * 注入到任务 Agent 的 system prompt 中，让任务 Agent 能看到对话背景。
 *
 * agentic 模式和 assistant 模式共用。
 */

import type { ShortTermMemory } from '@neoxlabs/kernel/memory/shortterm.js';

/**
 * 从主 agent 的 memory 中提取对话历史
 * 不做摘要，直接传最近的消息，控制总量在 ~3000-4000 tokens
 */
export function buildParentContext(parentMemory: ShortTermMemory): string {
  const messages = parentMemory.getAll();
  if (messages.length === 0) return '';

  const parts: string[] = [];
  let totalChars = 0;
  const MAX_CHARS = 12000; // ~3000-4000 tokens

  // 从最新往回取，保证最近的对话优先
  for (let i = messages.length - 1; i >= 0; i--) {
    if (totalChars >= MAX_CHARS) break;
    const msg = messages[i];
    // 跳过 tool result（太长且对任务 Agent 不重要）
    if (msg.role === 'tool') continue;

    const content = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content);
    const truncated = content.substring(0, 1000);
    parts.unshift(`[${msg.role}]: ${truncated}`);
    totalChars += truncated.length;
  }

  return parts.join('\n\n');
}
