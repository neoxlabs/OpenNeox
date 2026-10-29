import type { Message } from '../types/index.js';

/** reasoning_content 回传策略 (按模型家族声明, 见 openai.ts resolveReasoningPassbackPolicy) */
export type ReasoningPassbackPolicy = 'with_tool_calls' | 'never' | 'always';

/**
 * 流式收帧: 网关一块一帧下发, runner 认的是 chunk **顶层** thinking_blocks (整组覆盖) ——
 * 所以累加后挂到顶层再交出去。`acc` 由调用方每次请求新建一个。
 */
export function withSignedThinking<T>(chunk: T, acc: unknown[]): T {
  const blocks = (chunk as any)?.choices?.[0]?.delta?.thinking_blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return chunk;
  acc.push(...blocks);
  return { ...(chunk as any), thinking_blocks: acc.slice() };
}

/** 发线: 这条 assistant 消息要原样带回的思考块; 不该带时返回 undefined */
export function signedThinkingForWire(msg: Message, toNeoxGateway: boolean): unknown[] | undefined {
  if (!toNeoxGateway || msg.role !== 'assistant') return undefined;
  const signed = (msg.thinking_blocks ?? []).filter((b) => b && (b.signature || b.type === 'redacted_thinking'));
  return signed.length > 0 ? signed : undefined;
}

/**
 * assistant 消息发线前要带回的思考: reasoning_content (按模型家族的回传策略) + Claude 带签名的 thinking 块。
 * 回传策略: DeepSeek 带工具时要求**每一轮** assistant 都带 reasoning, 不只是带 tool_calls 的那几轮。
 */
export function applyAssistantPassback(
  formatted: { reasoning_content?: string; thinking_blocks?: unknown[] },
  msg: Message,
  policy: ReasoningPassbackPolicy,
  toNeoxGateway: boolean,
): void {
  if (msg.role !== 'assistant') return;
  const keep = policy === 'always' || (policy === 'with_tool_calls' && !!msg.tool_calls && msg.tool_calls.length > 0);
  if (keep && typeof msg.reasoning_content === 'string') {
    formatted.reasoning_content = msg.reasoning_content;
  } else if (policy === 'always') {
    // Legacy/non-thinking history has no reasoning to replay, but the field is required.
    formatted.reasoning_content = '';
  }
  const signed = signedThinkingForWire(msg, toNeoxGateway);
  if (signed) formatted.thinking_blocks = signed;
}
