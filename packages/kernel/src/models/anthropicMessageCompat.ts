import type { Message } from '../types/index.js';

/** Claude 的 thinking signature 是一长串 base64; 空的或 UUID 形态的是别家 (DeepSeek 等) 产出的 */
export function isForeignThinkingSignature(signature: unknown): boolean {
  if (typeof signature !== 'string' || !signature.trim()) return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(signature.trim());
}

/**
 * 回应上一条 tool_use 的 user 消息里, tool_result 必须排在**最前面**, text/image 只能跟在
 * 全部 tool_result 之后 —— 否则报 "tool_use ids were found without tool_result blocks
 * immediately after"。合并 user 消息会把夹在 tool 结果中间的读图附件 / reminder 原样拼进来,
 * 这里稳定地把 tool_result 提前, 其余块保持相对顺序。就地修改。
 */
export function moveToolResultsFirst(messages: any[]): void {
  for (const msg of messages) {
    if (msg?.role !== 'user' || !Array.isArray(msg.content)) continue;
    const results = msg.content.filter((b: any) => b?.type === 'tool_result');
    if (results.length === 0 || results.length === msg.content.length) continue;
    msg.content = [...results, ...msg.content.filter((b: any) => b?.type !== 'tool_result')];
  }
}

/**
 * 发给 Claude 时丢掉别家 (DeepSeek 用消息 UUID 当 signature / 无签名) 产出的 thinking ——
 * 同一会话从 DeepSeek 切到 Claude, 这种块过不了签名校验, 整条请求 400。非 Claude 目标原样保留。
 */
export function keepReplayableThinking<T extends { type: string; signature?: string }>(
  blocks: readonly T[],
  claudeTarget: boolean,
): T[] {
  if (!claudeTarget) return [...blocks];
  return blocks.filter((b) => b.type !== 'thinking' || !isForeignThinkingSignature(b.signature));
}

/**
 * 非 Claude 目标里, 没有 thinking_blocks 的工具轮补一块无签名 thinking (内容取 reasoning_content)。
 *
 * DeepSeek 思考模式下带 tool_use 的 assistant 轮**必须**回传 thinking, 否则 400 "The
 * content[].thinking in the thinking mode must be passed back"; 它不校验签名 (无签名 / 空签名 /
 * 空文本都收)。Kimi / GLM 补不补都收。历史里缺它的场景: 换过模型、走过 OpenAI 协议、老会话。
 * Claude 目标绝不补 —— 无签名 thinking 在 Claude 那里是 400。
 */
/**
 * DeepSeek 的 Anthropic 口不认 tool_result 里的图片 —— 400 "messages.N.content[i].image[0]:
 * You have uploaded an unsupported image" (图本身是合法 JPEG/PNG); 顶层 image 块它认。
 * 读图工具的结果就是带图的 tool_result, 所以对 DeepSeek 把图挪出来, 排在全部 tool_result 之后
 * (tool_result 必须在最前)。tool_result 里只留文字, 没文字补一句说明。就地修改, 返回挪了几张。
 */
export function hoistToolResultImagesForDeepSeek(messages: any[], baseUrl: string | undefined, model: string | undefined): number {
  const isDeepSeek = /(^|\.)deepseek\.com/i.test(safeHost(baseUrl)) || /^deepseek/i.test(model ?? '');
  if (!isDeepSeek || /(^|\.)anthropic\.com$/i.test(safeHost(baseUrl))) return 0;
  let moved = 0;
  for (const msg of messages) {
    if (msg?.role !== 'user' || !Array.isArray(msg.content)) continue;
    const results: any[] = [], hoisted: any[] = [], rest: any[] = [];
    for (const b of msg.content) {
      if (b?.type !== 'tool_result' || !Array.isArray(b.content)) { (b?.type === 'tool_result' ? results : rest).push(b); continue; }
      const imgs = b.content.filter((x: any) => x?.type === 'image');
      if (imgs.length === 0) { results.push(b); continue; }
      const kept = b.content.filter((x: any) => x?.type !== 'image');
      results.push({ ...b, content: kept.length ? kept : [{ type: 'text', text: `[${imgs.length} image(s) returned by the tool, attached below]` }] });
      hoisted.push(...imgs);
      moved += imgs.length;
    }
    if (hoisted.length) msg.content = [...results, ...hoisted, ...rest];
  }
  return moved;
}

function safeHost(url: string | undefined): string {
  try { return url ? new URL(url).hostname : ''; } catch { return ''; }
}

export function vendorThinkingFallback(msg: Message, claudeTarget: boolean): { type: 'thinking'; thinking: string } | null {
  if (claudeTarget || !msg.tool_calls || msg.tool_calls.length === 0) return null;
  const reasoning = (msg as { reasoning_content?: unknown }).reasoning_content;
  return { type: 'thinking', thinking: typeof reasoning === 'string' ? reasoning : '' };
}
