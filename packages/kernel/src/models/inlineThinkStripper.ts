/**
 * Inline <think> 剥离器 — 把上游塞进 content 正文里的思考块切到 reasoning 通道。
 *
 * 背景: 标准 DeepSeek/GLM 端点把思考放独立的 delta.reasoning_content 字段, 但大量
 * OpenAI-compatible 中转 (尤其 DeepSeek R1 第三方代理 / vLLM / ollama 部署) 会把
 * `<think>...</think>` 直接 inline 进 content。此前 Neox 对此零解析 → 思考内容
 * 当正文渲染 + 污染下一轮历史。
 *
 * 设计约束:
 *   - **只认响应开头的 think 块** (允许前导空白)。正文中途出现的 `<think>` 一律不动 —
 *     模型在正文里讨论/引用这个标签是合法内容, 中途剥会毁正文。R1 系的真实行为
 *     也是思考永远在响应最前。
 *   - 跨 chunk 鲁棒: 标签可能被流式切成 `<thi` + `nk>`; 关闭标签同理。
 *   - 未闭合 (流结束还在思考态) → 全部算 reasoning, 不回灌正文。
 *   - 零依赖纯状态机, 每个 chunk O(len)。
 */

export interface StripResult {
  content: string;
  reasoning: string;
}

const OPEN_TAGS = ['<think>', '<thinking>'] as const;
const CLOSE_BY_OPEN: Record<string, string> = {
  '<think>': '</think>',
  '<thinking>': '</thinking>',
};
const MAX_OPEN_TAG_LEN = Math.max(...OPEN_TAGS.map(t => t.length));
/** probe 态允许跳过的前导空白上限 — 防畸形流让 buffer 无限长 */
const MAX_LEADING_WHITESPACE = 16;

export class InlineThinkStripper {
  private state: 'probe' | 'reasoning' | 'passthrough' = 'probe';
  private buf = '';
  private closeTag = '';

  /** 喂一个 content delta, 返回本次可以放行的 content / reasoning 增量 (可能都为空 = 还在缓冲)。 */
  push(delta: string): StripResult {
    if (!delta) return { content: '', reasoning: '' };
    if (this.state === 'passthrough') return { content: delta, reasoning: '' };

    if (this.state === 'probe') {
      this.buf += delta;
      const trimmed = this.buf.replace(/^\s*/, '');
      const leading = this.buf.length - trimmed.length;
      if (leading > MAX_LEADING_WHITESPACE) {
        return this.toPassthrough();
      }
      const openTag = OPEN_TAGS.find(t => trimmed.toLowerCase().startsWith(t));
      if (openTag) {
        // 命中完整开标签 → 进入思考态, 标签后的部分继续按 reasoning 处理
        this.state = 'reasoning';
        this.closeTag = CLOSE_BY_OPEN[openTag];
        const rest = trimmed.slice(openTag.length);
        this.buf = '';
        return rest ? this.push(rest) : { content: '', reasoning: '' };
      }
      const couldStillMatch =
        trimmed.length < MAX_OPEN_TAG_LEN &&
        OPEN_TAGS.some(t => t.startsWith(trimmed.toLowerCase()));
      if (couldStillMatch || trimmed.length === 0) {
        return { content: '', reasoning: '' }; // 继续缓冲等下一个 chunk
      }
      return this.toPassthrough();
    }

    // reasoning 态: 找关闭标签; 没找到则留一个"可能是关闭标签前缀"的尾巴继续缓冲
    this.buf += delta;
    const lower = this.buf.toLowerCase();
    const closeIdx = lower.indexOf(this.closeTag);
    if (closeIdx >= 0) {
      const reasoning = this.buf.slice(0, closeIdx);
      const after = this.buf.slice(closeIdx + this.closeTag.length);
      this.state = 'passthrough';
      this.buf = '';
      // 关标签后紧跟的换行是格式残留, 吃掉一个
      return { content: after.replace(/^\r?\n/, ''), reasoning };
    }
    // 保留可能构成 closeTag 前缀的最长后缀
    let keep = 0;
    const maxKeep = Math.min(this.closeTag.length - 1, this.buf.length);
    for (let k = maxKeep; k > 0; k--) {
      if (this.closeTag.startsWith(lower.slice(lower.length - k))) {
        keep = k;
        break;
      }
    }
    const reasoning = this.buf.slice(0, this.buf.length - keep);
    this.buf = this.buf.slice(this.buf.length - keep);
    return { content: '', reasoning };
  }

  /** 流结束: 吐出所有残留。probe 残留是正文 (从没匹配上标签); reasoning 残留算思考 (未闭合)。 */
  flush(): StripResult {
    const buf = this.buf;
    this.buf = '';
    if (this.state === 'probe') {
      this.state = 'passthrough';
      return { content: buf, reasoning: '' };
    }
    if (this.state === 'reasoning') {
      this.state = 'passthrough';
      return { content: '', reasoning: buf };
    }
    return { content: '', reasoning: '' };
  }

  private toPassthrough(): StripResult {
    const buf = this.buf;
    this.state = 'passthrough';
    this.buf = '';
    return { content: buf, reasoning: '' };
  }
}

/** 非流式便捷入口: 整段文本一次剥离。 */
export function stripInlineThinkFromText(text: string): StripResult {
  const stripper = new InlineThinkStripper();
  const a = stripper.push(text);
  const b = stripper.flush();
  return { content: a.content + b.content, reasoning: a.reasoning + b.reasoning };
}

/**
 * OpenAI chat-completions 流式 chunk 变换器 — 把 delta.content 里 inline 的 think 块
 * 转成 delta.reasoning_content, 其余字段 (tool_calls / role / finish_reason / usage) 原样透传。
 * finish_reason 帧到达前先 flush, 保证尾部残留不会落在完成信号之后被丢弃。
 */
export async function* stripInlineThinkFromChunks(source: AsyncIterable<any>): AsyncGenerator<any> {
  const stripper = new InlineThinkStripper();
  let template: any = null;

  const makeChunk = (delta: Record<string, unknown>) => ({
    ...(template ?? { object: 'chat.completion.chunk' }),
    choices: [{ index: 0, delta }],
  });

  const emitPending = function* (result: StripResult) {
    if (result.reasoning) yield makeChunk({ reasoning_content: result.reasoning });
    if (result.content) yield makeChunk({ content: result.content });
  };

  for await (const chunk of source) {
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta;

    if (!template && chunk?.object === 'chat.completion.chunk') {
      const { choices: _omit, ...rest } = chunk;
      template = rest;
    }

    const hasContent = delta && typeof delta.content === 'string' && delta.content.length > 0;

    if (hasContent) {
      const result = stripper.push(delta.content);
      const { content: _drop, ...deltaRest } = delta;
      if (result.reasoning) {
        yield makeChunk({ reasoning_content: result.reasoning });
      }
      const restKeys = Object.keys(deltaRest).filter(k => deltaRest[k] !== undefined && deltaRest[k] !== null);
      if (result.content || restKeys.length > 0) {
        // content 可能为空但 delta 还带 tool_calls/role 等, 不能整帧吞掉
        yield { ...chunk, choices: [{ ...choice, delta: { ...deltaRest, ...(result.content ? { content: result.content } : {}) } }] };
      }
      continue;
    }

    if (choice?.finish_reason) {
      yield* emitPending(stripper.flush());
    }
    yield chunk;
  }

  yield* emitPending(stripper.flush());
}
