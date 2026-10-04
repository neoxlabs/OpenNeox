/**
 * AgentThreadContext — 防 task-agent 递归 fork 爆炸
 *
 * 场景:main agent 的 tool 执行里调 spawn_process / fork_taskagent /
 * backgroundManager.register → 任务 Agent 又能调同样的工具 → 无限递归 →
 * 瞬间几千 agent 占满 CPU/内存/API 配额。
 *
 * 设计:每层 agentLoop 在入口把自己的 depth 放进 AsyncLocalStorage。
 * spawn 入口读 ALS,检查 "parent depth + 1 <= MAX",否则抛错。
 * 任务 AgentLoop 被起来时在 async stack 里继承 ALS,但**会被自己的 enterDepth
 * 立即覆盖**(子的 depth = 传入的 config.threadDepth,不是 parent 的值)。
 *
 * 约定:
 *   · 顶层 main agent 的 depth = 0
 *   · task-agent 的 depth = parent.depth + 1
 *   · MAX 默认 3,超过需显式设 NEOX_MAX_AGENT_THREAD_DEPTH
 */

import { AsyncLocalStorage } from 'async_hooks';
import { getMaxThreadDepth } from '@neoxlabs/platform/runtime/agentRuntimeConfig.js';

const DEFAULT_MAX_THREAD_DEPTH = 3;

function readMaxDepthFromEnv(): number {
  return getMaxThreadDepth();
}

class AgentThreadContext {
  private readonly als = new AsyncLocalStorage<number>();

  /** agentLoop 入口调用,把自己的 depth 绑到 async 子树 */
  enterDepth(depth: number): void {
    this.als.enterWith(Math.max(0, Math.floor(depth)));
  }

  /** 读当前 agent 的 depth;没进入任何 agent 上下文时返回 0(视同 main) */
  getCurrentDepth(): number {
    return this.als.getStore() ?? 0;
  }

  /** 计算要起一个任务 Agent 时子的 depth(即 parent + 1)*/
  getNextChildDepth(): number {
    return this.getCurrentDepth() + 1;
  }

  /** 读取当前 MAX(每次读 env,便于测试时动态调)*/
  getMaxDepth(): number {
    return readMaxDepthFromEnv();
  }

  /**
   * spawn 入口调:若当前 depth + 1 超过 MAX,抛错。label 用于错误消息。
   * 返回的 childDepth 供调用方传给任务 AgentLoop 的 config.threadDepth。
   */
  checkCanSpawnOrThrow(label: string): number {
    const childDepth = this.getNextChildDepth();
    const max = this.getMaxDepth();
    if (childDepth > max) {
      throw new AgentThreadDepthExceededError(
        `Cannot spawn ${label}: would create a task-agent at thread depth ${childDepth}, ` +
          `exceeding NEOX_MAX_AGENT_THREAD_DEPTH=${max}. ` +
          `Raise the limit only if you're sure recursion is bounded.`,
        childDepth,
        max,
      );
    }
    return childDepth;
  }
}

export class AgentThreadDepthExceededError extends Error {
  readonly depth: number;
  readonly max: number;
  constructor(message: string, depth: number, max: number) {
    super(message);
    this.name = 'AgentThreadDepthExceededError';
    this.depth = depth;
    this.max = max;
  }
}

// ─── singleton ───
let globalCtx: AgentThreadContext | null = null;
export function getAgentThreadContext(): AgentThreadContext {
  if (!globalCtx) globalCtx = new AgentThreadContext();
  return globalCtx;
}

export function __resetAgentThreadContextForTest(): void {
  globalCtx = null;
}

export { DEFAULT_MAX_THREAD_DEPTH };
