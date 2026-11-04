import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

const USER_SCHEDULED_XML = /<(scheduled-task-fired|life-reminder-fired)>/;
/** 跟通知队列同一个上限口径, 别无限攒 */
const MAX_HELD = 20;

export class UserStopGate {
  private readonly stopped = new Set<string>();
  private readonly held = new Map<string, string[]>();
  private readonly internal = new Set<string>();

  /** abort 入口调: 运行时自己发起的中断不算 */
  onAbort(sessionId: string): void {
    if (!this.internal.has(sessionId)) this.stopped.add(sessionId);
  }

  /** 运行时自己的中断 (停滞兜底) —— 包在里面的 abort 不会被当成用户停止 */
  runInternalAbort(sessionId: string, fn: () => void): void {
    this.internal.add(sessionId);
    try { fn(); } finally { this.internal.delete(sessionId); }
  }

  /** 停着的会话: 把本该代用户起一轮的事件攒下, 返回 true 表示已拦下 (调用方别再起轮) */
  hold(sessionId: string, xml: string, source: string): boolean {
    if (!this.stopped.has(sessionId) || USER_SCHEDULED_XML.test(xml)) return false;
    const list = this.held.get(sessionId) ?? [];
    list.push(xml);
    if (list.length > MAX_HELD) list.splice(0, list.length - MAX_HELD);
    this.held.set(sessionId, list);
    cliLogger.info('BG_NOTIFIER', `session ${sessionId} stopped by user → hold ${source} event, no auto turn (${list.length} held)`);
    return true;
  }

  /** 用户亲自开口: 解除停止, 取走攒下的事件 */
  takeHeld(sessionId: string): string[] {
    this.stopped.delete(sessionId);
    const list = this.held.get(sessionId) ?? [];
    this.held.delete(sessionId);
    return list;
  }
}
