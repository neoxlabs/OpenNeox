/**
 * Prefetch memory or skill data while tool execution is in progress, then
 * expose the settled value to the next model request.
 */

import { cliLogger } from '../platform/cliLogger.js';

export interface PrefetchResult<T> {
  data: T | null;
  settledAt: number | null;  // 完成时间戳
  startedAt: number;
  error?: string;
}

/**
 * 通用异步预取器
 * 在工具执行开始时启动，在下一轮 LLM 调用前消费结果
 */
export class PrefetchManager<T> {
  private pending: Promise<T | null> | null = null;
  private result: PrefetchResult<T> | null = null;
  private consumed = false;
  private label: string;

  constructor(label: string) {
    this.label = label;
  }

  /**
   * 启动预取任务（fire-and-forget）
   * 如果已有正在执行的预取，忽略新请求
   */
  start(fetcher: () => Promise<T | null>): void {
    if (this.pending && !this.result) {
      // 已有进行中的预取，跳过
      return;
    }

    this.consumed = false;
    this.result = null;
    const startedAt = Date.now();

    this.pending = fetcher()
      .then(data => {
        this.result = {
          data,
          settledAt: Date.now(),
          startedAt,
        };
        const latency = Date.now() - startedAt;
        cliLogger.debug('Prefetch', `${this.label} settled in ${latency}ms`);
        return data;
      })
      .catch(error => {
        this.result = {
          data: null,
          settledAt: Date.now(),
          startedAt,
          error: error?.message || 'unknown',
        };
        cliLogger.debug('Prefetch', `${this.label} failed: ${error?.message}`);
        return null;
      });
  }

  /**
   * 消费预取结果（只能消费一次）
   * 如果预取尚未完成，await 等待
   */
  async consume(): Promise<T | null> {
    if (this.consumed) return null;
    if (!this.pending) return null;

    this.consumed = true;
    const data = await this.pending;
    this.pending = null;

    if (this.result?.settledAt && this.result.startedAt) {
      const latency = this.result.settledAt - this.result.startedAt;
      cliLogger.debug('Prefetch', `${this.label} consumed (latency=${latency}ms, hidden=${this.result.error ? 'error' : 'ok'})`);
    }

    return data;
  }

  /** 是否有待消费的结果 */
  get hasPending(): boolean {
    return this.pending !== null && !this.consumed;
  }

  /** 预取是否已完成（不阻塞检查） */
  get isSettled(): boolean {
    return this.result !== null;
  }

  /** 重置状态 */
  reset(): void {
    this.pending = null;
    this.result = null;
    this.consumed = false;
  }
}

/**
 * 上下文相关记忆预取结果
 */
export interface MemoryPrefetchData {
  relevantMemories: string[];
  contextHints: string[];
}

/**
 * 技能发现预取结果
 */
export interface SkillPrefetchData {
  activatedSkills: string[];
  deactivatedSkills: string[];
}

/**
 * 创建 Runner 级别的预取管理器组
 */
export function createRunnerPrefetchers() {
  return {
    memory: new PrefetchManager<MemoryPrefetchData>('MemoryPrefetch'),
    skill: new PrefetchManager<SkillPrefetchData>('SkillPrefetch'),
  };
}
