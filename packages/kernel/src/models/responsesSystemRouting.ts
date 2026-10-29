
import type { Message } from '../types/index.js';
import { getTextFromContent } from '../utils/messageUtils.js';
import { isCompactionSummaryMessage } from '../utils/compression/llmSummarizer.js';

/** 开头连续的那段 system (压缩工作记录除外) —— 身份 prompt。其后的 system 都是内容。 */
export function leadingIdentitySystemMessages(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const msg of messages) {
    if (msg.role !== 'system') break;
    if (isCompactionSummaryMessage(msg)) continue;
    out.push(msg);
  }
  return out;
}

/** 把一组 system 消息拼成一段文本 (空的跳过); 一段都没有返回 undefined。 */
export function systemMessagesText(messages: Message[]): string | undefined {
  const parts = messages
    .filter((msg) => msg.role === 'system')
    .map((msg) => (typeof msg.content === 'string' ? msg.content : getTextFromContent(msg.content))?.trim() || '')
    .filter(Boolean);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

export interface ResponsesSystemRouting {
  instructions: string | undefined;
  /** 这些 system 已由 instructions 承载, 不再进 input; 其余 system 原位作 developer。 */
  skipSystem: Set<Message>;
  /** 只要对话本身, 不加 Codex 那套 AGENTS / 冻结上下文前缀。 */
  bare: boolean;
}

export function routeResponsesSystemMessages(opts: {
  messages: Message[];
  codexPrompt: boolean;
  /** 本次请求有没有带 tools —— 没带的是独立请求, 不是 agent 回合。 */
  hasTools: boolean;
  /** Neox 指令构建器的产物 (纯 kernel 没注入构建器时为 undefined)。 */
  builtInstructions: () => string | undefined;
}): ResponsesSystemRouting {
  const identity = leadingIdentitySystemMessages(opts.messages);
  const identityText = systemMessagesText(identity);
  if (!opts.codexPrompt) {
    return {
      instructions: identityText ?? opts.builtInstructions(),
      skipSystem: new Set(identity),
      bare: true,
    };
  }
  const standalone = !opts.hasTools;
  const codexInstructions = opts.builtInstructions();
  return {
    instructions: codexInstructions ?? identityText,
    /* 纯 kernel 没有 Codex 指令可用时, 身份 prompt 已经当 instructions 了, 别再发一遍 */
    skipSystem: standalone && codexInstructions ? new Set<Message>() : new Set(identity),
    bare: standalone,
  };
}

/** input 里剩下的 system (都是内容) → developer 消息。 */
export function systemMessageToDeveloperItem(msg: Message): any[] {
  const text = getTextFromContent(msg.content);
  if (!text || text.trim().length === 0) return [];
  return [{ type: 'message', role: 'developer', status: 'completed', content: [{ type: 'input_text', text }] }];
}
