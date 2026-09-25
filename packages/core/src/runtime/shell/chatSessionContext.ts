/** Stores the chat session id for the duration of bridge.chat() and nested calls.
 *
 * Unlike process-scoped task context, this value stays stable for tools that schedule a future user turn.
 *   · bgTaskNotifier 那个 ALS 在 agentLoop 入口被覆写成 processId(任务 Agent / pid),
 *     工具读到的是 process-scope 的 id, 不一定等于 chat sessionId。
 *   · 本模块的 ALS 在 bridge.chat() 入口设置一次, agentLoop / 子调用都不覆写,
 *     工具(如 schedule_wakeup)需要"60 秒后代用户起一轮"时, 从这里拿稳定的
 *     chat sessionId, 用 bridge.chat(sessionId, ...) 触发新 turn。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { setNeoxSessionProvider } from '@neoxlabs/kernel';

const chatSessionAls = new AsyncLocalStorage<string>();

setNeoxSessionProvider(() => chatSessionAls.getStore());

export function runWithChatSession<T>(sessionId: string, fn: () => T): T {
  return chatSessionAls.run(sessionId, fn);
}

export function getCurrentChatSessionId(): string | undefined {
  return chatSessionAls.getStore();
}
