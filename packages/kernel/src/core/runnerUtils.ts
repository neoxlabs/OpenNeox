import { ErrorCategory } from '../types/errors.js';
import { truncateMiddleUtf16Safe } from '../utils/wireText.js';

type AbortError = Error & { code?: string; category?: string };
type StreamTimeoutError = Error & {
  code?: string;
  category?: ErrorCategory;
  isNetworkInterrupt?: boolean;
  streamTimeoutPhase?: 'first_chunk' | 'idle';
  timeoutMs?: number;
};

const LARGE_STRING_THRESHOLD = 4000;
/** runner 路径默认略紧 (15k), 与 Anthropic 代理上限对齐. */
const TOOL_OUTPUT_MAX_BYTES = 15_000;

function readTimeoutFromEnv(envVar: string, fallbackMs: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallbackMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return Math.floor(parsed);
}

export const STREAM_FIRST_CHUNK_TIMEOUT_MS = readTimeoutFromEnv('NEOX_STREAM_FIRST_CHUNK_TIMEOUT_MS', 90_000);
export const STREAM_CHUNK_TIMEOUT_MS = readTimeoutFromEnv('NEOX_STREAM_CHUNK_TIMEOUT_MS', 120_000);
export const STREAM_WATCHDOG_DISABLED = process.env.NEOX_STREAM_WATCHDOG_DISABLED === '1';

export function normalizeLimit(value: number | undefined, fallback: number): number | null {
  const resolved = value ?? fallback;
  if (resolved === 0 || resolved === Infinity) {
    return null;
  }
  if (!Number.isFinite(resolved) || resolved < 0) {
    return fallback;
  }
  return Math.floor(resolved);
}

export function computeMaxInputTokens(
  contextWindow?: number,
  tailBudget?: number,
  override?: number,
  defaultTailBudget: number = 20_000,
): number | undefined {
  if (override && override > 0) {
    return override;
  }

  const defaultContextWindow = 190_000;
  const effectiveContextWindow = contextWindow && contextWindow > 0
    ? contextWindow
    : defaultContextWindow;

  const safetyFactor = 0.7;
  const safeBudget = Math.floor(effectiveContextWindow * safetyFactor);
  const effectiveTailBudget = Math.min(
    tailBudget ?? defaultTailBudget,
    Math.floor(effectiveContextWindow * 0.1),
  );
  const maxInput = Math.max(2_000, safeBudget - effectiveTailBudget);

  if (process.env.CLI_DEBUG === '1' || process.env.CLI_DEBUG_CONSOLE === '1') {
    const msg = `[Context] maxInputTokens=${maxInput} (contextWindow=${effectiveContextWindow}, override=${override}, tailBudget=${tailBudget ?? defaultTailBudget}, safety=${safetyFactor})`;
    console.log(msg);
  }

  return maxInput;
}

export function createAbortError(): AbortError {
  const error = new Error('Request aborted') as AbortError;
  error.name = 'AbortError';
  error.code = 'ERR_CANCELED';
  error.category = 'canceled';
  return error;
}

export function createStreamTimeoutError(phase: 'first_chunk' | 'idle', timeoutMs: number): StreamTimeoutError {
  const prettySeconds = Math.round(timeoutMs / 1000);
  const error = new Error(
    phase === 'first_chunk'
      ? `Stream timeout: no response for ${prettySeconds}s`
      : `Stream timeout: no data for ${prettySeconds}s`,
  ) as StreamTimeoutError;
  error.code = 'STREAM_TIMEOUT';
  error.category = ErrorCategory.RETRYABLE_NETWORK;
  error.isNetworkInterrupt = true;
  error.streamTimeoutPhase = phase;
  error.timeoutMs = timeoutMs;
  return error;
}

/**
 * LLM-bound tool output 截断 — 委托 Neox wireText (UTF-16 safe middle truncate).
 * 保留 runner 口语化 marker (告诉模型怎么取回省略段).
 */
export function truncateToolOutput(content: string, maxBytes: number = TOOL_OUTPUT_MAX_BYTES): string {
  if (!content || content.length <= maxBytes) return content;
  return truncateMiddleUtf16Safe(content, {
    maxUnits: maxBytes,
    headRatio: 0.4,
    tailRatio: 0.4,
    marker: ({ removedChars, totalLines }) =>
      `\n\n…[中间 ${removedChars} chars / 共 ${totalLines} 行 已截断 — 只显示头尾。` +
      `需要被省略的部分请缩小范围重取 (指定行区间 / 更精确的搜索模式 / 读具体文件片段)。]…\n\n`,
  });
}

function createOmittedPlaceholder(label: string, value: string): string {
  const lines = value.split(/\r?\n/).length;
  const normalizedLabel = label || 'value';
  return `[omitted ${normalizedLabel}: ${lines} lines, ${value.length} chars]`;
}

function shouldForceOmit(toolName: string, keyPath: string[]): boolean {
  const field = keyPath[keyPath.length - 1];
  if (!field) {
    return false;
  }
  if (toolName === 'write_file' && field === 'content') {
    return true;
  }
  return false;
}

function sanitizeArgumentValue(toolName: string, value: any, keyPath: string[] = []): any {
  if (typeof value === 'string') {
    if (shouldForceOmit(toolName, keyPath) || value.length > LARGE_STRING_THRESHOLD) {
      return createOmittedPlaceholder(keyPath[keyPath.length - 1] || 'value', value);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) => sanitizeArgumentValue(toolName, entry, [...keyPath, String(index)]));
  }

  if (value && typeof value === 'object') {
    const result: Record<string, any> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = sanitizeArgumentValue(toolName, entry, [...keyPath, key]);
    }
    return result;
  }

  return value;
}

export function sanitizeToolArguments(toolName: string, rawArgs: string | undefined): string {
  if (!rawArgs) {
    return '';
  }
  try {
    const parsed = JSON.parse(rawArgs);
    const sanitized = sanitizeArgumentValue(toolName, parsed);
    return JSON.stringify(sanitized);
  } catch {
    return JSON.stringify({
      _omitted: true,
      reason: 'arguments_parse_failed',
      preview: rawArgs.slice(0, 200),
      original_length: rawArgs.length,
    });
  }
}

let _faultInjectFirstChunkHang = Math.max(0, Number(process.env.NEOX_FAULT_INJECT_FIRST_CHUNK_HANG || 0));

export async function* withStreamWatchdog<T>(
  stream: AsyncIterable<T>,
  signal?: AbortSignal,
  onTimeout?: (message: string) => void,
): AsyncGenerator<T> {
  if (STREAM_WATCHDOG_DISABLED) {
    for await (const item of stream) {
      yield item;
    }
    return;
  }

  if (_faultInjectFirstChunkHang > 0) {
    _faultInjectFirstChunkHang--;
    const orig = stream;
    /* 挂起发生在 iterator.next() 内 → watchdog 的 race 正常起跑 → 真实超时路径 */
    stream = (async function* () {
      await new Promise((r) => setTimeout(r, STREAM_FIRST_CHUNK_TIMEOUT_MS + 10_000));
      yield* orig;
    })();
  }

  const iterator = stream[Symbol.asyncIterator]();
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(createAbortError());
      } else {
        signal.addEventListener('abort', () => reject(createAbortError()), { once: true });
      }
    })
    : null;
  let receivedFirstChunk = false;

  while (true) {
    if (signal?.aborted) {
      if (iterator.return) {
        try {
          await iterator.return();
        } catch {
          // Ignore cleanup errors
        }
      }
      throw createAbortError();
    }

    const timeoutMs = receivedFirstChunk ? STREAM_CHUNK_TIMEOUT_MS : STREAM_FIRST_CHUNK_TIMEOUT_MS;
    let timeoutTimer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        const phase = receivedFirstChunk ? 'idle' : 'first_chunk';
        reject(createStreamTimeoutError(phase, timeoutMs));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race(
        abortPromise
          ? [iterator.next(), timeoutPromise, abortPromise]
          : [iterator.next(), timeoutPromise],
      ) as IteratorResult<T>;

      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }

      if (result.done) {
        return;
      }

      receivedFirstChunk = true;
      yield result.value;
    } catch (error: any) {
      if (iterator.return) {
        try {
          await iterator.return();
        } catch {
          // Ignore cleanup errors
        }
      }
      if (error?.code === 'STREAM_TIMEOUT') {
        onTimeout?.(error.message);
      }
      throw error;
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
    }
  }
}
