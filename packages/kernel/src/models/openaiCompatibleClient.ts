import axios, { type AxiosInstance } from 'axios';
import type { ProviderRetryConfig, RetryConfig } from '../types/retryConfig.js';
import { mergeRetryConfig, getProviderRetryConfig } from '../types/retryConfig.js';
import { classifyError, parseRetryAfter } from '../types/errors.js';
import { getRetryDelay, abortableSleep, formatDelay } from '../utils/backoff.js';
import { cliLogger } from '../platform/cliLogger.js';
import { safeJSONParse } from '../utils/streamProcessor.js';
import { getNeoxUserAgent } from '../utils/neoxUserAgent.js';
import { createUtf8ChunkDecoder } from '../utils/utf8StreamDecoder.js';

export interface OpenAICompatibleClientConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  providerName?: string;
  retry?: ProviderRetryConfig;
}

export interface StreamRequestOptions {
  signal?: AbortSignal;
  maxRetries?: number;
}

function getHeaderValue(headers: any, key: string): string | undefined {
  if (!headers) return undefined;
  const value = headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}

async function readStreamErrorBody(data: any): Promise<string | undefined> {
  if (!data) return undefined;
  if (typeof data === 'string') return data;
  if (typeof data === 'object' && typeof (data as any).on === 'function') {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of data as AsyncIterable<Buffer | string>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      return raw || undefined;
    } catch {
      return undefined;
    }
  }
  try {
    return JSON.stringify(data);
  } catch {
    return undefined;
  }
}

async function hydrateErrorBody(providerName: string, error: any): Promise<void> {
  const response = error?.response;
  if (!response) return;
  const status = response.status;
  const requestId =
    getHeaderValue(response.headers, 'x-request-id') ||
    getHeaderValue(response.headers, 'cf-ray');
  const raw = await readStreamErrorBody(response.data);
  if (raw) {
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* keep raw string */
    }
    response.data = parsed;
    const msg = typeof parsed === 'object' && parsed !== null
      ? (parsed as any)?.error?.message || (parsed as any)?.message || raw
      : raw;
    if (typeof msg === 'string' && msg.length > 0) {
      error.message = `${providerName} API error ${status ?? ''}: ${msg}`.trim();
    }
    cliLogger.error(providerName, `HTTP ${status ?? '?'} body (requestId=${requestId ?? 'n/a'}):\n${raw}`);
  } else {
    cliLogger.error(
      providerName,
      `HTTP ${status ?? '?'} with empty body (requestId=${requestId ?? 'n/a'}); axios message: ${error?.message}`
    );
  }
}

export class OpenAICompatibleClient {
  private client: AxiosInstance;
  private retryConfig: RetryConfig;
  private providerName: string;

  constructor(config: OpenAICompatibleClientConfig) {
    this.providerName = config.providerName || 'openai-compatible';

    this.client = axios.create({
      baseURL: config.baseUrl,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': getNeoxUserAgent(),
        /* 与 openai.ts / anthropic.ts 对齐: SSE 禁用 gzip 缓冲, 避免流式「假死」 */
        'Accept-Encoding': 'identity',
      },
      timeout: config.timeoutMs ?? 120000,
      decompress: false,
    });

    const providerPreset = getProviderRetryConfig(this.providerName, config.baseUrl);
    this.retryConfig = mergeRetryConfig(undefined, {
      ...providerPreset,
      ...config.retry,
    });
  }

  async postJson<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const maxRetries = this.retryConfig.requestMaxRetries;

    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.client.post<T>(path, payload, { signal });
        return response.data;
      } catch (error: any) {
        await hydrateErrorBody(this.providerName, error);
        const classified = classifyError(error);
        if (!classified.retryable || attempt >= maxRetries) {
          throw classified;
        }

        const retryAfter = parseRetryAfter(getHeaderValue(error?.response?.headers, 'retry-after'));
        const delay = getRetryDelay(retryAfter, attempt + 1, this.retryConfig);

        cliLogger.warn(this.providerName, `Request failed (${classified.code}), retrying in ${formatDelay(delay)} (${attempt + 1}/${maxRetries})`);
        await abortableSleep(delay, signal);
      }
    }
  }

  async *streamJsonEvents(path: string, payload: unknown, options: StreamRequestOptions = {}): AsyncGenerator<any> {
    const maxRetries = options.maxRetries ?? this.retryConfig.streamMaxRetries;
    const signal = options.signal;
    /* 吐过内容就不在这里整段重发: 上层攒着上一次的半截, 重发会拼成两遍 / 工具参数串位。
     * 交给 runner 级重试 (它会撤掉界面上的半截) —— 同 openai.ts 的 emittedStreamEvent。 */
    let emittedContent = false;

    for (let attempt = 0; ; attempt++) {
      //  每轮 retry 前先检查 signal,一 abort 立即 throw,不再走网络 / 不再 hydrate
      if (signal?.aborted) {
        throw classifyError(new DOMException('Aborted', 'AbortError'));
      }

      try {
        if (attempt > 0) {
          yield {
            type: 'stream_recovered',
            attempt,
            maxRetries,
          };
        }

        const response = await this.client.post(path, payload, {
          responseType: 'stream',
          signal,
        });

        for await (const event of this.parseSSEStream(response.data, signal)) {
          const d = event?.choices?.[0]?.delta;
          if (d && (d.content || d.reasoning_content || d.tool_calls)) emittedContent = true;
          yield event;
        }
        return;
      } catch (error: any) {
        //  signal abort 时立刻短路 — 不等 hydrateErrorBody 读 stream body,不走 retry
        if (signal?.aborted) {
          try { (error?.response?.data as any)?.destroy?.(); } catch {}
          throw classifyError(new DOMException('Aborted', 'AbortError'));
        }
        await hydrateErrorBody(this.providerName, error);
        const classified = classifyError(error);
        if (!classified.retryable || attempt >= maxRetries || emittedContent) {
          throw classified;
        }

        const retryAfter = parseRetryAfter(getHeaderValue(error?.response?.headers, 'retry-after'));
        const delay = getRetryDelay(retryAfter, attempt + 1, this.retryConfig);

        yield {
          type: 'stream_retry',
          error: classified.message,
          errorCode: classified.code,
          attempt: attempt + 1,
          maxRetries,
          delayMs: delay,
        };

        cliLogger.info(this.providerName, `Stream failed (${classified.code}), reconnecting in ${formatDelay(delay)} (${attempt + 1}/${maxRetries})...`);
        await abortableSleep(delay, signal);
      }
    }
  }

  private async *parseSSEStream(stream: any, signal?: AbortSignal): AsyncGenerator<any> {
    let buffer = '';
    let chunkCount = 0;
    let doneSeen = false;

    const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

    //  signal abort 时立刻 destroy stream + 抛 AbortError,
    // 不再等 chunk 到来才响应(Kimi thinking 阶段可能几十秒不吐 chunk)。
    let onAbort: (() => void) | null = null;
    if (signal && !signal.aborted) {
      onAbort = () => {
        try { (stream as any)?.destroy?.(new DOMException('Aborted', 'AbortError')); } catch {}
      };
      signal.addEventListener('abort', onAbort, { once: true });
    } else if (signal?.aborted) {
      try { (stream as any)?.destroy?.(new DOMException('Aborted', 'AbortError')); } catch {}
      throw new DOMException('Aborted', 'AbortError');
    }

    const decodeChunk = createUtf8ChunkDecoder();
    try {
    for await (const chunk of stream) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      if (chunkCount++ % 20 === 0) {
        await yieldToEventLoop();
      }

      /* Buffer.toString('utf8') 会把跨包的半个多字节字符毁成 � —— 必须 StringDecoder */
      buffer += decodeChunk(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || !trimmedLine.startsWith('data:')) continue;

        const data = trimmedLine.slice(5).trimStart();
        if (!data) continue;
        if (data === '[DONE]') {
          doneSeen = true;
          return;
        }

        const parsed = await safeJSONParse<any>(data);
        if (parsed !== undefined) {
          yield parsed;
        }
      }
    }

    if (doneSeen) {
      return;
    }

    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const data = tail.slice(5).trimStart();
      if (data === '[DONE]') {
        return;
      }
      if (data) {
        const parsed = await safeJSONParse<any>(data);
        if (parsed !== undefined) {
          yield parsed;
        }
      }
    }
    } finally {
      if (onAbort && signal) {
        try { signal.removeEventListener('abort', onAbort); } catch {}
      }
    }
  }

}
