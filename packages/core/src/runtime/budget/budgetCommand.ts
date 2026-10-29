/**
 * 会话预算的跨进程入口 —— 桌面端主进程经 bridge 打到跑 agent 的那条线程 (预算账本只在那里有)。
 *   get   → 当前快照 (没设预算返回 null)
 *   set   → 设 / 改预算, 返回快照
 *   clear → 关掉预算
 */
import { getBudgetSnapshot, setSessionBudget, type BudgetSnapshot, type SessionBudgetConfig } from './sessionBudget.js';

export type BudgetCommand = 'get' | 'set' | 'clear';

export function budgetCommand(sessionId: string, cmd: BudgetCommand, config?: SessionBudgetConfig): BudgetSnapshot | null {
  if (!sessionId) return null;
  if (cmd === 'set' && config) return setSessionBudget(sessionId, config);
  if (cmd === 'clear') return setSessionBudget(sessionId, null);
  return getBudgetSnapshot(sessionId);
}
