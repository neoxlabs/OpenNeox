/**
 * Speculative Engine — Speculation Phase 3
 *
 * 用户输入稳定 3s → 后台发送 speculative API 请求：
 * - 用户修改输入 → abort 旧请求
 * - 用户提交 → 如果 speculative 结果匹配，直接显示（零延迟）
 * - Abortable：使用 AbortController
 * - 成本控制：只对短输入（< 100 chars）+ 低价模型启用
 *
 * 多 Provider 适配：通过统一的 sendRequest 接口，不依赖特定 provider。
 */

// ==================== Types ====================

export interface SpeculativeRequest {
  id: string;
  prompt: string;
  timestamp: number;
  abortController: AbortController;
  status: 'pending' | 'streaming' | 'completed' | 'aborted' | 'error';
  result?: string;
  error?: string;
  /** Tokens consumed (for cost tracking) */
  tokensUsed?: { input: number; output: number };
}

export interface SpeculativeConfig {
  /** Enable/disable speculative execution */
  enabled: boolean;
  /** Debounce time before sending speculative request (ms) */
  debounceMs: number;
  /** Maximum input length for speculation */
  maxInputLength: number;
  /** Maximum cost per speculative request (USD) — abort if exceeded */
  maxCostPerRequest: number;
  /** Only speculate for models with cost score >= this (higher = cheaper) */
  minCostScore: number;
}

export type SendRequestFn = (
  prompt: string,
  signal: AbortSignal,
) => Promise<{ output: string; inputTokens: number; outputTokens: number }>;

// ==================== Default Config ====================

const DEFAULT_CONFIG: SpeculativeConfig = {
  enabled: false, // Disabled by default — opt-in
  debounceMs: 3000,
  maxInputLength: 100,
  maxCostPerRequest: 0.01, // Max $0.01 per speculative request
  minCostScore: 60, // Only for cheap models (cost score >= 60)
};

// ==================== Engine ====================

export class SpeculativeEngine {
  private config: SpeculativeConfig;
  private currentRequest: SpeculativeRequest | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private sendRequest: SendRequestFn | null = null;
  private requestCounter = 0;

  // Stats
  private stats = {
    totalRequests: 0,
    hits: 0,          // User submitted and spec result matched
    misses: 0,        // User submitted but spec result didn't match
    aborted: 0,       // User changed input before spec completed
    errors: 0,
    totalCostUsd: 0,
  };

  constructor(config?: Partial<SpeculativeConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Set the request sender function */
  setSendRequest(fn: SendRequestFn): void {
    this.sendRequest = fn;
  }

  /** Update config */
  updateConfig(updates: Partial<SpeculativeConfig>): void {
    Object.assign(this.config, updates);
  }

  getConfig(): Readonly<SpeculativeConfig> {
    return this.config;
  }

  /**
   * Called when user input changes.
   * Debounces and fires speculative request if conditions are met.
   */
  onInputChange(input: string, modelCostScore?: number): void {
    if (!this.config.enabled || !this.sendRequest) return;

    // Clear previous debounce
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // Abort current request if input changed
    if (this.currentRequest && this.currentRequest.status === 'pending') {
      this.currentRequest.abortController.abort();
      this.currentRequest.status = 'aborted';
      this.stats.aborted++;
    }

    // Skip if input is too long, empty, or a command
    if (!input || input.length > this.config.maxInputLength || input.startsWith('/')) {
      return;
    }

    // Skip if model is too expensive
    if (modelCostScore !== undefined && modelCostScore < this.config.minCostScore) {
      return;
    }

    // Debounce
    this.debounceTimer = setTimeout(() => {
      this.executeSpeculation(input);
    }, this.config.debounceMs);
  }

  /**
   * Called when user submits input.
   * Returns the speculative result if it matches, null otherwise.
   */
  onSubmit(submittedInput: string): { output: string; fromSpeculation: boolean } | null {
    if (!this.currentRequest) return null;

    if (
      this.currentRequest.status === 'completed' &&
      this.currentRequest.prompt === submittedInput &&
      this.currentRequest.result
    ) {
      // Hit — speculative result matches submitted input
      this.stats.hits++;
      const result = { output: this.currentRequest.result, fromSpeculation: true };
      this.currentRequest = null;
      return result;
    }

    // Miss or not ready
    if (this.currentRequest.status === 'completed') {
      this.stats.misses++;
    }

    // Abort if still pending
    if (this.currentRequest.status === 'pending' || this.currentRequest.status === 'streaming') {
      this.currentRequest.abortController.abort();
      this.currentRequest.status = 'aborted';
      this.stats.aborted++;
    }

    this.currentRequest = null;
    return null;
  }

  /** Get current speculation status */
  getStatus(): 'idle' | 'predicting' | 'ready' {
    if (!this.currentRequest) return 'idle';
    if (this.currentRequest.status === 'pending' || this.currentRequest.status === 'streaming') return 'predicting';
    if (this.currentRequest.status === 'completed') return 'ready';
    return 'idle';
  }

  /** Get stats */
  getStats() {
    return { ...this.stats };
  }

  /** Cancel all in-flight speculation */
  cancel(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.currentRequest && (this.currentRequest.status === 'pending' || this.currentRequest.status === 'streaming')) {
      this.currentRequest.abortController.abort();
      this.currentRequest.status = 'aborted';
    }
    this.currentRequest = null;
  }

  /** Dispose */
  dispose(): void {
    this.cancel();
    this.sendRequest = null;
  }

  // ==================== Internal ====================

  private async executeSpeculation(prompt: string): Promise<void> {
    if (!this.sendRequest) return;

    const abortController = new AbortController();
    const id = `spec-${++this.requestCounter}`;

    const request: SpeculativeRequest = {
      id,
      prompt,
      timestamp: Date.now(),
      abortController,
      status: 'pending',
    };

    this.currentRequest = request;
    this.stats.totalRequests++;

    try {
      request.status = 'streaming';
      const result = await this.sendRequest(prompt, abortController.signal);

      // Only store if this is still the current request (not aborted/replaced)
      if (this.currentRequest === request) {
        request.result = result.output;
        request.tokensUsed = { input: result.inputTokens, output: result.outputTokens };
        request.status = 'completed';
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        request.status = 'aborted';
      } else {
        request.status = 'error';
        request.error = error.message;
        this.stats.errors++;
      }
    }
  }
}

// ==================== Singleton ====================

let globalEngine: SpeculativeEngine | null = null;

export function getSpeculativeEngine(): SpeculativeEngine {
  if (!globalEngine) {
    globalEngine = new SpeculativeEngine();
  }
  return globalEngine;
}

export function initSpeculativeEngine(config?: Partial<SpeculativeConfig>): SpeculativeEngine {
  globalEngine = new SpeculativeEngine(config);
  return globalEngine;
}
