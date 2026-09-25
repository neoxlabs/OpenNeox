/**
 * ScheduledWakeupRegistry — agent 自主 pacing 支持。
 *
 * 灵感来源:Claude Code 的 ScheduleWakeup。Agent 主动声明"我打算 N 秒后
 * 再回来看",runtime 负责到点把一条 user message 塞进 agentLoop。
 *
 * 设计点:
 *   · 一次性(one-shot) — 触发一次即失效;不做 cron 循环(那是 CronCreate 的职责)
 *   · session-scoped — 每个 agentLoop 有独立 wakeup 清单;session 退出时自动 GC
 *   · 内存级 — 本期不落盘(重启会丢),满足"agent 自主 pacing"常见场景(几十秒~一小时)
 *     Phase 2 可以加 SQLite 持久化支持跨重启恢复
 *   · 触发方式 — 复用 BackgroundTaskNotifier.enqueueMessageForSession 往 session
 *     收件箱投递 XML,agentLoop 每轮开头会 drain 注入到 user message
 *
 * 与 CronCreate/SchedulerRegistry 的区别:
 *   · CronCreate:工具,agent 声明"每周一 9 点跑 X" — 周期性、与 commitment 关联
 *   · ScheduleWakeup:工具,agent 声明"270 秒后醒来" — 一次性、轻量、为等待异步事件
 *     (后台 bash / 外部 API / 网络请求)设计的"合法 sleep 替代品"
 */

import { randomUUID } from 'crypto';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { getBackgroundTaskNotifier } from './backgroundTaskNotifier.js';

export interface ScheduledWakeup {
  id: string;
  sessionId: string;
  /** 触发时间戳 (ms) */
  dueAt: number;
  /** agent 给出的原因,用于 telemetry + XML */
  reason: string;
  /** 到点时的 prompt —— 作为 user message 内容 */
  prompt: string;
  /** 注册时间 */
  createdAt: number;
  /** Node timer 句柄,cancel 时用 */
  timer: NodeJS.Timeout;
}

const WAKEUP_TAG = 'scheduled-wakeup';

/** clamp 范围 [60, 3600] — 低于 60s 该直接 poll,高于 1h 该用 CronCreate */
export const MIN_WAKEUP_SECONDS = 60;
export const MAX_WAKEUP_SECONDS = 3600;

/**
 * 当 wakeup 到点时,server 层注册的"代用户起一轮"回调。
 * 输入:wakeup 关联的 chat sessionId + 已格式化好的 <scheduled-wakeup> XML。
 * 实现方:server 启动时注册,内部应该调 bridge.chat(sessionId, {prompt: xml, ...}),
 * 用最近一次该 session 用过的 providerId/modelName。
 *
 * 没注册时(非 server 进程,如 CLI 单测)fire() 会 fallback 到 enqueueMessageForSession,
 * 把 XML 塞队列等下次手动 turn drain。
 */
export type WakeupTriggerHandler = (input: {
  sessionId: string;
  xml: string;
  reason: string;
}) => void | Promise<void>;

let wakeupTriggerHandler: WakeupTriggerHandler | null = null;

export function setWakeupTriggerHandler(cb: WakeupTriggerHandler | null): void {
  wakeupTriggerHandler = cb;
}

export class ScheduledWakeupRegistry {
  private wakeups = new Map<string, ScheduledWakeup>();

  /**
   * 注册一个 wakeup。
   * 返回 wakeup id(便于将来 cancel)。
   */
  schedule(input: {
    sessionId: string;
    delaySeconds: number;
    reason: string;
    prompt: string;
  }): { id: string; dueAt: number; clamped: boolean } {
    const raw = Number(input.delaySeconds);
    const clamped = Math.max(MIN_WAKEUP_SECONDS, Math.min(MAX_WAKEUP_SECONDS, Math.floor(raw)));
    const wasClamped = clamped !== raw;
    const id = `wakeup-${randomUUID()}`;
    const dueAt = Date.now() + clamped * 1000;
    const timer = setTimeout(() => this.fire(id), clamped * 1000);
    // unref 让 Node 在其他工作完成后能自然退出,不会被未触发的 wakeup 卡住
    if (typeof timer.unref === 'function') timer.unref();

    this.wakeups.set(id, {
      id,
      sessionId: input.sessionId,
      dueAt,
      reason: input.reason,
      prompt: input.prompt,
      createdAt: Date.now(),
      timer,
    });

    cliLogger.info(
      'WAKEUP',
      `Scheduled wakeup ${id} for session ${input.sessionId} in ${clamped}s — ${input.reason.slice(0, 60)}`,
    );
    return { id, dueAt, clamped: wasClamped };
  }

  /** 取消一个未触发的 wakeup(id 不存在或已触发 → no-op)*/
  cancel(id: string): boolean {
    const w = this.wakeups.get(id);
    if (!w) return false;
    clearTimeout(w.timer);
    this.wakeups.delete(id);
    cliLogger.debug('WAKEUP', `Cancelled wakeup ${id}`);
    return true;
  }

  /** 列出所有尚未触发的 wakeup(跨 session,UI 层用)*/
  listAllPending(): Array<Omit<ScheduledWakeup, 'timer'>> {
    return [...this.wakeups.values()]
      .map(w => ({
        id: w.id,
        sessionId: w.sessionId,
        dueAt: w.dueAt,
        reason: w.reason,
        prompt: w.prompt,
        createdAt: w.createdAt,
      }))
      .sort((a, b) => a.dueAt - b.dueAt);
  }

  /** 列出某 session 仍待触发的 wakeup */
  listForSession(sessionId: string): Array<Omit<ScheduledWakeup, 'timer'>> {
    const out: Array<Omit<ScheduledWakeup, 'timer'>> = [];
    for (const w of this.wakeups.values()) {
      if (w.sessionId !== sessionId) continue;
      out.push({
        id: w.id,
        sessionId: w.sessionId,
        dueAt: w.dueAt,
        reason: w.reason,
        prompt: w.prompt,
        createdAt: w.createdAt,
      });
    }
    return out;
  }

  /** 清空某 session 所有未触发 wakeup — agentLoop 退出时调用,避免泄漏 */
  cancelAllForSession(sessionId: string): number {
    let n = 0;
    for (const [id, w] of [...this.wakeups]) {
      if (w.sessionId === sessionId) {
        clearTimeout(w.timer);
        this.wakeups.delete(id);
        n++;
      }
    }
    if (n > 0) cliLogger.info('WAKEUP', `Cleared ${n} pending wakeup(s) for session ${sessionId}`);
    return n;
  }

  private fire(id: string): void {
    const w = this.wakeups.get(id);
    if (!w) return;
    this.wakeups.delete(id);

    const xml = buildWakeupXml(w);

    /* 优先走"代用户起新 turn"路径 — server 层注册的 handler 会调 bridge.chat,
       让 agent 真的醒来回复一轮。没注册(CLI / 单测 / 早期启动)就 fallback
       到老 enqueue 路径,等下次用户手动发消息时 drain。 */
    if (wakeupTriggerHandler) {
      cliLogger.info(
        'WAKEUP',
        `Firing wakeup ${id} via trigger handler — session=${w.sessionId} reason="${w.reason.slice(0, 60)}"`,
      );
      try {
        const result = wakeupTriggerHandler({ sessionId: w.sessionId, xml, reason: w.reason });
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(err => {
            cliLogger.error('WAKEUP', `wakeupTriggerHandler async failed for ${id}: ${err?.message ?? err}`);
          });
        }
      } catch (err: any) {
        cliLogger.error('WAKEUP', `wakeupTriggerHandler sync failed for ${id}: ${err?.message ?? err}`);
      }
      return;
    }

    const notifier = getBackgroundTaskNotifier();
    notifier.enqueueMessageForSession(w.sessionId, xml, {
      command: `wakeup: ${w.reason.slice(0, 60)}`,
      pid: 0,
      status: 'completed',
    });
    cliLogger.info(
      'WAKEUP',
      `Fired wakeup ${id} (queued, no handler) — session=${w.sessionId} reason="${w.reason.slice(0, 60)}"`,
    );
  }
}

function buildWakeupXml(w: ScheduledWakeup): string {
  const elapsed = Math.round((Date.now() - w.createdAt) / 1000);
  return `<${WAKEUP_TAG}>
<reason>${escapeXml(w.reason)}</reason>
<elapsed-seconds>${elapsed}</elapsed-seconds>
<prompt>${escapeXml(w.prompt)}</prompt>
</${WAKEUP_TAG}>`;
}

function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── singleton ───────────────────────────────────────────────

let globalRegistry: ScheduledWakeupRegistry | null = null;

export function getScheduledWakeupRegistry(): ScheduledWakeupRegistry {
  if (!globalRegistry) {
    globalRegistry = new ScheduledWakeupRegistry();
  }
  return globalRegistry;
}

export function __resetScheduledWakeupRegistryForTest(): void {
  globalRegistry = null;
}

export const SCHEDULED_WAKEUP_TAG = WAKEUP_TAG;
