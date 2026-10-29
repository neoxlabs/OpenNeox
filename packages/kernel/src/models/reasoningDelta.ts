/**
 * 各家把"思考内容"放在流式 delta 的不同字段里 —— 统一收进 reasoning_content。
 *
 *   · DeepSeek / Kimi / 多数 OpenAI 兼容端点: delta.reasoning_content
 *   · OpenRouter: delta.reasoning (字符串) 或 delta.reasoning_details ([{ type: 'reasoning.text', text }])
 *
 *   runner 只认 reasoning_content, 并把它存进历史、下一轮回传。别的字段不收 = 这一轮的思考
 *   丢了, 下一轮回传的是空串; DeepSeek 思考模式遇到"带工具调用却没有思考"的历史会直接 400
 *   ("content[].thinking ... must be passed back")。
 */
export function normalizeReasoningDelta(chunk: any): void {
  const delta = chunk?.choices?.[0]?.delta;
  if (!delta || (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0)) return;
  if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
    delta.reasoning_content = delta.reasoning;
    return;
  }
  if (Array.isArray(delta.reasoning_details)) {
    const text = delta.reasoning_details
      .map((d: any) => (typeof d?.text === 'string' ? d.text : typeof d?.summary === 'string' ? d.summary : ''))
      .join('');
    if (text) delta.reasoning_content = text;
  }
}
