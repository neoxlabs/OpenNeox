/**
 * Jev (TypeSafe System One) 客户端 —— 实验功能「Jev 加持」的唯一出口。
 *
 * Jev 不生成文字, 只对一段 state 回答一批带类型的问题 (noul 是/否概率、choice 选项、
 * score 分档), 每题附概率。一次请求里的多题并行判, 60 题也就 ~500ms, 按输入 token
 * 计费 ($0.042/Mtok)。所以它适合替 agent 做「调大模型之前」的小判断。
 *
 * 用户自带 key (设置 → 实验功能)。没开 / 没 key / 超时 / 报错 → 返回 null, 调用方照
 * 不开 Jev 时的原路径走 —— 那就是现状本身, 不是兜底猜测。
 *
 * 网络走全局 dispatcher (platform/systemProxy 装的), 跟随系统代理。
 */
import { loadConfig } from '@neoxlabs/platform/utils/config.js';
import { unwrapApiKey } from '@neoxlabs/platform/utils/apiKeyCrypto.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODELS_ENDPOINT = 'https://api.typesafe.ai/v1/models';
export const JEV_DEFAULT_MODEL = 'jev-latest';

export type JevQuestion =
  | { type: 'noul'; instructions: unknown; criteria?: unknown }
  | { type: 'choice'; instructions: unknown; criteria: Record<string, unknown> }
  | { type: 'score'; instructions: unknown; criteria: unknown[] };

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number> };

export interface JevResult {
  model: string;
  answers: Record<string, JevAnswer>;
  inputTokens: number;
  ms: number;
}

export interface JevSettings {
  apiKey: string;
  model: string;
}

/** 当前生效的 Jev 设置; 没开或没 key → null。每次现读 config (切开关下一条消息就生效)。 */
export function readJevSettings(): JevSettings | null {
  const jev = loadConfig().experimental?.jev;
  const apiKey = unwrapApiKey(jev?.apiKey).trim();
  if (!jev?.enabled || !apiKey) return null;
  return { apiKey, model: jev.model?.trim() || JEV_DEFAULT_MODEL };
}

export class JevError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'JevError';
  }
}

/**
 * 发一次 System One 请求。失败抛 JevError (超时也是), 由调用方决定怎么记。
 * `signal` 用来跟随本轮中断; `timeoutMs` 是本次请求自己的上限。
 */
export async function askJev(
  settings: JevSettings,
  state: unknown,
  questions: Record<string, JevQuestion>,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<JevResult> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 3000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model: settings.model, questions }),
      signal,
    });
  } catch (err: any) {
    const reason = timeout.aborted ? `timeout after ${opts.timeoutMs ?? 3000}ms` : (err?.message ?? String(err));
    throw new JevError(reason);
  }
  const text = await res.text();
  if (!res.ok) throw new JevError(`HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new JevError(`invalid JSON: ${text.slice(0, 200)}`);
  }
  return {
    model: String(body.model ?? settings.model),
    answers: body.answers ?? {},
    inputTokens: Number(body.usage?.input_tokens ?? 0),
    ms: Math.round(performance.now() - t0),
  };
}
