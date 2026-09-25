/**
 * macOS Bridge tools — Life/Work 模式的系统级生活能力 (仅 darwin).
 *
 * 通过 osascript(AppleScript) 直接读写 macOS 原生应用:
 *   calendar_events / calendar_add   — 日历 (Calendar.app)
 *   apple_reminders                  — 提醒事项 (Reminders.app, list/add/complete)
 *   contacts_search                  — 联系人 (Contacts.app)
 *   send_imessage                    — 发 iMessage (Messages.app, 需用户明确要求)
 *
 * 这是 Life 助手区别于网页 chatbot 的本机权力: 零第三方 API、零 key。
 * 首次调用会触发 macOS 自动化授权弹窗 (系统设置 > 隐私与安全性 > 自动化),
 * 拒绝后 osascript 报 -1743, 工具返回定向指引而不是裸错误。
 *
 * 注入安全: 所有用户输入一律走 `on run argv` 参数传递, 绝不拼进脚本源码。
 * 日期传递: AppleScript date 构造是 locale 陷阱, 统一传 "相对 now 的秒偏移",
 * 脚本内 `(current date) + delta` 重建, 事件时间也以秒偏移回传、JS 侧还原。
 */

import { execFile } from 'node:child_process';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { parseWhen } from '../life/index.js';

const IS_MAC = process.platform === 'darwin';

/** 字段/记录分隔符 — 避开正文里可能出现的一切常规字符 */
const FS = '\u001F';
const RS = '\u001E';

function runOsascript(script: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-e', script, ...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message || '');
          if (msg.includes('-1712')) {
            reject(new Error(
              '目标应用无响应 (AppleEvent timed out) — 可能正在等待 macOS 自动化授权弹窗, ' +
              '或应用首次启动较慢。请让用户确认授权弹窗后重试一次。',
            ));
          } else if (msg.includes('-1743')) {
            reject(new Error(
              'macOS 拒绝了自动化授权。请在 系统设置 > 隐私与安全性 > 自动化 里允许 Neox 控制目标应用, 然后重试。',
            ));
          } else if ((err as import('node:child_process').ExecFileException).killed || msg.includes('timed out')) {
            reject(new Error('AppleScript 执行超时 — 日历/提醒条目可能过多, 试试缩小时间窗口。'));
          } else {
            reject(new Error(msg.trim() || 'osascript failed'));
          }
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function notMacError(): string {
  return JSON.stringify({ error: 'This tool only works on macOS.' });
}

/** "相对 now 秒偏移" → 绝对时间 (调用瞬间为基准, 毫秒级误差可忽略) */
function deltaSeconds(epochMs: number): number {
  return Math.round((epochMs - Date.now()) / 1000);
}

function parseRecords(raw: string): string[][] {
  return raw
    .split(RS)
    .map(r => r.replace(/\n+$/g, ''))
    .filter(r => r.trim().length > 0)
    .map(r => r.split(FS));
}

function fmtLocal(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/* ============================================================
 * calendar_events — 读日历事件 (时间窗口)
 * ============================================================ */

interface CalendarEventsArgs {
  days_ahead?: number;
  days_back?: number;
  calendar?: string;
}

const CALENDAR_EVENTS_SCRIPT = `
on run argv
  set backDelta to (item 1 of argv) as integer
  set aheadDelta to (item 2 of argv) as integer
  set calFilter to item 3 of argv
  set d1 to (current date) + backDelta
  set d2 to (current date) + aheadDelta
  set nowRef to current date
  set out to ""
  set FS to (ASCII character 31)
  set RS to (ASCII character 30)
  tell application "Calendar"
    if calFilter is "" then
      set theCals to calendars
    else
      set theCals to (calendars whose name is calFilter)
    end if
    repeat with c in theCals
      set calName to name of c
      try
        set evs to (every event of c whose start date is greater than or equal to d1 and start date is less than or equal to d2)
        repeat with ev in evs
          set sDelta to ((start date of ev) - nowRef) as integer
          set eDelta to ((end date of ev) - nowRef) as integer
          set evLoc to ""
          try
            if location of ev is not missing value then set evLoc to location of ev
          end try
          set adFlag to "0"
          try
            if allday event of ev then set adFlag to "1"
          end try
          set out to out & (summary of ev) & FS & sDelta & FS & eDelta & FS & calName & FS & evLoc & FS & adFlag & RS
        end repeat
      end try
    end repeat
  end tell
  return out
end run
`;

export const calendarEventsTool: Tool = {
  name: 'calendar_events',
  description:
    'Read the user\'s macOS Calendar events in a time window (default: next 7 days). ' +
    'Use for "明天有什么安排", "下周三有空吗", daily briefs, and before scheduling anything new. ' +
    'Returns event title, start/end time, calendar name, location. macOS only; ' +
    'first call may trigger a system automation-permission prompt.',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: true,

  parameters: {
    type: 'object',
    properties: {
      days_ahead: {
        type: 'number',
        description: 'How many days ahead to scan (default 7, max 60).',
      },
      days_back: {
        type: 'number',
        description: 'How many days back to include (default 0, max 30). Use for "上周开了什么会".',
      },
      calendar: {
        type: 'string',
        description: 'Exact calendar name to filter (e.g. "工作"). Omit to scan all calendars.',
      },
    },
  },

  async function(args: CalendarEventsArgs): Promise<string> {
    if (!IS_MAC) return notMacError();
    const ahead = Math.max(0, Math.min(60, args?.days_ahead ?? 7));
    const back = Math.max(0, Math.min(30, args?.days_back ?? 0));
    const base = Date.now();
    try {
      const raw = await runOsascript(
        CALENDAR_EVENTS_SCRIPT,
        [String(-back * 86400), String(ahead * 86400), args?.calendar ?? ''],
        60_000,
      );
      const events = parseRecords(raw)
        .filter(f => f.length >= 6)
        .map(f => ({
          title: f[0],
          start: fmtLocal(base + Number(f[1]) * 1000),
          end: fmtLocal(base + Number(f[2]) * 1000),
          calendar: f[3],
          location: f[4] || undefined,
          all_day: f[5] === '1',
          _startMs: base + Number(f[1]) * 1000,
        }))
        .sort((a, b) => a._startMs - b._startMs)
        .map(({ _startMs, ...ev }) => ev);
      return JSON.stringify({ count: events.length, window: `-${back}d ~ +${ahead}d`, events });
    } catch (e: unknown) {
      return JSON.stringify({ error: `calendar_events failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  },
};

/* ============================================================
 * calendar_add — 写日历事件
 * ============================================================ */

interface CalendarAddArgs {
  title: string;
  start: string;
  duration_minutes?: number;
  calendar?: string;
  location?: string;
  notes?: string;
}

const CALENDAR_ADD_SCRIPT = `
on run argv
  set theTitle to item 1 of argv
  set startDelta to (item 2 of argv) as integer
  set durMin to (item 3 of argv) as integer
  set calName to item 4 of argv
  set theLoc to item 5 of argv
  set theNotes to item 6 of argv
  set d1 to (current date) + startDelta
  set d2 to d1 + durMin * minutes
  tell application "Calendar"
    if calName is "" then
      set theCal to first calendar whose writable is true
    else
      set theCal to first calendar whose name is calName
    end if
    tell theCal
      set ev to make new event with properties {summary:theTitle, start date:d1, end date:d2}
      if theLoc is not "" then set location of ev to theLoc
      if theNotes is not "" then set description of ev to theNotes
    end tell
    return name of theCal
  end tell
end run
`;

export const calendarAddTool: Tool = {
  name: 'calendar_add',
  description:
    'Create an event in the user\'s macOS Calendar. Use when the user asks to put something ' +
    'on their calendar ("把牙医预约加到日历", "帮我记周五下午 3 点开会"). ' +
    'Confirm ambiguous dates with the user before writing. macOS only.',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'unsafe',
  isReadOnly: false,

  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Event title, user-facing. e.g. "牙医复诊"' },
      start: {
        type: 'string',
        description: 'Start time: ISO 8601 (2026-07-15T15:00), "in 2 hours", "tomorrow 9am", "next Wed 20:00". Local timezone.',
      },
      duration_minutes: { type: 'number', description: 'Duration in minutes (default 60).' },
      calendar: { type: 'string', description: 'Target calendar name. Omit = first writable calendar.' },
      location: { type: 'string', description: 'Optional location text.' },
      notes: { type: 'string', description: 'Optional notes/description.' },
    },
    required: ['title', 'start'],
  },

  async function(args: CalendarAddArgs): Promise<string> {
    if (!IS_MAC) return notMacError();
    if (!args?.title?.trim()) return JSON.stringify({ error: 'title is required' });
    const startMs = parseWhen(args.start);
    if (!startMs) {
      return JSON.stringify({ error: `could not parse start="${args.start}". Use ISO 8601, "in N hours", or "tomorrow 9am".` });
    }
    const dur = Math.max(5, Math.min(24 * 60, args.duration_minutes ?? 60));
    try {
      const calUsed = await runOsascript(
        CALENDAR_ADD_SCRIPT,
        [args.title.trim(), String(deltaSeconds(startMs)), String(dur), args.calendar ?? '', args.location ?? '', args.notes ?? ''],
        30_000,
      );
      return JSON.stringify({
        ok: true,
        calendar: calUsed.trim(),
        start: fmtLocal(startMs),
        end: fmtLocal(startMs + dur * 60_000),
        message: `Event "${args.title.trim()}" created in calendar "${calUsed.trim()}" at ${fmtLocal(startMs)}.`,
      });
    } catch (e: unknown) {
      return JSON.stringify({ error: `calendar_add failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  },
};


interface AppleRemindersArgs {
  action: 'list' | 'add' | 'complete';
  title?: string;
  due?: string;
  list_name?: string;
  notes?: string;
}

const REMINDERS_LIST_SCRIPT = `
on run argv
  set listFilter to item 1 of argv
  set FS to (ASCII character 31)
  set RS to (ASCII character 30)
  set nowRef to current date
  set out to ""
  set cnt to 0
  tell application "Reminders"
    if listFilter is "" then
      set theLists to lists
    else
      set theLists to (lists whose name is listFilter)
    end if
    repeat with l in theLists
      if cnt is greater than 49 then exit repeat
      set listName to name of l
      set openReminders to (reminders of l whose completed is false)
      repeat with r in openReminders
        if cnt is greater than 49 then exit repeat
        set dueTxt to ""
        try
          if due date of r is not missing value then set dueTxt to (((due date of r) - nowRef) as integer) as string
        end try
        set out to out & (name of r) & FS & dueTxt & FS & listName & RS
        set cnt to cnt + 1
      end repeat
    end repeat
  end tell
  return out
end run
`;

const REMINDERS_ADD_SCRIPT = `
on run argv
  set theTitle to item 1 of argv
  set dueDeltaTxt to item 2 of argv
  set listFilter to item 3 of argv
  set theNotes to item 4 of argv
  tell application "Reminders"
    if listFilter is "" then
      set theList to default list
    else
      set theList to first list whose name is listFilter
    end if
    tell theList
      if dueDeltaTxt is "" then
        set r to make new reminder with properties {name:theTitle}
      else
        set dueDate to (current date) + (dueDeltaTxt as integer)
        set r to make new reminder with properties {name:theTitle, due date:dueDate}
      end if
      if theNotes is not "" then set body of r to theNotes
    end tell
    return name of theList
  end tell
end run
`;

const REMINDERS_COMPLETE_SCRIPT = `
on run argv
  set theTitle to item 1 of argv
  set listFilter to item 2 of argv
  tell application "Reminders"
    if listFilter is "" then
      set matches to (reminders whose name is theTitle and completed is false)
    else
      set matches to (reminders of (first list whose name is listFilter) whose name is theTitle and completed is false)
    end if
    if (count of matches) is 0 then return "NOTFOUND"
    set completed of (item 1 of matches) to true
    return "OK"
  end tell
end run
`;

export const appleRemindersTool: Tool = {
  name: 'apple_reminders',
  description:
    'Read/write the user\'s macOS Reminders app (syncs to iPhone/Watch via iCloud). ' +
    'action="list" shows open reminders; "add" creates one (optionally with due time); ' +
    '"complete" checks one off by exact title. ' +
    'Use apple_reminders when the user wants it in the system Reminders app or on their phone; ' +
    'use schedule_reminder when Neox itself should ping them in chat. macOS only.',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'unsafe',
  isReadOnly: false,

  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'add', 'complete'], description: 'What to do.' },
      title: { type: 'string', description: 'Reminder text (required for add/complete). For complete: must match exactly.' },
      due: { type: 'string', description: 'Optional due time for add: ISO 8601, "in 2 hours", "tomorrow 9am".' },
      list_name: { type: 'string', description: 'Reminders list name. Omit = default list (add) / all lists (list, complete).' },
      notes: { type: 'string', description: 'Optional notes body for add.' },
    },
    required: ['action'],
  },

  async function(args: AppleRemindersArgs): Promise<string> {
    if (!IS_MAC) return notMacError();
    try {
      if (args.action === 'list') {
        const base = Date.now();
        const raw = await runOsascript(REMINDERS_LIST_SCRIPT, [args.list_name ?? ''], 45_000);
        const reminders = parseRecords(raw)
          .filter(f => f.length >= 3)
          .map(f => ({
            title: f[0],
            due: f[1] ? fmtLocal(base + Number(f[1]) * 1000) : undefined,
            list: f[2],
          }));
        return JSON.stringify({ count: reminders.length, capped_at_50: reminders.length >= 50, reminders });
      }
      if (args.action === 'add') {
        if (!args.title?.trim()) return JSON.stringify({ error: 'title is required for add' });
        let dueDelta = '';
        if (args.due) {
          const dueMs = parseWhen(args.due);
          if (!dueMs) return JSON.stringify({ error: `could not parse due="${args.due}"` });
          dueDelta = String(deltaSeconds(dueMs));
        }
        const listUsed = await runOsascript(
          REMINDERS_ADD_SCRIPT,
          [args.title.trim(), dueDelta, args.list_name ?? '', args.notes ?? ''],
          30_000,
        );
        return JSON.stringify({ ok: true, list: listUsed.trim(), message: `Reminder "${args.title.trim()}" added to list "${listUsed.trim()}".` });
      }
      if (args.action === 'complete') {
        if (!args.title?.trim()) return JSON.stringify({ error: 'title is required for complete' });
        const res = await runOsascript(REMINDERS_COMPLETE_SCRIPT, [args.title.trim(), args.list_name ?? ''], 45_000);
        if (res.trim() === 'NOTFOUND') {
          return JSON.stringify({ error: `No open reminder titled "${args.title.trim()}" found. Use action="list" to see exact titles.` });
        }
        return JSON.stringify({ ok: true, message: `Reminder "${args.title.trim()}" marked complete.` });
      }
      return JSON.stringify({ error: `unknown action "${(args as { action?: string }).action}"` });
    } catch (e: unknown) {
      return JSON.stringify({ error: `apple_reminders failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  },
};

/* ============================================================
 * contacts_search — 联系人查询
 * ============================================================ */

interface ContactsSearchArgs {
  query: string;
}

const CONTACTS_SEARCH_SCRIPT = `
on run argv
  set q to item 1 of argv
  set FS to (ASCII character 31)
  set RS to (ASCII character 30)
  set nowRef to current date
  set out to ""
  set cnt to 0
  tell application "Contacts"
    set ppl to (people whose name contains q)
    repeat with p in ppl
      if cnt is greater than 7 then exit repeat
      set phoneTxt to ""
      repeat with ph in phones of p
        set phoneTxt to phoneTxt & (value of ph) & " "
      end repeat
      set emailTxt to ""
      repeat with em in emails of p
        set emailTxt to emailTxt & (value of em) & " "
      end repeat
      set bdayTxt to ""
      try
        if birth date of p is not missing value then set bdayTxt to (((birth date of p) - nowRef) as integer) as string
      end try
      set out to out & (name of p) & FS & phoneTxt & FS & emailTxt & FS & bdayTxt & RS
      set cnt to cnt + 1
    end repeat
  end tell
  return out
end run
`;

export const contactsSearchTool: Tool = {
  name: 'contacts_search',
  description:
    'Search the user\'s macOS Contacts by name. Returns matching people with phone numbers, ' +
    'emails, and birthday. Use for "我妈电话多少", "给王医生发邮件用哪个地址", birthday lookups. ' +
    'macOS only; read-only.',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: true,

  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Name fragment to search, e.g. "妈" / "王" / "Zhang".' },
    },
    required: ['query'],
  },

  async function(args: ContactsSearchArgs): Promise<string> {
    if (!IS_MAC) return notMacError();
    if (!args?.query?.trim()) return JSON.stringify({ error: 'query is required' });
    const base = Date.now();
    try {
      const raw = await runOsascript(CONTACTS_SEARCH_SCRIPT, [args.query.trim()], 30_000);
      const people = parseRecords(raw)
        .filter(f => f.length >= 4)
        .map(f => ({
          name: f[0],
          phones: f[1].trim() ? f[1].trim().split(/\s+/) : [],
          emails: f[2].trim() ? f[2].trim().split(/\s+/) : [],
          birthday: f[3] ? new Date(base + Number(f[3]) * 1000).toLocaleDateString('zh-CN') : undefined,
        }));
      return JSON.stringify({ count: people.length, people });
    } catch (e: unknown) {
      return JSON.stringify({ error: `contacts_search failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  },
};

/* ============================================================
 * send_imessage — 发 iMessage (外发动作, 必须用户明确要求)
 * ============================================================ */

interface SendIMessageArgs {
  recipient: string;
  message: string;
}

const SEND_IMESSAGE_SCRIPT = `
on run argv
  set recip to item 1 of argv
  set msg to item 2 of argv
  tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    set targetBuddy to participant recip of targetService
    send msg to targetBuddy
  end tell
  return "OK"
end run
`;

export const sendIMessageTool: Tool = {
  name: 'send_imessage',
  description:
    'Send an iMessage from the user\'s Messages app. OUTWARD-FACING ACTION: only call when the user ' +
    'explicitly asked to send a message, AND you have confirmed the exact recipient (phone/email from ' +
    'contacts_search) and the exact text with the user in this conversation. Never improvise recipients. ' +
    'macOS only; requires Messages signed in to iMessage.',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'unsafe',
  isReadOnly: false,

  parameters: {
    type: 'object',
    properties: {
      recipient: {
        type: 'string',
        description: 'Phone number (+8613xxxx) or iMessage email of the recipient. Get it via contacts_search; echo it to the user before sending.',
      },
      message: { type: 'string', description: 'Exact message text, as confirmed with the user.' },
    },
    required: ['recipient', 'message'],
  },

  async function(args: SendIMessageArgs): Promise<string> {
    if (!IS_MAC) return notMacError();
    if (!args?.recipient?.trim() || !args?.message?.trim()) {
      return JSON.stringify({ error: 'recipient and message are both required' });
    }
    try {
      await runOsascript(SEND_IMESSAGE_SCRIPT, [args.recipient.trim(), args.message], 30_000);
      return JSON.stringify({ ok: true, message: `iMessage sent to ${args.recipient.trim()}.` });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const hint = msg.includes('participant') || msg.includes('buddy') || msg.includes('-1728')
        ? ' (recipient may not be reachable via iMessage — verify the handle with the user)'
        : '';
      return JSON.stringify({ error: `send_imessage failed: ${msg}${hint}` });
    }
  },
};

/** 供 runtimeTools.ts 引用 — 非 darwin 平台给空数组, pack 目录里也就搜不到 */
export const MACOS_BRIDGE_TOOLS: Tool[] = IS_MAC
  ? [calendarEventsTool, calendarAddTool, appleRemindersTool, contactsSearchTool, sendIMessageTool]
  : [];

export const MACOS_BRIDGE_TOOL_NAMES = [
  'calendar_events', 'calendar_add', 'apple_reminders', 'contacts_search', 'send_imessage',
];
