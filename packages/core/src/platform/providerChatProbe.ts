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
}

const TIMEOUT_MS = 60_000;

export async function runProviderChatProbe(req: ChatProbeRequest): Promise<ChatProbeResult> {
  const started = Date.now();
  const prompt = (req.prompt || '').trim() || 'hi';
  try {
    const { llmProvider } = buildProvider({ provider: req.provider, model: req.model, runtimeMode: 'default' });
    const res = await llmProvider.chat(
      [{ role: 'user', content: prompt }] as any,
      { model: req.model, maxTokens: 512, disableSystemPrompt: true, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    const msg = res?.choices?.[0]?.message;
    const reply = (msg?.content ?? '').trim();
    const reasoning = (msg?.reasoning_content ?? '').trim() || undefined;
    return {
      /* 通了但一个字没回 (只有思考 / 被截断) 也算通 —— 界面如实写「没有回复正文」 */
      ok: true,
      reply,
      reasoning,
      latencyMs: Date.now() - started,
      inputTokens: res?.usage?.prompt_tokens,
      outputTokens: res?.usage?.completion_tokens,
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
