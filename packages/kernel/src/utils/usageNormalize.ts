/**
 * 供应商 usage 归一化 —— **唯一真源**。
 *
 * 为什么必须只有一份: 两大协议家族对"输入 token"的口径根本不同, 抄第二份必然漂移。
 *   Anthropic: input_tokens = **非缓存部分**, 缓存另报 cache_read/cache_creation_input_tokens
 *   OpenAI/DeepSeek/Kimi: prompt_tokens = **总量(含缓存)**, 缓存是其中的子集
 *                         (cached_tokens / prompt_tokens_details.cached_tokens / prompt_cache_hit_tokens)
 *
 * 调用方统一经过此函数，避免把累计输入、非缓存输入和缓存子集混为同一口径。
 */
export interface RawUsageLike {
  prompt_tokens?: number;
  /* Anthropic */
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /* OpenAI / DeepSeek / Kimi */
  cached_tokens?: number;
  prompt_cache_hit_tokens?: number;
  cache_write_input_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface NormalizedUsage {
  /** 非缓存输入 (计费的那部分) */
  normalizedInput: number;
  /** 缓存命中 */
  cacheRead: number;
  /** 缓存创建 */
  cacheWrite: number;
  /** 总 context = 三者之和 —— **占用上下文窗口的真实量**, 阈值比较只该用这个 */
  contextTokens: number;
}

export function normalizeUsageTokens(usage: RawUsageLike | null | undefined): NormalizedUsage {
  const empty = { normalizedInput: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0 };
  if (!usage) return empty;

  const rawPromptTokens = usage.prompt_tokens || 0;
  const anthropicCacheRead = usage.cache_read_input_tokens || 0;
  const anthropicCacheWrite = usage.cache_creation_input_tokens || 0;
  const openaiCacheRead =
    usage.prompt_tokens_details?.cached_tokens
    || usage.cached_tokens
    || usage.prompt_cache_hit_tokens
    || 0;
  /* prompt_cache_miss_tokens 不算 cache write: DeepSeek 的 miss = 未命中缓存的普通输入
   * (正常计费), 算进 write 会让 normalizedInput 恒为 0、真实输入被错标成 Cache Write。
   * miss 走下面 prompt - hit 自然得出。 */
  const openaiCacheWrite = usage.cache_write_input_tokens || 0;

  let normalizedInput: number;
  let cacheRead: number;
  let cacheWrite: number;

  if (anthropicCacheRead > 0 || anthropicCacheWrite > 0) {
    // Anthropic 模式: prompt_tokens(=input_tokens) 已经是非缓存部分
    normalizedInput = rawPromptTokens;
    cacheRead = anthropicCacheRead;
    cacheWrite = anthropicCacheWrite;
  } else {
    // OpenAI/DeepSeek/Kimi 模式: prompt_tokens 是总量, 减去缓存部分才是计费输入
    cacheRead = openaiCacheRead;
    cacheWrite = openaiCacheWrite;
    const cachedTotal = cacheRead + cacheWrite;
    normalizedInput = cachedTotal > 0 ? Math.max(0, rawPromptTokens - cachedTotal) : rawPromptTokens;
  }

  return {
    normalizedInput,
    cacheRead,
    cacheWrite,
    // 非缓存 + 缓存读 + 缓存写 —— 三者都占 context window
    contextTokens: normalizedInput + cacheRead + cacheWrite,
  };
}
