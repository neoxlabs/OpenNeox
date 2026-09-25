/**
 * BackgroundTaskNotifier — agent 自主感知后台 shell 任务完成
 *
 * 灵感来源:Claude Code 的 <task-notification> XML 注入机制。
 *
 * 工作方式:
 *   1. agentLoop 启动时通过 runWithSession(processId, fn) 进入带 session 标记的 async 上下文
 *   2. 该 session 内起的后台 bash 命令,在 spawn 时调用 trackPid(pid, command)
 *      → notifier 绑定 pid ↔ sessionId
 *   3. processManager emit 'process:exit' / 'process:kill' →
 *      notifier 找到对应 session,生成 <background-task-notification> XML 入队
 *   4. agentLoop 每轮调用 LLM 前 drainForSession(sessionId),把 XML 作为 user message 注入
 *   5. LLM 在 system prompt 里被教过:看到这个 XML = 后台任务完成,
 *      需要时用 bash_output(pid) 读输出,不需要则继续。
 *
 * 为什么用 AsyncLocalStorage:
 *   bash tool 是全局 singleton,不能在 closure 里捕获 sessionId。ALS 让 tool.call()
 *   透明地拿到当前 agentLoop 的 sessionId,不需要改 Tool 接口签名。
 */

import { AsyncLocalStorage } from 'async_hooks';
import { EventEmitter } from 'events';
import type { ProcessManager, TrackedProcess } from '@neoxlabs/platform/platform/processManager.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { sendOsNotification } from '@neoxlabs/platform/platform/osNotifier.js';
import { getCurrentChatSessionId } from './chatSessionContext.js';
import { appendDiagLog } from '../agent/diagLogFile.js';

export interface BackgroundTaskNotification {
  xml: string;
  pid: number;
  command: string;
  status: 'completed' | 'failed' | 'killed';
  exitCode?: number;
  /** 谁触发了进程退出. undefined = 进程自己挂的 (crash / 正常退出, 没人调 kill).
   *  'user'   = 用户从 UI Stop 按钮停的
   *  'agent'  = LLM agent 调 bash_kill tool 停的
   *  'system' = onBeforeShutdown / auto-restart / OS OOM 等系统行为
   * 用来让 agent 回复时分辨 "是你/我停的" vs "进程自己挂了". */
  terminatedBy?: 'user' | 'agent' | 'system';
  enqueuedAt: number;
}

interface TrackedEntry {
  sessionId: string;
  /** 从 chatSessionContext ALS 拿到的稳定 chat sessionId — agentLoop 内 trackPid
   *  时 sessionAls 通常存的是 processId / 'main' 这类 agentLoop 内部标识, 不能
   *  直接拿来 bridge.chat 触发 auto-resume. trackPid 时一并捕获 chat sessionId
   *  存这里, handleTerminate 用它代用户起新一轮. 没拿到就 fallback 到 sessionId. */
  chatSessionId?: string;
  command: string;
  trackedAt: number;
}

const NOTIFICATION_TAG = 'background-task-notification';

/**
 * 后台任务完成时, server 注册的"代用户起新 chat"回调.
 * 没注册时退化成纯 enqueue, 等下次用户手动发消息才会 drain. 跟 scheduledWakeupRegistry
 * 同套机制. server.main.ts 启动时挂上.
 */
export type BgTaskAutoResumeHandler = (input: {
  sessionId: string;
  xml: string;
  command: string;
  status: BackgroundTaskNotification['status'];
  /** 谁停的: 'user' = 用户从面板/Stop 主动停 → 不该自动起一轮汇报 (用户自己干的, 已知) */
  terminatedBy?: 'user' | 'agent' | 'system';
}) => void | Promise<void>;

let autoResumeHandler: BgTaskAutoResumeHandler | null = null;
let isSessionActiveCheck: ((sessionId: string) => boolean) | null = null;

export function setBgTaskAutoResumeHandler(cb: BgTaskAutoResumeHandler | null): void {
  autoResumeHandler = cb;
}

export function setBgTaskSessionActiveCheck(cb: ((sessionId: string) => boolean) | null): void {
  isSessionActiveCheck = cb;
}

export class BackgroundTaskNotifier extends EventEmitter {
  private pidToSession = new Map<number, TrackedEntry>();
  private sessionToNotifs = new Map<string, BackgroundTaskNotification[]>();
  private readonly sessionAls = new AsyncLocalStorage<string>();
  private readonly maxPerSession: number;
  private subscribed = false;
  private _autoResumePending = new Map<string, boolean>();
  private _autoResumeDebounce = new Map<string, NodeJS.Timeout>();

  constructor(maxPerSession = 20) {
    super();
    this.maxPerSession = maxPerSession;
  }

  /** 订阅 processManager 事件(幂等)*/
  attach(pm: ProcessManager): void {
    if (this.subscribed) return;
    this.subscribed = true;
    pm.on('process:exit', (proc: TrackedProcess) => this.handleTerminate(proc));
    pm.on('process:kill', (proc: TrackedProcess) => this.handleTerminate(proc));
    cliLogger.debug('BG_NOTIFIER', 'Attached to processManager events');
  }

  /** 在指定 sessionId 的 async 上下文中执行 fn,fn 期间触发的 trackPid() 都会归属该 session */
  runWithSession<T>(sessionId: string, fn: () => T): T {
    return this.sessionAls.run(sessionId, fn);
  }

  /**
   * 把 sessionId 绑定到当前 async 子树(无需包 callback)。
   * 推荐在 agentLoop 入口一次性调用,后续的 tool.function 调用都能通过
   * getCurrentSessionId() 拿到同一个 sid。
   *
   * 语义:只影响**当前 async context 的后续代码及其异步后代**,
   * 不会泄漏到并发的其他 async context(例如另一个并发的 agentLoop 调用)。
   */
  enterSession(sessionId: string): void {
    this.sessionAls.enterWith(sessionId);
  }

  /** 登记一个 pid 属于当前 async 上下文的 session。无 session 时静默忽略.
   *  同时捕获 chat sessionId(从 chatSessionContext ALS), 给 handleTerminate
   *  做 auto-resume 时用 — bridge.chat 要的是 chat 维度而不是 agentLoop processId.
   *
   *  ALS fallback (修 BG_NOTIFIER 全程失效的核心 bug):
   *    agentLoop 在入口 `bgTaskNotifier.enterSession(processId)`, 用 `enterWith` 在
   *    当前 async resource 注入 store. 但实践中 tool 调用穿过 promise 链 / await /
   *    runtime tool dispatcher 后, 这个 ALS 经常拿不到 store —— 实际日志全是
   *    "trackPid outside session context, ignored", 导致 pidToSession 永远空,
   *    notifyTerminated 全部"未追踪 跳过", agent 永远不会被进程退出唤醒.
   *
   *    chatSessionContext 那个 ALS 在 `bridge.chat` 入口用 `runWithChatSession`
   *    包了整个 chat lifecycle (`als.run`, 不是 enterWith), 能稳定传到 tool 调用.
   *    `sessionAls` miss 时用 chatSessionId 兜底, BG_NOTIFIER 重新工作. */
  trackPid(pid: number, command: string): void {
    const chatSessionId = getCurrentChatSessionId();
    let sessionId = this.sessionAls.getStore();
    let usedFallback = false;
    if (!sessionId) {
      sessionId = chatSessionId;
      usedFallback = true;
    }
    if (!sessionId) {
      cliLogger.debug('BG_NOTIFIER', `trackPid(${pid}) no session in any ALS, ignored`);
      return;
    }
    this.pidToSession.set(pid, { sessionId, chatSessionId, command, trackedAt: Date.now() });
    cliLogger.info('BG_NOTIFIER',
      `Tracked pid ${pid} for session ${sessionId}${chatSessionId && chatSessionId !== sessionId ? ` (chat=${chatSessionId})` : ''}${usedFallback ? ' [via chat fallback]' : ''}`);
  }

  listLiveForSession(sessionId: string): Array<{ pid: number; command: string }> {
    const out: Array<{ pid: number; command: string }> = [];
    for (const [pid, entry] of this.pidToSession) {
      if (entry.sessionId !== sessionId && entry.chatSessionId !== sessionId) continue;
      try {
        process.kill(pid, 0);
      } catch {
        continue; // 已经不在了
      }
      out.push({ pid, command: entry.command });
    }
    return out;
  }

  ownerSessionOf(pid: number): string | null {
    return this.pidToSession.get(pid)?.sessionId ?? null;
  }

  /* ── 「转正」登记簿 ────────────────────────────────────────────────
   * 默认所有后台任务都是**会话级临时**的 —— 跑完就走, 不该出现在别的会话里。
   * 只有用户显式确认过的才升成工程级常驻 (跨会话可见)。
   *
   * 刻意**不**按端口/config_id/存活时长这类启发式自动晋升: 那是在猜用户意图,
   * 而不同功能的意图并不一样 —— 一个跑三分钟的构建照样占端口、照样活很久,
   * 但它不是"服务"。参照 IDEA: 启动的一切默认临时, 手动转正才常驻。
   *
   * 用 pid 作键、只存内存: 进程本身就是临时的, 没了就没了, 不需要跨重启记忆。
   * serviceAdoptTool 接管外部进程本身就是用户显式动作, 由调用方直接登记。 */
  private promotedPids = new Set<number>();

  /** 用户确认把这个后台任务转正为工程级常驻 (跨会话可见). */
  promotePid(pid: number): void {
    this.promotedPids.add(pid);
    cliLogger.info('BG_NOTIFIER', `pid ${pid} promoted to project-level (user confirmed)`);
  }

  /** 撤销转正 —— 回到"只在自己会话里可见". */
  demotePid(pid: number): void {
    this.promotedPids.delete(pid);
  }

  isPromoted(pid: number): boolean {
    return this.promotedPids.has(pid);
  }

  /** 手动取消 pid 追踪(例如命令被用户提前 kill 且不希望通知)*/
  untrackPid(pid: number): void {
    this.pidToSession.delete(pid);
    /* pid 会被系统复用 —— 不清掉的话, 新进程会白捡上一个进程的"已转正"身份 */
    this.promotedPids.delete(pid);
  }

  /**
   * 直接通知一个 pid 已完成 — 当 bash 子进程不在 processManager.processes map 里时
   * (背景: bash 是 commandHelperClient 启的 OS pid, 不走 processManager.start/spawn,
   *  所以 markCompleted 对它是 noop, 不发 process:exit, attach 监听永远收不到).
   *
   * backgroundShellExecution.handleExit 调这个方法直接喂事件, 跟 process:exit 走一样的处理流程.
   */
  notifyTerminated(pid: number, exitCode?: number, killed = false): void {
    const entry = this.pidToSession.get(pid);
    if (!entry) {
      cliLogger.debug('BG_NOTIFIER', `notifyTerminated(pid=${pid}) 未追踪, 跳过`);
      return;
    }
    /* 复用 handleTerminate 同一套出口, 但传一个最小 TrackedProcess 形态 */
    this.handleTerminate({
      pid,
      command: entry.command,
      status: killed ? 'killed' : (exitCode === 0 ? 'completed' : 'failed'),
      exitCode,
      background: true,
    } as any);
  }

  /** 当前 session 是否有待消费通知 */
  hasNotificationsFor(sessionId: string): boolean {
    const list = this.sessionToNotifs.get(sessionId);
    return !!list && list.length > 0;
  }

  /** 取出并清空 session 的所有通知 */
  drainForSession(sessionId: string): BackgroundTaskNotification[] {
    const list = this.sessionToNotifs.get(sessionId);
    if (!list || list.length === 0) return [];
    this.sessionToNotifs.delete(sessionId);
    return list;
  }

  acknowledgeExit(pid: number): void {
    for (const [sid, list] of this.sessionToNotifs) {
      const rest = list.filter(n => n.pid !== pid);
      if (rest.length === list.length) continue;
      if (rest.length) this.sessionToNotifs.set(sid, rest);
      else this.sessionToNotifs.delete(sid);
    }
    if (this.pidToSession.has(pid)) this.acknowledgedPids.add(pid);
  }
  private acknowledgedPids = new Set<number>();

  /** 检查本 async 上下文所属 session(debug 用)*/
  getCurrentSessionId(): string | undefined {
    return this.sessionAls.getStore();
  }

  /**
   * 外部模块(如 ScheduledWakeupRegistry)直接往某个 session 投递一条 XML 通知。
   * 语义和 bash 后台完成通知完全一样:下轮 agentLoop 开始前,drainForSession 会把它
   * 作为 user message 前缀注入。
   *
   * xml 应该是单块 `<xxx>...</xxx>` 字符串,由调用方负责格式化。
   * command 和 pid 是可选的 telemetry 字段(0 表示无关联进程)。
   */
  enqueueMessageForSession(
    sessionId: string,
    xml: string,
    opts: {
      command?: string;
      pid?: number;
      status?: BackgroundTaskNotification['status'];
      exitCode?: number;
      terminatedBy?: 'user' | 'agent' | 'system';
      /** 只入队, 不代用户起一轮 chat。中断场景必须用它 —— 用户刚按了停止,
       *  autoResume 再拉起一轮就是"停不下来"。留给下一轮真正的用户消息带出去。 */
      noAutoResume?: boolean;
    } = {},
  ): void {
    const notif: BackgroundTaskNotification = {
      xml,
      pid: opts.pid ?? 0,
      command: opts.command ?? '',
      status: opts.status ?? 'completed',
      exitCode: opts.exitCode,
      terminatedBy: opts.terminatedBy,
      enqueuedAt: Date.now(),
    };
    const list = this.sessionToNotifs.get(sessionId) ?? [];
    list.push(notif);
    if (list.length > this.maxPerSession) {
      list.splice(0, list.length - this.maxPerSession);
    }
    this.sessionToNotifs.set(sessionId, list);
    this.emit('notification', { sessionId, notif });

    /* 关键 — 通知到达时, agentLoop 大概率已经退出了(模型说"我安排好了"就 break).
       光把 XML 塞队列等下次用户手动发消息才能 drain — 用户体验是"agent 永远不
       回话". server 启动时注册 autoResumeHandler 后, 这里同步调它代用户起一轮
       chat, 把 XML 当 prompt 喂进去. 与 scheduledWakeupRegistry 同套机制. */
    cliLogger.info('BG_NOTIFIER',
      `enqueue session=${sessionId} pid=${notif.pid} status=${notif.status} hasAutoResume=${!!autoResumeHandler}`);
    appendDiagLog('BG_NOTIFIER/enqueue', {
      sessionId, pid: notif.pid, status: notif.status, command: notif.command,
      hasAutoResume: !!autoResumeHandler,
    });
    if (autoResumeHandler && !opts.noAutoResume) {
      if (this._autoResumePending.get(sessionId) || this._autoResumeDebounce.has(sessionId)) {
        return;
      }
      /* 延迟 1s 收集同批完成的 agent, 然后检查 session 是否 idle 再触发 */
      const timer = setTimeout(() => {
        this._autoResumeDebounce.delete(sessionId);
        void this._runAutoResume(sessionId);
      }, 1000);
      this._autoResumeDebounce.set(sessionId, timer);
    }
  }

  /** 主 agent 在跑时等 idle 再触发 autoResume, 不打断当前 iteration */
  private async _runAutoResume(sessionId: string): Promise<void> {
    if (this._autoResumePending.get(sessionId)) return;

    /* 如果 session 还在跑, 等它 idle (最多 60s, 每 500ms 检查) */
    if (isSessionActiveCheck?.(sessionId)) {
      cliLogger.info('BG_NOTIFIER', `session ${sessionId} active, waiting for idle before auto-resume`);
      let waited = 0;
      while (isSessionActiveCheck(sessionId) && waited < 60000) {
        await new Promise(r => setTimeout(r, 500));
        waited += 500;
      }
      /* idle 后再收集一次 — 等待期间可能有更多 agent 完成 */
    }

    this._autoResumePending.set(sessionId, true);
    try {
      const notifications = this.drainForSession(sessionId);
      if (notifications.length === 0) {
        this._autoResumePending.delete(sessionId);
        return;
      }
      const combinedXml = notifications.map(n => n.xml).join('\n');
      appendDiagLog('BG_NOTIFIER/autoResume:invoke', { sessionId, count: notifications.length });
      await autoResumeHandler!({ sessionId, xml: combinedXml, command: notifications[0].command, status: notifications[0].status, terminatedBy: notifications[0].terminatedBy });
    } catch (err: any) {
      cliLogger.warn('BG_NOTIFIER', `autoResumeHandler failed: ${err?.message ?? err}`);
    } finally {
      this._autoResumePending.delete(sessionId);
      const remaining = this.sessionToNotifs.get(sessionId);
      if (remaining && remaining.length > 0) {
        setTimeout(() => void this._runAutoResume(sessionId), 500);
      }
    }
  }

  /** 列出某 session 仍在追踪的 pid(进程可能已退出,但 exit 事件尚未触发时仍占位)*/
  listTrackedPidsForSession(sessionId: string): Array<{ pid: number; command: string }> {
    const entries: Array<{ pid: number; command: string }> = [];
    for (const [pid, info] of this.pidToSession) {
      if (info.sessionId === sessionId) {
        entries.push({ pid, command: info.command });
      }
    }
    return entries;
  }

  /**
   * 清理某 session 仍在追踪的所有 pid。
   * 典型用途:task-agent 退出时调用,防止 worker 起的后台 bash 进程成为孤儿。
   * 返回真正被要求终止的 pid 列表。
   */
  cleanupTrackedPidsForSession(
    sessionId: string,
    pm: { get: (pid: number) => { status: string; background?: boolean } | undefined;
          kill: (pid: number, signal?: NodeJS.Signals, force?: boolean) => boolean;
          killProcessGroup: (pid: number, signal?: NodeJS.Signals) => boolean; },
    reason = 'session-exit',
  ): number[] {
    const killed: number[] = [];
    for (const [pid, info] of [...this.pidToSession]) {
      if (info.sessionId !== sessionId) continue;
      this.pidToSession.delete(pid);
      const proc = pm.get(pid);
      if (!proc || proc.status !== 'running') continue;
      // 后台进程起时是 detached+process group,用 killProcessGroup 更彻底
      const ok = proc.background
        ? pm.killProcessGroup(pid, 'SIGTERM')
        : pm.kill(pid, 'SIGTERM', /* escalate to SIGKILL after 2s */ true);
      if (ok) {
        killed.push(pid);
        cliLogger.info('BG_NOTIFIER', `cleanup(${reason}): killed orphaned pid=${pid} cmd=${info.command.slice(0, 60)}`);
      }
    }
    // 同时清掉该 session 遗留的未消费通知(agent 已经不在了,没意义保留)
    this.sessionToNotifs.delete(sessionId);
    return killed;
  }

  private handleTerminate(proc: TrackedProcess): void {
    const entry = this.pidToSession.get(proc.pid);
    if (!entry) return;
    this.pidToSession.delete(proc.pid);
    if (this.acknowledgedPids.delete(proc.pid)) return; /* agent 已经看过它的结局 (acknowledgeExit) */

    const status: BackgroundTaskNotification['status'] =
      proc.status === 'killed' ? 'killed'
        : proc.status === 'failed' ? 'failed'
        : 'completed';
    const terminatedBy = proc.terminatedBy; /* 'user'/'agent'/'system'/undefined */

    /* auto-resume 必须用 chat sessionId — bridge.chat 那边按 chat 维度索引
       lastChatMetaBySession. agentLoop 的 sessionAls 存的是 processId/'main',
       拿那个去 bridge.chat 会被 'unknown session' 拒绝, 30s 后 agent 不回话.
       fallback: 没捕获到 chat sessionId 时还是用 sessionAls 那个, 至少 loop
       还活着的情况下 drainForSession 能走. */
    const targetSessionId = entry.chatSessionId || entry.sessionId;
    cliLogger.info(
      'BG_NOTIFIER',
      `pid=${proc.pid} ${status} (exit=${proc.exitCode ?? 'n/a'} by=${terminatedBy ?? 'self'}) → enqueue for chat session ${targetSessionId}`,
    );

    const xml = this.buildXml(proc.pid, entry.command, status, proc.exitCode, terminatedBy);
    this.enqueueMessageForSession(targetSessionId, xml, {
      command: entry.command,
      pid: proc.pid,
      status,
      exitCode: proc.exitCode,
      terminatedBy,
    });

    const truncCmd = entry.command.length > 80 ? entry.command.slice(0, 80) + '…' : entry.command;
    const urgency = status === 'failed' ? 'error' : status === 'killed' ? 'warning' : 'success';
    const titlePrefix = (() => {
      if (terminatedBy === 'user')  return `⊘ Stopped by you`;
      if (terminatedBy === 'agent') return `⊘ Stopped by agent`;
      if (status === 'completed')   return `✓ Background bash done`;
      if (status === 'failed')      return `✗ Background bash failed`;
      return `⊘ Background bash killed`;
    })();
    void sendOsNotification({
      title: `${titlePrefix} (pid ${proc.pid}${typeof proc.exitCode === 'number' ? `, exit ${proc.exitCode}` : ''})`,
      body: truncCmd,
      urgency,
      sound: status === 'failed' ? 'Basso' : status === 'completed' ? 'Glass' : undefined,
    });
  }

  private buildXml(
    pid: number,
    command: string,
    status: string,
    exitCode: number | undefined,
    terminatedBy: 'user' | 'agent' | 'system' | undefined,
  ): string {
    const exitLine = typeof exitCode === 'number' ? `\n<exit-code>${exitCode}</exit-code>` : '';
    const byLine = terminatedBy ? `\n<terminated-by>${terminatedBy}</terminated-by>` : '';
    // 截断 command 避免巨长命令污染 XML
    const displayCommand = command.length > 200 ? `${command.slice(0, 200)}...` : command;
    const summary = (() => {
      if (terminatedBy === 'user') {
        return `User stopped this task via UI. Don't say "it exited on its own" or "it crashed" — say "you stopped it" / "已按你的要求停了" / etc. ${typeof exitCode === 'number' ? `exit code ${exitCode}.` : ''}`;
      }
      if (terminatedBy === 'agent') {
        return `You (the agent) stopped this task earlier via \`bash_kill\`. ${typeof exitCode === 'number' ? `exit code ${exitCode}.` : ''}`;
      }
      if (terminatedBy === 'system') {
        return `System-triggered stop (shutdown / auto-restart / OS signal). Not user-initiated. ${typeof exitCode === 'number' ? `exit code ${exitCode}.` : ''}`;
      }
      /* undefined = self-exit */
      if (status === 'completed') {
        return `Process exited on its own with code 0. No one called kill. ${typeof exitCode === 'number' ? `exit ${exitCode}.` : ''} If user asks "did it crash" — no, it exited normally.`;
      }
      if (status === 'failed') {
        return `Process exited on its own with non-zero code (${exitCode ?? '?'}) — this is a crash / startup failure, NOT a user stop. Diagnose the cause. Use \`bash_output(${pid})\` to read its output.`;
      }
      return `Background shell task (pid=${pid}) ${status}${typeof exitCode === 'number' ? ` with exit code ${exitCode}` : ''}. Use \`bash_output\` to read its output.`;
    })();
    return `<${NOTIFICATION_TAG}>
<pid>${pid}</pid>
<command>${escapeXml(displayCommand)}</command>
<status>${status}</status>${exitLine}${byLine}
<summary>${escapeXml(summary)}</summary>
</${NOTIFICATION_TAG}>`;
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ============================================================================
// Singleton
// ============================================================================

let globalNotifier: BackgroundTaskNotifier | null = null;

export function getBackgroundTaskNotifier(): BackgroundTaskNotifier {
  if (!globalNotifier) {
    globalNotifier = new BackgroundTaskNotifier();
  }
  return globalNotifier;
}

/** 测试钩子 */
export function __resetBackgroundTaskNotifierForTest(): void {
  globalNotifier = null;
}

export const BACKGROUND_TASK_NOTIFICATION_TAG = NOTIFICATION_TAG;
