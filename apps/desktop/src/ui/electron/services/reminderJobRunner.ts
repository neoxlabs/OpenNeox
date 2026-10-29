/**
 * ReminderJobRunner — electron main 里唯一的提醒调度器.
 *
 * 单例 · 无自己的存储 · 一切真相在 life_events 表.
 *
 * 生命周期:
 *   boot()   → 首次调用: 扫过期 (overdue), fire/dismiss 分派; 定 30s tick
 *   tick()   → 每 30s: listDueReminders(now) → 逐条 fire
 *   fire(id) → transition(scheduled→fired); Notification 弹; recurrence 立刻建下一条 scheduled
 *   通知点击 → BrowserWindow 聚焦 + 广播 'life-reminder:activated' 事件, renderer 落到:
 *              1. 打开 event.sessionId 对应会话 (如果还在)
 *              2. composer 注入 payload.context 作 hint prompt
 *
 * 关键决策:
 *   · 30s tick 而不是精确 setTimeout — 简单、健壮 (setTimeout 的 delay 上限 ~24.8 天);
 *   · fire 后 transition 是唯一状态源, 通知失败也不回滚 (audit 里能查到 fired);
 *   · recurrence 新 event 在 fire 时**立即**创建 (不等 done), 保证漏 done 也不断链;
 *   · Overdue 阈值 6h — boot 时看到 6h 前 scheduled 直接 dismiss(reason='overdue on boot').
 */

import { BrowserWindow, Notification } from 'electron';
import {
  getLifeEventsStore,
  computeNextFire,
  classifyOverdue,
  type LifeEvent,
  type ReminderPayload,
} from '@neoxlabs/core/life/index.js';
import { getBackgroundTaskNotifier } from '@neoxlabs/core/runtime/shell/backgroundTaskNotifier.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { enqueueToSessionRuntime } from './runtimeEnqueue.js';
import { listPairedMobiles } from '../mobile-bridge/deviceStore.js';

function xmlEscape(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function dispatchAgentSpeakUp(ev: LifeEvent, payload: ReminderPayload, lateByMs: number, missedCalls = 0): void {
  if (!ev.sessionId) return;
  /* XML 尽量短: title 必填, context 有才带. instruction 已在 Life prompt 里教好, 不重复. */
  const parts = [`<title>${xmlEscape(ev.title)}</title>`];
  if (payload.context) parts.push(`<context>${xmlEscape(payload.context)}</context>`);
  /* Pilot 打了电话没人接: 告诉它, 它才知道用户多半还不知道这件事 (下一步该换别的办法, 而不是当已经提醒过了) */
  if (missedCalls > 0) parts.push(`<calls-unanswered>${missedCalls}</calls-unanswered>`);
  /* 迟到 (关机/休眠错过) → 明确告诉 agent 本该几点响, 别当准点提醒汇报. */
  if (lateByMs > 60_000 && typeof ev.scheduledAt === 'number') {
    parts.push(`<scheduled-for>${xmlEscape(new Date(ev.scheduledAt).toLocaleString())}</scheduled-for>`);
    parts.push(`<late-by-minutes>${Math.round(lateByMs / 60_000)}</late-by-minutes>`);
  }
  const xml = `<life-reminder-fired>${parts.join('')}</life-reminder-fired>`;
  const opts = { kind: 'reminder', command: `reminder: ${(ev.title || '').slice(0, 40)}` };
  const sessionId = ev.sessionId;
  /* 经会话所在的 runtime 投 (worker 模式下主进程自己的 notifier 是另一个实例, 投了没人收);
   * runtime 找不到时才退回本进程那份 (进程内直跑的 runtime 用的就是它) */
  void enqueueToSessionRuntime(sessionId, xml, opts).then((ok) => {
    if (ok) {
      console.log('🔔 [ReminderJobRunner] agent speak-up enqueued for session', sessionId, ev.id);
      return;
    }
    try {
      getBackgroundTaskNotifier().enqueueMessageForSession(sessionId, xml, { ...opts, kind: 'reminder', pid: 0, status: 'completed' });
      console.log('🔔 [ReminderJobRunner] agent speak-up enqueued (in-process) for session', sessionId, ev.id);
    } catch (e: any) {
      console.warn('🔔 [ReminderJobRunner] agent speak-up enqueue failed:', ev.id, e?.message);
    }
  });
}

const TICK_MS = 30_000;

let _timer: NodeJS.Timeout | null = null;
let _booted = false;

function payloadOf(ev: LifeEvent): ReminderPayload {
  return (ev.payload ?? {}) as ReminderPayload;
}

function broadcastToRenderer(channel: string, payload: unknown): void {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send(channel, payload); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/** 提醒到点的三条通道 (系统通知 / 界面常驻提示 / agent 主动开口) + 手机 */
function notifyReminderChannels(
  ev: LifeEvent,
  payload: ReminderPayload,
  now: number,
  lateByMs: number,
  lateNote: string | undefined,
  /** Pilot 打过几次电话都没接通 (0/不填 = 没打) */
  missedCalls = 0,
): void {
  broadcastToRenderer('life-reminder:fired', {
    eventId: ev.id,
    sessionId: ev.sessionId,
    title: ev.title,
    context: payload.context,
    scheduledAt: ev.scheduledAt,
    firedAt: now,
    lateByMs,
    lateNote,
  });
  dispatchAgentSpeakUp(ev, payload, lateByMs, missedCalls);
  /* (d) 手机端 (mobile-bridge 已配对连接中): 广播给 app 弹本地通知.
   *     动态 import 防循环依赖; 桥没启动时静默跳过. */
  void import('../mobile-bridge/wsServer.js')
    .then(m => m.broadcastLifeReminderFired({
      event_id: ev.id,
      session_id: ev.sessionId ?? null,
      title: ev.title,
      context: payload.context,
      fired_at: now,
      late_by_ms: lateByMs,
      late_note: lateNote,
    }))
    .catch(() => { /* bridge 未启动 — 忽略 */ });

  try {
    if (Notification.isSupported()) {
      const baseBody = payload.context ? payload.context.slice(0, 200) : '点这里回 Life 处理';
      const n = new Notification({
        title: ev.title,
        /* 迟到的提醒必须自报迟到, 否则用户看到半夜的提醒早上才弹会以为系统错乱. */
        body: lateNote ? `${lateNote}\n${baseBody}` : baseBody,
        silent: false,
      });
      n.on('click', () => {
        try {
          const wins = BrowserWindow.getAllWindows();
          const w = wins[0];
          if (w) {
            if (w.isMinimized()) w.restore();
            w.show(); w.focus();
            w.webContents.send('life-reminder:activated', {
              eventId: ev.id,
              sessionId: ev.sessionId,
              title: ev.title,
              context: payload.context,
            });
          }
        } catch { /* ignore */ }
      });
      n.show();
    } else {
      console.warn('🔔 [ReminderJobRunner] Notification.isSupported() = false — renderer 兜底通道仍会响.');
    }
  } catch (e: any) {
    console.warn('🔔 [ReminderJobRunner] Notification failed:', ev.id, e?.message);
  }
}

/* 提醒电话没人接: 隔 5 分钟再打, 一共 3 次 (NEOX_PILOT_JARVIS「升级阶梯」—— 提醒没用就打电话, 打一次没接不算完)。
 * 每一次 ringUser 内部还会先响电脑、没接再响手机。 */
const REMINDER_CALL_TRIES = 3;
const REMINDER_RETRY_MS = 5 * 60_000;

/** 0 = 接了; N>0 = 打了 N 次都没接通; -1 = 重打前发现这条已经被处理掉了 */
async function ringReminderLadder(ev: LifeEvent, opening: string): Promise<number> {
  const m = await import('./pilotCallService.js').catch(() => null);
  if (!m) return 1;
  for (let i = 1; i <= REMINDER_CALL_TRIES; i++) {
    if (i > 1) {
      await new Promise((r) => setTimeout(r, REMINDER_RETRY_MS));
      /* 你在界面上点了「知道了」/ 删掉了 → 不再打 */
      const cur = getLifeEventsStore().get(ev.id);
      if (!cur || cur.status !== 'fired') return -1;
    }
    const r = await m.ringUser({
      sessionId: ev.sessionId ?? undefined,
      reason: ev.title,
      opening: i > 1 ? `又打给你了: ${opening}` : opening,
      urgency: 'asked',
    }, 'reminder').catch(() => ({ status: 'blocked' as const }));
    if (r.status === 'answered') return 0;
    /* 拒接 = 你看到了、不想接: 不再追 */
    if (r.status === 'declined') return i;
    /* 被挡 (正在通话等): 下一轮再试 */
  }
  return REMINDER_CALL_TRIES;
}

function isPilotSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  try {
    return getDatabase().getSessionAgentMode(sessionId) === 'pilot';
  } catch {
    return false;
  }
}

function hasPairedPhone(): boolean {
  try { return listPairedMobiles({ filter: 'all' }).length > 0; } catch { return false; }
}

function fireOne(ev: LifeEvent): void {
  const store = getLifeEventsStore();
  const payload = payloadOf(ev);
  const now = Date.now();
  /* 迟到多久 (机器关机/休眠错过了 tick). >6h 的 (classifyOverdue='overdue') 以前被
   * 静默 dismiss, 现在照样 fire, 只是通知里写明本该几点响. */
  const lateByMs = typeof ev.scheduledAt === 'number' ? Math.max(0, now - ev.scheduledAt) : 0;
  const lateNote = lateByMs > 60_000 && typeof ev.scheduledAt === 'number'
    ? `本该在 ${new Date(ev.scheduledAt).toLocaleString()} 提醒你（晚了 ${Math.round(lateByMs / 60_000)} 分钟）`
    : undefined;
  console.log('🔔 [ReminderJobRunner] fire:', ev.id, ev.title, 'scheduledAt=', ev.scheduledAt, 'lateByMs=', lateByMs);

  /* 1. 状态机迁移: scheduled → fired (transition 内会打 fired_at 时间戳 + 写审计) */
  try {
    store.transition(ev.id, 'fired', 'job runner tick');
  } catch (e: any) {
    console.warn('🔔 [ReminderJobRunner] fire transition failed:', ev.id, e?.message);
    return;
  }

  const notifyChannels = () => notifyReminderChannels(ev, payload, now, lateByMs, lateNote);

  /* 配了手机时, 晚了两分钟以上说明电脑这段时间没醒着 —— 手机给每条 Pilot 提醒排了晚 90 秒的兜底闹钟
   * (手机 pilot_reminder_mirror.dart), 那边已经替它响过了; 电脑这时再打电话就是第二遍。只走下面的通知通道记一笔 */
  const phoneCovered = lateByMs > 2 * 60_000 && hasPairedPhone();
  if (lateByMs < 30 * 60_000 && !phoneCovered && isPilotSession(ev.sessionId)) {
    const opening = payload.context
      ? `到点了, ${ev.title}。${payload.context}`
      : `到点了, 该${ev.title}了。`;
    void ringReminderLadder(ev, opening).then((tries) => {
      if (tries === 0) {
        try { store.transition(ev.id, 'done', 'answered the reminder call'); } catch { /* 已被别处改过 */ }
      } else if (tries > 0) {
        notifyReminderChannels(ev, payload, now, lateByMs, lateNote, tries);
      }
      /* tries < 0: 等重打期间你已经在别处处理了这条, 不再打扰 */
    });
  } else {
    notifyChannels();
  }

  /* 3. recurrence: 立即建下一条 scheduled event (独立 id, 独立 audit) */
  const recurrence = payload.recurrence;
  if (recurrence) {
    const nextAt = computeNextFire(recurrence, now);
    if (typeof nextAt === 'number' && nextAt > now) {
      try {
        store.create({
          kind: 'reminder',
          sessionId: ev.sessionId,
          title: ev.title,
          payload,                 // 保留同款 recurrence + context
          scheduledAt: nextAt,
        });
      } catch (e: any) {
        console.warn('[ReminderJobRunner] failed to schedule next occurrence:', e?.message);
      }
    }
  }
}

function tick(): void {
  const store = getLifeEventsStore();
  const now = Date.now();
  const due = store.listDueReminders(now);
  if (due.length > 0) {
    console.log(`🔔 [ReminderJobRunner] tick: ${due.length} due at ${new Date(now).toISOString()}`);
  }
  for (const ev of due) {
    if (classifyOverdue(ev.scheduledAt ?? now, now) === 'overdue') {
      console.log('🔔 [ReminderJobRunner] firing overdue (late, will self-report):', ev.id, 'scheduledAt=', ev.scheduledAt);
    }
    fireOne(ev);
  }
}

/**
 * Boot: 首次调用启动 tick, 立刻扫一次过期. Idempotent.
 */
export function bootReminderJobRunner(): void {
  if (_booted) return;
  _booted = true;
  console.log(`🔔 [ReminderJobRunner] booting (tick ${TICK_MS}ms, notification supported=${Notification.isSupported()})`);
  try { tick(); } catch (e: any) { console.warn('🔔 [ReminderJobRunner] initial tick failed:', e?.message); }
  _timer = setInterval(() => {
    try { tick(); } catch (e: any) { console.warn('🔔 [ReminderJobRunner] tick failed:', e?.message); }
  }, TICK_MS);
  /* 不 unref — 桌面进程持续运行, 关掉了也就到点了; unref 会让 tick 不阻止 app.quit */
}

/** DEV/调试: 立刻扫一次 due (跳过 30s 等待). renderer devtools 可 window.neox.debugFireReminders() */
export function debugFlushDueReminders(): { fired: number } {
  const before = getLifeEventsStore().listDueReminders(Date.now()).length;
  tick();
  return { fired: before };
}

/**
 * 关闭 (dev HMR / app.quit 前)
 */
export function shutdownReminderJobRunner(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _booted = false;
}
