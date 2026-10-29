/**
 * SessionWorkState — 「这条会话还有没有活没落地」。
 *
 * 一次性宿主 (`neox -p`) 跑完第一轮不能立刻退: 模型把长命令放到后台、说一句
 * 「完成后会通知我」就结束本轮时, 后台任务结束时由 BackgroundTaskNotifier 把
 * `<background-task-notification>` 补进收件箱, server 那边的 post-turn drain /
 * autoResume 会拿它再起一轮 —— 交互模式靠这条链路一直干到结束, 一次性宿主以前
 * 在这里直接 dispose 进程, 那些轮连事件都吐不出来。
 *
 * 这个模块只回答「现在还能不能退」, 不自己发通知、不自己起轮:
 *   有活 → 宿主继续等 (复用同一条通知 → 下一轮的链路)
 *   都闲了 → 宿主正常收尾
 *
 * 为什么要看四级信号 (缺一级就会提前收工):
 *   · activeChat                —— 正在跑的那一轮 (含后台通知补起的轮)
 *   · pendingNotifications      —— 通知已入队但还没被下一轮消费
 *   · trackedBackgroundProcesses —— 进程还挂在追踪表里。**故意不用 kill(pid,0) 复核**:
 *                                  进程刚退出、exit 事件还没送到的那一瞬间, 它已经不活了但
 *                                  通知也还没入队, 只有追踪表能看见这段空档。
 *   · runningSubAgents          —— 后台子 agent 是内存里的 promise, 没有 pid。
 */

import { getBackgroundTaskNotifier } from './backgroundTaskNotifier.js';
import { hasRunningSubAgents } from '../agent/backgroundAgent.js';

export interface SessionWorkState {
  /** 当前有没有一轮 chat 在跑 (含 post-turn drain / autoResume 补起的那一轮) */
  activeChat: boolean;
  /** 收件箱里还有没被下一轮消费的后台完成通知 */
  pendingNotifications: boolean;
  /** 仍挂在追踪表里的后台进程数 (sessionId 或 chatSessionId 归属都算) */
  trackedBackgroundProcesses: number;
  /** 这条会话起的后台子 agent 还在跑 */
  runningSubAgents: boolean;
}

/** 四级信号里任意一级亮着 = 还不能收工。 */
export function isSessionWorkPending(state: SessionWorkState): boolean {
  return state.activeChat
    || state.pendingNotifications
    || state.trackedBackgroundProcesses > 0
    || state.runningSubAgents;
}

/**
 * 采样一次会话活动。
 *
 * @param activeChat 由宿主 (server / LocalRuntimeAdapter) 提供 —— 活跃轮是 server 级的
 *                   状态 (activeSessions), notifier 看不到。
 */
export function getSessionWorkState(sessionId: string, activeChat: boolean): SessionWorkState {
  const notifier = getBackgroundTaskNotifier();
  return {
    activeChat,
    pendingNotifications: notifier.hasNotificationsFor(sessionId),
    trackedBackgroundProcesses: notifier.trackedCountForSession(sessionId),
    runningSubAgents: hasRunningSubAgents(sessionId),
  };
}
