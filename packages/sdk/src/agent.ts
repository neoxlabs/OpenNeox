/**
 * Neox Agent SDK · Agent class
 *
 * 3-行 hello-world 入口.底层直接走 @openneox/core 的 RuntimeOrchestrator,
 * 不经过 server/client 层,也不套 AgenticRuntime —— SDK 用户拿到的是纯净的
 * agent loop,不会被 Neox 专属的 taskagent / project-memory / background 等机制干扰.
 *
 * 版本节点:
 *   - v0.0.0-alpha: 仅类型契约 + stub(抛 NotImplemented)
 *   - v0.3.0: run() / stream() 真实现,可跑通 tool-calling
 */

import type { AnyNeoxSdkTool } from './tool.js';
import type { ProviderConfig } from './provider.js';
import type {
  AgentEvent,
  AgentEventHandler,
  PermissionMode,
  ThinkingMode,
  TokenUsage,
  StopReason,
  Step,
  Message,
} from './types.js';

export interface AgentConfig {
  /** 模型 id,如 'claude-sonnet-4-6' / 'gpt-4o' / 'deepseek-chat' */
  model: string;
  /** 系统提示词 */
  systemPrompt?: string | (() => string | Promise<string>);
  /** Tool 列表 */
  tools?: AnyNeoxSdkTool[];
  /** LLM provider 配置,省略则从环境变量推断 */
  provider?: ProviderConfig;
  /** 扩展思考(thinking)模式 */
  thinking?: ThinkingMode;
  /** 每次 run 的最大步数,防失控(默认 50) */
  maxSteps?: number;
  /** 权限模式 */
  permission?: PermissionMode;
  /** 事件回调(流式中实时触发) */
  onEvent?: AgentEventHandler;
  /** 外部 AbortSignal */
  signal?: AbortSignal;
}

/**
 * `agent.stream()` 的返回值: 一个事件流, 外加最终结果与中止入口.
 */
export interface AgentStream extends AsyncIterableIterator<AgentEvent> {
  /** 等这一轮跑完, 拿完整的 AgentResult (text / usage / steps / messages / stopReason) */
  result(): Promise<AgentResult>;
  /** 中止这一轮; 等价于 agent.abort() */
  abort(): void;
}

export interface AgentResult {
  text: string;
  usage: TokenUsage;
  steps: Step[];
  messages: Message[];
  stopReason: StopReason;
}

export class Agent {
  readonly config: AgentConfig;
  private internalAbort: AbortController | null = null;

  constructor(config: AgentConfig) {
    if (!config.model) throw new Error('Agent: config.model is required');
    this.config = config;
  }

  /**
   * 非流式执行:等整轮 agent loop 结束,一次性返回 text + usage + messages.
   */
  async run(prompt: string): Promise<AgentResult> {
    const { runAgent } = await import('./core/runAgent.js');
    return runAgent(this.withAbortSignal(), prompt);
  }

  /**
   * 流式执行: 返回的对象既能 `for await`, 也能 `await stream.result()` 拿最终结果.
   *
   * 流对象同时保留事件迭代和最终结果能力，调用方无需自行拼接 delta:
   *
   *   const s = agent.stream(prompt);
   *   for await (const ev of s) render(ev);
   *   const { text, usage, messages } = await s.result();
   */
  stream(prompt: string): AgentStream {
    let settle!: (r: AgentResult) => void;
    let reject!: (e: unknown) => void;
    const done = new Promise<AgentResult>((res, rej) => {
      settle = res;
      reject = rej;
    });
    /* result() 可能没人 await —— 挂一个空 catch, 免得 Node 报 unhandled rejection */
    done.catch(() => {});

    const self = this;
    const iterator = (async function* (): AsyncGenerator<AgentEvent> {
      const { runAgent } = await import('./core/runAgent.js');
      const queue: AgentEvent[] = [];
      let resolveNext: ((ev: AgentEvent | null) => void) | null = null;
      let finished = false;
      let error: unknown = null;

      const push = (ev: AgentEvent) => {
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r(ev);
        } else {
          queue.push(ev);
        }
      };

      const runPromise = runAgent(self.withAbortSignal(), prompt, {
        onEvent: (ev) => push(ev),
      })
        .then((result) => {
          settle(result);
          return result;
        })
        .catch((err) => {
          error = err;
          reject(err);
          return null;
        })
        .finally(() => {
          finished = true;
          if (resolveNext) {
            const r = resolveNext;
            resolveNext = null;
            r(null);
          }
        });

      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (finished) break;
        const next = await new Promise<AgentEvent | null>((resolve) => {
          resolveNext = resolve;
        });
        if (next === null) break;
        yield next;
      }

      await runPromise;
      if (error) throw error;
    })();

    /* 同时暴露 next/return/throw，保持标准异步迭代器的直接调用方式。 */
    return {
      [Symbol.asyncIterator]: () => iterator,
      next: (...args) => iterator.next(...(args as [])),
      return: (value?: unknown) => iterator.return(value as never),
      throw: (err?: unknown) => iterator.throw(err),
      result: () => done,
      abort: () => self.abort(),
    };
  }

  /** 主动中止当前 run/stream. */
  abort(): void {
    this.internalAbort?.abort();
  }

  /** 将用户 signal 与内部 signal 合并,让 abort() 能同时生效. */
  private withAbortSignal(): AgentConfig {
    this.internalAbort = new AbortController();
    const userSignal = this.config.signal;
    if (!userSignal) {
      return { ...this.config, signal: this.internalAbort.signal };
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (userSignal.aborted) controller.abort();
    else userSignal.addEventListener('abort', onAbort, { once: true });
    this.internalAbort.signal.addEventListener('abort', onAbort, { once: true });
    return { ...this.config, signal: controller.signal };
  }
}
