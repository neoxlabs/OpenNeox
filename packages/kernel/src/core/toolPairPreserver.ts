/**
 * Preserve tool and thinking blocks when compaction removes message history.
 *
 * Compaction preserves these API invariants:
 * 1. tool_use / tool_result 配对完整 — 不拆散
 * 2. thinking blocks 同 ID 保全 — 同一 message.id 的 assistant 消息不拆散
 *
 * Violating either invariant produces an invalid provider request.
 */

import type { Message, MessageContentPart } from '../types/index.js';
import { cliLogger } from '../platform/cliLogger.js';

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从 tool 消息中提取 tool_result ID
 * - OpenAI 格式: msg.tool_call_id
 * - Anthropic 格式: content 中的 tool_result content block
 */
function getToolResultIds(msg: Message): string[] {
  const ids: string[] = [];

  // OpenAI 格式
  if (msg.role === 'tool' && (msg as any).tool_call_id) {
    ids.push((msg as any).tool_call_id);
  }

  // Anthropic 格式: content 数组中的 tool_result
  if (Array.isArray(msg.content)) {
    for (const part of msg.content as MessageContentPart[]) {
      if (part.type === 'tool_result' && 'tool_use_id' in part) {
        ids.push(part.tool_use_id);
      }
    }
  }

  return ids;
}

/**
 * 检查 assistant 消息是否包含指定 ID 的 tool_use
 */
function hasToolUseWithIds(msg: Message, toolUseIds: Set<string>): boolean {
  if (msg.role !== 'assistant') return false;

  // OpenAI 格式: tool_calls 数组
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      if (toolUseIds.has(tc.id)) return true;
    }
  }

  // Anthropic 格式: content 数组中的 tool_use
  if (Array.isArray(msg.content)) {
    for (const part of msg.content as MessageContentPart[]) {
      if (part.type === 'tool_use' && 'id' in part && toolUseIds.has(part.id)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 获取 assistant 消息中所有 tool_use ID
 */
function getToolUseIds(msg: Message): string[] {
  const ids: string[] = [];

  if (msg.role !== 'assistant') return ids;

  // OpenAI 格式
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      ids.push(tc.id);
    }
  }

  // Anthropic 格式
  if (Array.isArray(msg.content)) {
    for (const part of msg.content as MessageContentPart[]) {
      if (part.type === 'tool_use' && 'id' in part) {
        ids.push(part.id);
      }
    }
  }

  return ids;
}

/**
 * 获取消息的唯一标识（用于 thinking block 分组）
 * 某些 API（如 Anthropic）会将同一个 response 拆分为多条消息
 * （thinking block + tool_use），它们共享同一个 message ID
 */
function getMessageId(msg: Message): string | undefined {
  return (msg as any).id ?? (msg as any).message_id;
}

// ============================================================================
// 核心算法
// ============================================================================

/**
 * Widen the compaction boundary to preserve required paired blocks.
 *
 * Given a start index, walk backward so retained tool results keep their
 * tool uses and retained assistant messages keep their thinking blocks.
 *
 * @param messages 完整消息列表
 * @param startIndex 原始保留起始索引（此索引及之后的消息会被保留）
 * @returns 调整后的起始索引（可能更小，以包含必要的配对消息）
 */
export function widenKeepStartForPairedBlocks(
  messages: Message[],
  startIndex: number,
): number {
  if (startIndex <= 0) return 0;
  if (startIndex >= messages.length) return messages.length;

  let adjusted = startIndex;

  // === Step 1: Tool use / tool_result 配对保全 ===

  // 收集保留范围内所有 tool_result ID
  const keptToolResultIds = new Set<string>();
  for (let i = adjusted; i < messages.length; i++) {
    for (const id of getToolResultIds(messages[i])) {
      keptToolResultIds.add(id);
    }
  }

  // 收集保留范围内已有的 tool_use ID
  const keptToolUseIds = new Set<string>();
  for (let i = adjusted; i < messages.length; i++) {
    for (const id of getToolUseIds(messages[i])) {
      keptToolUseIds.add(id);
    }
  }

  // 找出孤儿 tool_result（在保留范围内有 result 但没有对应的 use）
  const orphanedResultIds = new Set<string>();
  keptToolResultIds.forEach(resultId => {
    if (!keptToolUseIds.has(resultId)) {
      orphanedResultIds.add(resultId);
    }
  });

  // 向前回溯找到包含这些 tool_use 的 assistant 消息
  if (orphanedResultIds.size > 0) {
    for (let i = adjusted - 1; i >= 0; i--) {
      if (hasToolUseWithIds(messages[i], orphanedResultIds)) {
        adjusted = i;
        // 移除已找到的 ID
        for (const id of getToolUseIds(messages[i])) {
          orphanedResultIds.delete(id);
        }
        if (orphanedResultIds.size === 0) break;
      }
    }

    // 如果回溯后 adjusted 变了，重新检查新加入的消息是否引入更多孤儿
    // （递归解决：新加入的 assistant 消息可能包含 tool_use，
    //  其 tool_result 在更前面，形成新的孤儿链）
    if (adjusted < startIndex) {
      // 重新收集 adjusted~startIndex 范围内的 tool_result
      const newOrphans = new Set<string>();
      for (let i = adjusted; i < startIndex; i++) {
        for (const id of getToolResultIds(messages[i])) {
          // 检查对应的 tool_use 是否在 adjusted 范围内
          let found = false;
          for (let j = adjusted; j < messages.length; j++) {
            if (hasToolUseWithIds(messages[j], new Set([id]))) {
              found = true;
              break;
            }
          }
          if (!found) newOrphans.add(id);
        }
      }

      // 如果有新孤儿，继续回溯（但只做一轮，防止无限递归）
      if (newOrphans.size > 0) {
        for (let i = adjusted - 1; i >= 0; i--) {
          if (hasToolUseWithIds(messages[i], newOrphans)) {
            adjusted = i;
            for (const id of getToolUseIds(messages[i])) {
              newOrphans.delete(id);
            }
            if (newOrphans.size === 0) break;
          }
        }
      }
    }
  }

  // === Step 2: Thinking block 同 ID 保全 ===

  // 收集保留范围内 assistant 消息的 message ID
  const keptMessageIds = new Set<string>();
  for (let i = adjusted; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      const msgId = getMessageId(msg);
      if (msgId) keptMessageIds.add(msgId);
    }
  }

  // 向前回溯找到共享同一 message ID 的 assistant 消息（thinking blocks）
  if (keptMessageIds.size > 0) {
    for (let i = adjusted - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'assistant') continue;

      const msgId = getMessageId(msg);
      if (msgId && keptMessageIds.has(msgId)) {
        adjusted = i;
      }
    }
  }

  if (adjusted < startIndex) {
    const delta = startIndex - adjusted;
    cliLogger.debug('ToolPairPreserver',
      `Adjusted compression boundary: ${startIndex} → ${adjusted} (preserved ${delta} additional messages for API invariants)`,
    );
  }

  return adjusted;
}

/**
 * 验证消息列表的 tool pair 完整性
 * 返回发现的问题列表（空 = 无问题）
 */
export function validateToolPairIntegrity(messages: Message[]): string[] {
  const issues: string[] = [];

  // 收集所有 tool_use ID 和 tool_result ID
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    for (const id of getToolUseIds(msg)) {
      toolUseIds.add(id);
    }
    for (const id of getToolResultIds(msg)) {
      toolResultIds.add(id);
    }
  }

  // 检查孤儿 tool_result
  toolResultIds.forEach(resultId => {
    if (!toolUseIds.has(resultId)) {
      issues.push(`Orphaned tool_result: ${resultId} has no matching tool_use`);
    }
  });

  // 检查孤儿 tool_use（有些 API 允许这个，但不理想）
  toolUseIds.forEach(useId => {
    if (!toolResultIds.has(useId)) {
      issues.push(`Orphaned tool_use: ${useId} has no matching tool_result`);
    }
  });

  if (issues.length > 0) {
    cliLogger.warn('ToolPairPreserver',
      `Found ${issues.length} tool pair integrity issues:\n  ${issues.join('\n  ')}`,
    );
  }

  return issues;
}
