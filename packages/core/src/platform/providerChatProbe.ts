import type { ProviderConfigEntry } from '@neoxlabs/kernel/types/configTypes.js';
import { buildProvider } from '../runtime/runtimeBuilder.js';

export interface ChatProbeRequest {
  provider: ProviderConfigEntry;
  model: string;
  prompt?: string;
}

export interface ChatProbeResult {
  ok: boolean;
  reply?: string;
  /** 思考模型的思考过程 (有就给, 界面折叠显示) */
  reasoning?: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
  httpStatus?: number;
  /** 流式情况 —— 见 judgeStreaming */
  streaming?: StreamingVerdict;
}

export interface StreamingVerdict {
  verdict: 'real' | 'buffered' | 'unknown';
  /** 带字的块数 */
  chunks: number;
  /** 请求发出到第一个字 */
  firstTokenMs: number | null;
  /** 第一个字到最后一个字 */
  spreadMs: number;
  chars: number;
}

export function judgeStreaming(arrivals: Array<{ t: number; chars: number }>, startedAt: number): StreamingVerdict {
  const chars = arrivals.reduce((a, b) => a + b.chars, 0);
  const firstTokenMs = arrivals.length ? arrivals[0].t - startedAt : null;
  const spreadMs = arrivals.length ? arrivals[arrivals.length - 1].t - arrivals[0].t : 0;
  const base = { chunks: arrivals.length, firstTokenMs, spreadMs, chars };
  if (chars < 40) return { verdict: 'unknown', ...base };
  if (arrivals.length <= 2) return { verdict: 'buffered', ...base };
  if (chars >= 80 && spreadMs < 150) return { verdict: 'buffered', ...base };
  return { verdict: 'real', ...base };
}

const TIMEOUT_MS = 60_000;
/** 用户只发了个 hi 时, 回复太短判不了流式 —— 追加一个输出够长的小任务 */
const STREAM_TEST_SUFFIX = '\n\n(Then count from 1 to 30, one number per line.)';

export async function runProviderChatProbe(req: ChatProbeRequest): Promise<ChatProbeResult> {
  const started = Date.now();
  const userPrompt = (req.prompt || '').trim() || 'hi';
  const prompt = userPrompt.length < 40 ? userPrompt + STREAM_TEST_SUFFIX : userPrompt;
  try {
    const { llmProvider } = buildProvider({ provider: req.provider, model: req.model, runtimeMode: 'default' });
    /* 走流式: 跟真实聊天同一种请求, 顺便量出假流式 */
    let reply = '';
    let reasoning = '';
    let usage: any;
    const arrivals: Array<{ t: number; chars: number }> = [];
    const messages = req.provider.protocol === 'openai-responses'
      ? [{ role: 'system', content: 'Reply briefly.' }, { role: 'user', content: prompt }]
      : [{ role: 'user', content: prompt }];
    for await (const chunk of llmProvider.chatStreamed(
      messages as any,
      { model: req.model, maxTokens: 512, disableSystemPrompt: true, signal: AbortSignal.timeout(TIMEOUT_MS) },
    )) {
      const delta = (chunk as any)?.choices?.[0]?.delta;
      const text = typeof delta?.content === 'string' ? delta.content : '';
      const think = typeof delta?.reasoning_content === 'string' ? delta.reasoning_content
        : typeof delta?.reasoning === 'string' ? delta.reasoning : '';
      if (text || think) arrivals.push({ t: Date.now(), chars: text.length + think.length });
      reply += text;
      reasoning += think;
      if ((chunk as any)?.usage) usage = (chunk as any).usage;
    }
    return {
      /* 通了但一个字没回 (只有思考 / 被截断) 也算通 —— 界面如实写「没有回复正文」 */
      ok: true,
      reply: reply.trim(),
      reasoning: reasoning.trim() || undefined,
      latencyMs: Date.now() - started,
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens,
      streaming: judgeStreaming(arrivals, started),
    };
  } catch (err: any) {
    const httpStatus: number | undefined = err?.status ?? err?.statusCode ?? err?.httpStatus ?? err?.response?.status;
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      ok: false,
      latencyMs: Date.now() - started,
      httpStatus: typeof httpStatus === 'number' ? httpStatus : undefined,
      error: timedOut ? `${TIMEOUT_MS / 1000}s 内没有回复` : String(err?.message ?? err).slice(0, 400),
    };
  }
}
