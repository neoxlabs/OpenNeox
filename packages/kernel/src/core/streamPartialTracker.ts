/**
 * Accumulate partial streamed output so callers can choose a continuation path
 * after an interrupted LLM response.
 *
 * The tracker preserves received assistant text; it does not perform retries.
 *
 * It records chunks, completion, and interruption reason for the caller.
 *
 * 续接策略 (调用方实现, 本模块不管):
 *   1. 支持 prefill 的 provider (Anthropic / DeepSeek):
 *      把 partial 作 assistant message append 到 messages 末尾, 让 LLM continue from here
 *   2. 不支持 prefill 的 provider (OpenAI / Gemini / GLM 等):
 *      fallback 重发 (老行为), 或把 partial 作为 context hint 加进 system prompt
 *
 * 本模块只跟踪 + 暴露状态, 不实际续接.
 *
 * 集成点 (后续 wire 到 runner):
 *   - stream 开始: tracker.start()
 *   - 每个 chunk: tracker.append(textChunk)
 *   - 正常完成: tracker.markComplete()
 *   - watchdog 超时 / 网络断 / signal abort: tracker.markInterrupted(reason)
 *   - retry 路径: 检查 tracker.wasInterrupted() + tracker.getPartial(),
 *     非空时按 provider 能力决定 prefill 续接 还是 fallback 重发
 */

// ============================================================================
// 类型
// ============================================================================

export type InterruptReason =
  | 'watchdog_timeout'   // stream chunk 间隔超时
  | 'first_chunk_timeout' // 首 chunk 超时
  | 'network_error'      // 网络异常 (EPIPE / socket hangup)
  | 'abort_signal'       // 用户 / 上层 abort
  | 'unknown';           // 其它未分类异常

export interface PartialSnapshot {
  /** 已累积的 partial content (空串如果没收到任何 chunk) */
  partial: string;
  /** chunks 总数 (含空 chunk) */
  chunkCount: number;
  /** stream 启动时间 ms (Date.now()) */
  startedAt: number;
  /** stream 是否被标记中断 */
  interrupted: boolean;
  /** 中断原因 (interrupted=true 时有意义) */
  interruptReason?: InterruptReason;
  /** 完成时间 ms — 仅当 markComplete / markInterrupted 调过 */
  endedAt?: number;
}

// ============================================================================
// 主类
// ============================================================================

export class StreamPartialTracker {
  private partial = '';
  private chunkCount = 0;
  private startedAt = 0;
  private endedAt: number | undefined;
  private interrupted = false;
  private interruptReason: InterruptReason | undefined;
  private isActive = false;

  /**
   * Start a new stream and clear the previous state. Call before the first chunk;
   * calling again resets the tracker.
   */
  start(): void {
    this.partial = '';
    this.chunkCount = 0;
    this.startedAt = Date.now();
    this.endedAt = undefined;
    this.interrupted = false;
    this.interruptReason = undefined;
    this.isActive = true;
  }

  /**
   * 累积一个 chunk. 空 chunk 也计数 (用于诊断 stream 是否真的在产输出).
   * 必须先 start() 才能 append; 否则 silently no-op (防御性).
   */
  append(chunk: string): void {
    if (!this.isActive) return;
    this.chunkCount += 1;
    if (chunk) this.partial += chunk;
  }

  /**
   * 标记流正常完成. 之后 wasInterrupted() = false, 调用方应当**丢弃** partial
   * (因为已经被 LLM 一次性完整给出, 在 runner 外被记到 message memory).
   *
   * 标记后再 append 会被 silently 忽略.
   */
  markComplete(): void {
    if (!this.isActive) return;
    this.endedAt = Date.now();
    this.isActive = false;
  }

  /**
   * 标记流被中断. 保留 partial 不清, 供 retry 路径决策续接.
   * @param reason 中断原因 (供日志 / 诊断)
   */
  markInterrupted(reason: InterruptReason = 'unknown'): void {
    if (!this.isActive) return;
    this.endedAt = Date.now();
    this.interrupted = true;
    this.interruptReason = reason;
    this.isActive = false;
  }

  /** 拿当前累积 partial. 流活着 / 完成 / 中断 都能拿. */
  getPartial(): string {
    return this.partial;
  }

  /** 是否被标记中断 (区分于 markComplete) */
  wasInterrupted(): boolean {
    return this.interrupted;
  }

  /** 流是否还活着 (没 mark complete / interrupted) */
  isStreamActive(): boolean {
    return this.isActive;
  }

  /** 完整状态快照 — 调试 / 监控 / 测试用 */
  snapshot(): PartialSnapshot {
    return {
      partial: this.partial,
      chunkCount: this.chunkCount,
      startedAt: this.startedAt,
      interrupted: this.interrupted,
      interruptReason: this.interruptReason,
      endedAt: this.endedAt,
    };
  }

  /** 强清 (新 task / /clear). 跟 start() 等价但语义上是 "归零". */
  reset(): void {
    this.start();
    this.isActive = false;  // start 设了 true, reset 应保持非 active
  }
}

// ============================================================================
// 辅助
// ============================================================================

/**
 * 判断当前 partial 是否值得用 prefill 续接.
 *
 * 阈值: ≥30 字符. 太短续接没意义 (重发开销 < 续接复杂度).
 * 调用方可以自己写, 这里给个 default heuristic.
 */
export function shouldUsePrefillContinuation(partial: string): boolean {
  return partial.trim().length >= 30;
}

/**
 * 判断 provider/model 是否支持 assistant 消息末尾 prefill 续写 (协议级).
 *
 * 支持: Anthropic (Messages API 明确支持) / DeepSeek (chat-completions +
 *   prefix completion).
 * 不支持: OpenAI / Gemini / GLM / Kimi / Doubao / 其他 — 会把末尾
 *   assistant message 当历史回复, 生成新内容而非 continue, 浪费 token
 *   但不会出错 (安全 fallback).
 *
 * 标记策略: 优先用 provider 字符串 (precise); 若没有则用 modelId 子串
 *   推断 (兼容 modelProfile 无 provider 字段的情况). 未来加 schema/families
 *   的 supports_prefill 字段更优雅.
 */
export function providerSupportsPrefill(provider?: string, modelId?: string): boolean {
  if (provider) {
    const p = provider.toLowerCase();
    if (p === 'anthropic' || p === 'deepseek') return true;
  }
  if (modelId) {
    const m = modelId.toLowerCase();
    /* model id 子串匹配 — anthropic 家族 (claude / opus / sonnet / haiku) + deepseek */
    if (
      m.includes('claude') ||
      m.includes('opus') ||
      m.includes('sonnet') ||
      m.includes('haiku') ||
      m.includes('deepseek')
    ) {
      return true;
    }
  }
  return false;
}
