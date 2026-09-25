
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { getLifeEventsStore, parseWhen } from '../life/index.js';
import type { LifeEvent, ReminderPayload, ReminderRecurrence } from '../life/index.js';
import { getCurrentChatSessionId } from '../runtime/shell/chatSessionContext.js';

/* ============================================================
 * schedule_reminder — 定时/循环提醒 (开会 / 交周报 / 每周三给客户回电话...)
 *
 * 状态机: scheduled → fired → done|dismissed.
 * recurrence 循环: JobRunner 在 fired→done 后立刻建新一条 scheduled event
 *   (不循环旧 event, 每次触发都是独立 audit 单元).
 * ============================================================ */

interface ScheduleReminderArgs {
  title: string;
  when: string;                 // ISO / "in 30 minutes" / "tomorrow 9am" / "next Wed 20:00"
  recurrence?: 'once' | 'daily' | 'weekly' | 'monthly' | { cron: string } | { kind: 'weekly'; days: number[] };
  context?: string;             // 触发时给 agent 的续问 hint
  session_id?: string;
  tags?: string[];
}

function normalizeRecurrence(r: ScheduleReminderArgs['recurrence']): ReminderRecurrence | null {
  if (!r || r === 'once') return null;
  if (r === 'daily') return { kind: 'daily' };
  if (r === 'weekly') return { kind: 'weekly' };
  if (r === 'monthly') return { kind: 'monthly' };
  if (typeof r === 'object' && r !== null) {
    if ('cron' in r && typeof r.cron === 'string') return { kind: 'cron', spec: r.cron };
    if ('kind' in r && r.kind === 'weekly' && Array.isArray(r.days)) {
      return { kind: 'weekly', spec: r.days };
    }
  }
  return null;
}

const formatLocal = (ts: number) => new Date(ts).toLocaleString('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

export const scheduleReminderTool: Tool = {
  name: 'schedule_reminder',
  description:
    'Schedule a real notification (title + when) that fires even if the app is idle. ' +
    'Use when the user says "remind me to X", "every week on Y", "at 9am tomorrow", etc. ' +
    'The Neox JobRunner triggers a system notification at the scheduled time and can open the chat with context. ' +
    'For recurring reminders (daily/weekly/monthly/cron) the runner auto-schedules the next occurrence when the current one fires. ' +
    'Do NOT call for questions you can just answer inline.',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: false,

  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short reminder text shown to the user in the notification. e.g. "交周报" / "给王总回电话"',
      },
      when: {
        type: 'string',
        description:
          'When to fire. Accepts ISO 8601 (2026-07-15T09:00), relative English ("in 30 minutes", "in 2 hours", "in 3 days"), or day words ("tomorrow 9am", "tonight 8pm", "next Wednesday 20:00"). Time is interpreted in the user\'s local timezone.',
      },
      recurrence: {
        description:
          'Repeat rule. Omit or "once" = single fire. "daily"/"weekly"/"monthly" repeat at the same clock time. ' +
          'For specific weekdays pass {kind:"weekly", days:[3]} (0=Sun, 1=Mon,...,6=Sat). ' +
          'For advanced patterns pass {cron:"0 9 * * 1-5"} (5-field cron, local time).',
        oneOf: [
          { type: 'string', enum: ['once', 'daily', 'weekly', 'monthly'] },
          { type: 'object', properties: { cron: { type: 'string' } }, required: ['cron'] },
          {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['weekly'] },
              days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
            },
            required: ['kind', 'days'],
          },
        ],
      },
      context: {
        type: 'string',
        description: 'Optional prompt hint for the agent when the reminder fires and the user re-opens the chat. e.g. "王总上次说周三下午有空"',
      },
      session_id: {
        type: 'string',
        description: 'Current session id (host will backfill if omitted). The reminder shows a "return to chat" link back to this session.',
      },
      tags: {
        type: 'array',
        description: 'Topic tags for long-term aggregation. Optional.',
        items: { type: 'string' },
      },
    },
    required: ['title', 'when'],
  },

  async function(args: ScheduleReminderArgs): Promise<string> {
    if (!args?.title || typeof args.title !== 'string' || args.title.trim().length === 0) {
      return JSON.stringify({ error: 'title is required and must be non-empty' });
    }
    if (!args?.when || typeof args.when !== 'string') {
      return JSON.stringify({ error: 'when is required (ISO / relative / day-word)' });
    }
    const scheduledAt = parseWhen(args.when);
    if (!scheduledAt) {
      return JSON.stringify({
        error: `could not parse "when"="${args.when}". ` +
          `Use ISO 8601 (2026-07-15T09:00), "in N minutes/hours/days", or "tomorrow 9am" / "next Wed 20:00".`,
      });
    }
    if (scheduledAt <= Date.now()) {
      return JSON.stringify({ error: `"when" resolves to a past time (${new Date(scheduledAt).toISOString()}). Pick a future moment.` });
    }
    const recurrence = normalizeRecurrence(args.recurrence);
    const payload: ReminderPayload = {
      recurrence: recurrence ?? undefined,
      context: args.context?.trim() || undefined,
    };
    try {
      const store = getLifeEventsStore();
      /* 自动兜底 sessionId (agent 常忘 pass session_id): 有它提醒到点时才能回到原会话 */
      const sessionId = args.session_id ?? getCurrentChatSessionId() ?? null;
      const ev = store.create({
        kind: 'reminder',
        sessionId,
        title: args.title.trim().slice(0, 200),
        payload,
        scheduledAt,
        tags: Array.isArray(args.tags) ? args.tags : undefined,
      });
      return JSON.stringify({
        id: ev.id,
        status: ev.status,
        scheduledAt: formatLocal(scheduledAt),
        recurrence: recurrence?.kind ?? 'once',
        message: `Reminder scheduled: "${ev.title}" at ${formatLocal(scheduledAt)}${recurrence ? ' (' + recurrence.kind + ')' : ''}.`,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return JSON.stringify({ error: `schedule_reminder failed: ${msg}` });
    }
  },
};

/* ============================================================
 * list_pending_tasks — 快到点的提醒。用户问「最近还有什么要办的」时用。
 * ============================================================ */

interface ListPendingTasksArgs {
  window_hours?: number;   // 提醒扫描窗口, 默认 24h
}

export const listPendingTasksTool: Tool = {
  name: 'list_pending_tasks',
  description:
    'List the user\'s upcoming reminders (scheduled within a window, default 24h) so you can bring them up. ' +
    'Use when the user asks "what\'s still on my plate?" or "any reminders today?". Do NOT call this on every turn.',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: true,

  parameters: {
    type: 'object',
    properties: {
      window_hours: {
        type: 'number',
        description: 'How far ahead to include upcoming reminders (default 24 hours). Set larger (168=1 week) for weekly recall.',
      },
    },
  },

  async function(args: ListPendingTasksArgs): Promise<string> {
    try {
      const store = getLifeEventsStore();
      const now = Date.now();
      const windowMs = Math.max(1, Math.min(24 * 7, args?.window_hours ?? 24)) * 3600_000;
      const upcoming = store.listByKind('reminder', { status: 'scheduled', limit: 50 })
        .filter(r => typeof r.scheduledAt === 'number' && r.scheduledAt > now - 3600_000 && r.scheduledAt <= now + windowMs)
        .sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0))
        .slice(0, 20);
      const summarize = (ev: LifeEvent) => ({
        id: ev.id,
        title: ev.title,
        session_id: ev.sessionId,
        scheduled_at: ev.scheduledAt ? new Date(ev.scheduledAt).toLocaleString() : null,
      });
      return JSON.stringify({ upcoming_reminders: upcoming.map(summarize), count: upcoming.length });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return JSON.stringify({ error: `list_pending_tasks failed: ${msg}` });
    }
  },
};

/** 供 runtimeTools.ts 引用 */
export const REMINDER_TOOLS: Tool[] = [scheduleReminderTool, listPendingTasksTool];
