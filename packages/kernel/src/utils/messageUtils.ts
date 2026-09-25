/**
 * Message utility functions
 */

import type { MessageContent, MessageContentPart } from '../types/index.js';

/**
 * Helper to extract text content from MessageContent (handles both string and multimodal array)
 * 注意：此函数会忽略 thinking blocks，只提取纯文本内容
 */
export function getTextFromContent(content: MessageContent): string {
  if (content === null) return '';
  if (typeof content === 'string') return content;
  // Array of content parts - extract text parts (忽略 thinking/image 等其他类型)
  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map(part => part.text)
    .join('');
}

/**
 *  NEW: 确保消息的 content 是有效的格式
 * - 如果是 string，直接返回
 * - 如果是数组，确保符合 Claude API 格式要求：
 *   - 如果包含 thinking blocks，第一个必须是 thinking
 *   - 否则，提取所有文本合并为 string
 */
export function normalizeMessageContent(content: MessageContent): MessageContent {
  if (content === null || typeof content === 'string') {
    return content;
  }

  // 检查是否包含 thinking blocks
  const hasThinking = content.some(part => part.type === 'thinking');

  if (hasThinking) {
    // 如果包含 thinking blocks，确保格式正确
    // 第一个 block 必须是 thinking
    const thinkingIndex = content.findIndex(part => part.type === 'thinking');
    if (thinkingIndex !== 0) {
      // 格式不正确，提取纯文本
      console.warn('[MessageUtils] Invalid thinking block order, extracting text only');
      return getTextFromContent(content);
    }
    // 格式正确，保持原样
    return content;
  }

  // 没有 thinking blocks，提取所有文本合并为 string（简化格式）
  const text = getTextFromContent(content);
  return text || '';
}
