
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { onUserIdChange } from '@neoxlabs/platform/utils/config.js';
import { getCurrentChatSessionId } from '../runtime/shell/chatSessionContext.js';
import { getBackgroundTaskNotifier } from '../runtime/shell/backgroundTaskNotifier.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';

// ==================== Types ====================

export interface CronJob {
  id: string;
  cron: string;           // 5-field cron expression (M H DoM Mon DoW)
  prompt: string;         // Prompt to enqueue at each fire time
  recurring: boolean;     // Fire on schedule until deleted
  durable: boolean;       // Persist to disk across sessions
  createdAt: number;      // Epoch ms
  lastFiredAt?: number;   // Last fire time
  expiresAt: number;      // Auto-expire after 7 days
  /** Chat session that created the job — the fire callback dispatches the prompt back into it. */
  sessionId?: string;
}

/** 触发上下文: dueAt = 本次"本该跑"的时刻, firedAt = 实际跑到的时刻 (关机/挂起后可能晚很多). */
export interface CronFireContext {
  dueAt: number;
  firedAt: number;
  /** firedAt - dueAt, 迟到毫秒数 (0 = 准点). */
  lateByMs: number;
}

// ==================== In-memory store ====================

const sessionCronJobs = new Map<string, CronJob>();
const MAX_CRON_JOBS = 50;
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/* Scheduler callback — 由 runtime 注册 (packages/core/src/server/main.ts, 挨着
 * setWakeupTriggerHandler / setBgTaskAutoResumeHandler 一起装). 没注册 = cron 没有任何
 * 落地通道, 此时 scheduler **不会** 假装跑过 (见 startCronScheduler 的 fail-loud 分支),
 * cron_create 也直接报错而不是给用户一个假的 "Next run"。 */
let onCronFire: ((job: CronJob, ctx: CronFireContext) => void) | null = null;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;

/** 已经因"回调没注册"而卡住的 job → 只 log 一次, 不刷屏 (每 30s 一次 tick). */
const warnedUnwiredJobs = new Set<string>();

/* P0: 用户切换时清掉内存里的 session crons — A 的 prompt 不能由 B 在场时被 fire.
 *   durable jobs 写在 .neox/scheduled_tasks.json (workspace-scoped, 不带 userId), 不动. */
onUserIdChange((next, prev) => {
  void next; void prev;
  sessionCronJobs.clear();
});

export function setCronFireCallback(callback: ((job: CronJob, ctx: CronFireContext) => void) | null): void {
  onCronFire = callback;
  if (callback) warnedUnwiredJobs.clear();
}

/** cron 是否真的能落地. cron_create 用它决定"能不能给用户报 Next run". */
export function isCronFireCallbackRegistered(): boolean {
  return onCronFire !== null;
}

/** 测试用: 清掉模块级单例状态 (回调 / timer / session 内存 / warn 去重). */
export function __resetCronToolsForTest(): void {
  stopCronScheduler();
  onCronFire = null;
  sessionCronJobs.clear();
  warnedUnwiredJobs.clear();
}

// ==================== Cron Expression Parser ====================

interface CronFields {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

function parseField(field: string, min: number, max: number): number[] {
  const values: Set<number> = new Set();

  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    let range: string;
    let step = 1;

    if (stepMatch) {
      range = stepMatch[1];
      step = parseInt(stepMatch[2], 10);
    } else {
      range = part;
    }

    if (range === '*') {
      for (let i = min; i <= max; i += step) values.add(i);
    } else {
      const rangeMatch = range.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        for (let i = start; i <= end; i += step) {
          if (i >= min && i <= max) values.add(i);
        }
      } else {
        const val = parseInt(range, 10);
        if (!isNaN(val) && val >= min && val <= max) values.add(val);
      }
    }
  }

  return [...values].sort((a, b) => a - b);
}

export function parseCronExpression(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  try {
    const minutes = parseField(parts[0], 0, 59);
    const hours = parseField(parts[1], 0, 23);
    const daysOfMonth = parseField(parts[2], 1, 31);
    const months = parseField(parts[3], 1, 12);
    const daysOfWeek = parseField(parts[4], 0, 6);

    if (!minutes.length || !hours.length || !daysOfMonth.length || !months.length || !daysOfWeek.length) {
      return null;
    }

    return { minutes, hours, daysOfMonth, months, daysOfWeek };
  } catch {
    return null;
  }
}

/**
 * Calculate next run time in ms from a given time
 */
export function nextCronRunMs(expr: string, fromMs: number = Date.now()): number | null {
  const fields = parseCronExpression(expr);
  if (!fields) return null;

  const from = new Date(fromMs);
  // Search up to 366 days ahead
  const maxDate = new Date(fromMs + 366 * 24 * 60 * 60 * 1000);

  const current = new Date(from);
  current.setSeconds(0, 0);
  current.setMinutes(current.getMinutes() + 1); // Start from next minute

  while (current < maxDate) {
    if (
      fields.months.includes(current.getMonth() + 1) &&
      fields.daysOfMonth.includes(current.getDate()) &&
      fields.daysOfWeek.includes(current.getDay()) &&
      fields.hours.includes(current.getHours()) &&
      fields.minutes.includes(current.getMinutes())
    ) {
      return current.getTime();
    }
    current.setMinutes(current.getMinutes() + 1);
  }

  return null;
}

/**
 * Convert cron expression to human-readable text
 */
export function cronToHuman(expr: string): string {
  const fields = parseCronExpression(expr);
  if (!fields) return expr;

  const { minutes, hours, daysOfMonth, months, daysOfWeek } = fields;
  const parts = expr.trim().split(/\s+/);

  // Every minute
  if (parts[0] === '*' && parts[1] === '*') return 'every minute';

  // Every N minutes
  const minStep = parts[0].match(/^\*\/(\d+)$/);
  if (minStep) return `every ${minStep[1]} minutes`;

  // Specific time
  if (minutes.length === 1 && hours.length === 1) {
    const time = `${String(hours[0]).padStart(2, '0')}:${String(minutes[0]).padStart(2, '0')}`;

    if (parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
      return `daily at ${time}`;
    }

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    if (parts[2] === '*' && parts[3] === '*' && daysOfWeek.length > 0 && daysOfWeek.length < 7) {
      const days = daysOfWeek.map(d => dayNames[d]).join(', ');
      return `${days} at ${time}`;
    }

    return `at ${time}`;
  }

  // Hourly
  if (minutes.length === 1 && parts[1] === '*') {
    return `every hour at :${String(minutes[0]).padStart(2, '0')}`;
  }

  return expr;
}

// ==================== Storage ====================

let cronWorkspaceRoot: string | null = null;

/** runtime 启动时钉死工作区 (server/main.ts 的 initRuntimeBridge 调)。 */
export function setCronWorkspaceRoot(root: string | null | undefined): void {
  cronWorkspaceRoot = root && String(root).trim() ? path.resolve(String(root)) : null;
}

function getCronRoot(): string {
  if (cronWorkspaceRoot) return cronWorkspaceRoot;
  const fromCtx = getWorkspaceRootFromContext();
  if (fromCtx && fromCtx.trim()) return fromCtx;
  return process.cwd();
}

function getCronFilePath(): string {
  return path.join(getCronRoot(), '.neox', 'scheduled_tasks.json');
}

function loadDurableCrons(): CronJob[] {
  try {
    const filePath = getCronFilePath();
    if (!fs.existsSync(filePath)) return [];
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveDurableCrons(jobs: CronJob[]): void {
  const filePath = getCronFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  /* sessionId 必须一起持久化: durable job 的全部意义就是重启后还能跑, 而"跑"=
   * 把 prompt 派回原会话. 剥掉它等于重启后 job 还在但无处投递. 会话已删的情况由
   * 派发端 (server/main.ts 的 cron 回调) 判断并 log, 不在这里预先丢弃. */
  fs.writeFileSync(filePath, JSON.stringify(jobs, null, 2), 'utf-8');
}

export function listAllCronJobs(): CronJob[] {
  const now = Date.now();
  const all: CronJob[] = [];

  // Session jobs
  for (const job of sessionCronJobs.values()) {
    if (job.expiresAt > now) all.push(job);
  }

  // Durable jobs
  const durable = loadDurableCrons();
  for (const job of durable) {
    if (job.expiresAt > now && !sessionCronJobs.has(job.id)) {
      all.push({ ...job, durable: true });
    }
  }

  return all;
}

function addCronJob(job: CronJob): void {
  if (job.durable) {
    const durable = loadDurableCrons();
    durable.push(job);
    saveDurableCrons(durable);
  } else {
    sessionCronJobs.set(job.id, job);
  }
}

function removeCronJob(id: string): boolean {
  // Try session store
  if (sessionCronJobs.delete(id)) return true;

  // Try durable store
  const durable = loadDurableCrons();
  const filtered = durable.filter(j => j.id !== id);
  if (filtered.length < durable.length) {
    saveDurableCrons(filtered);
    return true;
  }

  return false;
}

// ==================== Scheduler Engine ====================

/**
 * 跑一次到期扫描. 导出给测试 / debug flush 用 (不用等 30s tick).
 * 返回本次真正触发的 job 数.
 */
export function runCronSchedulerTick(now: number = Date.now()): number {
  const jobs = listAllCronJobs();
  let fired = 0;

  for (const job of jobs) {
    // Check if job should fire
    const nextRun = nextCronRunMs(job.cron, job.lastFiredAt || job.createdAt);
    if (!nextRun || nextRun > now) continue;

    if (!onCronFire) {
      if (!warnedUnwiredJobs.has(job.id)) {
        warnedUnwiredJobs.add(job.id);
        console.error(
          `[cron] job "${job.id}" (${job.cron}) came due at ${new Date(nextRun).toISOString()} ` +
          `but no fire callback is registered — the job is NOT being run and stays pending. ` +
          `Register one via setCronFireCallback() during runtime bootstrap.`,
        );
      }
      continue;
    }

    onCronFire(job, { dueAt: nextRun, firedAt: now, lateByMs: Math.max(0, now - nextRun) });
    fired++;

    // Update last fired time
    job.lastFiredAt = now;

    if (!job.recurring) {
      // One-shot: remove after firing
      removeCronJob(job.id);
    } else {
      // Update in store
      if (job.durable) {
        const durable = loadDurableCrons();
        const idx = durable.findIndex(j => j.id === job.id);
        if (idx >= 0) {
          durable[idx].lastFiredAt = now;
          saveDurableCrons(durable);
        }
      } else {
        sessionCronJobs.set(job.id, job);
      }
    }
  }

  // Cleanup expired
  for (const [id, job] of sessionCronJobs) {
    if (job.expiresAt <= now) sessionCronJobs.delete(id);
  }

  return fired;
}

export function startCronScheduler(): void {
  if (schedulerTimer) return;

  /* 重启恢复: durable job 存在 .neox/scheduled_tasks.json, listAllCronJobs 每 tick
   * 重新从磁盘读, 所以只要 bootstrap 调过一次 startCronScheduler(), 重启后 durable
   * job 自动接着跑 —— 无需额外 rehydrate 步骤. 边界: session (非 durable) job 只活在
   * 内存里, 按设计重启即消失; 关机期间错过的触发不补 N 次, 只补一次 (nextRun 从
   * lastFiredAt 起算, 到期即触发), 迟到多久通过 CronFireContext.lateByMs 告诉调用方. */
  schedulerTimer = setInterval(() => {
    runCronSchedulerTick();
  }, 30_000); // Check every 30 seconds
}

export function stopCronScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

// ==================== Tool Definitions ====================

export const cronCreateTool: Tool = {
  name: 'cron_create',
  description: `Create a scheduled task that runs a prompt on a cron schedule. 5-field cron expressions (M H DoM Mon DoW) in local time. Max 50 concurrent jobs, auto-expires after 7 days.

CRON vs schedule_wakeup — they are NOT interchangeable. Pick by two questions:
- Does it repeat, or run at a wall-clock time ("every weekday 9am", "every 5 minutes")? → cron_create.
- Is it "wake me in N seconds to continue what I am doing right now"? → schedule_wakeup (one-shot, 60-3600s, in-memory).
Do NOT chain schedule_wakeup calls to fake a recurring job: it is capped at 1 hour, it is lost on restart, and every hop costs a full turn.

durable:
- true (default) — written to <workspace>/.neox/scheduled_tasks.json and survives restart. If the file cannot be written this call FAILS LOUDLY instead of returning an id; retry with durable:false if a session-only job is acceptable.
- false — memory only, gone when Neox restarts. Only for jobs that are meaningful just inside this session.`,
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: false,

  parameters: {
    type: 'object',
    properties: {
      cron: {
        type: 'string',
        description: '5-field cron expression in local time (Minute Hour DayOfMonth Month DayOfWeek). Examples: "*/5 * * * *" (every 5 min), "0 9 * * 1-5" (weekdays at 9am), "30 14 * * *" (daily 2:30pm)',
      },
      prompt: {
        type: 'string',
        description: 'The prompt to enqueue at each scheduled time',
      },
      recurring: {
        type: 'boolean',
        description: 'Whether the job repeats on schedule (true) or fires once (false). Default: true',
      },
      durable: {
        type: 'boolean',
        description: 'Persist to <workspace>/.neox/scheduled_tasks.json so the job survives a restart. Default: true — a task the user asked to schedule should still be there tomorrow. Pass false only for a job that is meaningful just inside this session; then it lives in memory and is gone on restart.',
      },
    },
    required: ['cron', 'prompt'],
  },

  async function(args: any): Promise<string> {
    const { cron, prompt, recurring = true, durable = true } = args;

    // Validate cron expression
    const parsed = parseCronExpression(cron);
    if (!parsed) {
      return JSON.stringify({ error: 'Invalid cron expression. Use 5-field format: Minute Hour DayOfMonth Month DayOfWeek' });
    }

    // Validate next run exists
    const nextRun = nextCronRunMs(cron);
    if (!nextRun) {
      return JSON.stringify({ error: 'Cron expression does not match any future time within 1 year' });
    }

    // Check job limit
    const existing = listAllCronJobs();
    if (existing.length >= MAX_CRON_JOBS) {
      return JSON.stringify({ error: `Maximum ${MAX_CRON_JOBS} concurrent cron jobs reached. Delete some first.` });
    }

    if (!isCronFireCallbackRegistered()) {
      return JSON.stringify({
        error:
          'Cron scheduling is not available in this runtime: no cron fire callback is registered, ' +
          'so a scheduled job could never actually run. Nothing was scheduled. ' +
          'Do the work inline now, or tell the user scheduled tasks are unavailable here.',
      });
    }

    /* 触发时要把 prompt 派回原会话 (走 backgroundTaskNotifier), 没 sessionId 就无处投递.
     * 与 lifeTools / scheduleWakeupTool 同一套兜底顺序: chat ALS 优先, 再退 bgTask ALS. */
    const sessionId = getCurrentChatSessionId() ?? getBackgroundTaskNotifier().getCurrentSessionId();
    if (!sessionId) {
      return JSON.stringify({
        error:
          'cron_create needs an active session to dispatch the prompt at fire time; ' +
          'the current runtime has none (headless/CLI/test). Nothing was scheduled.',
      });
    }

    const now = Date.now();
    const job: CronJob = {
      id: randomUUID().slice(0, 8),
      cron,
      prompt,
      recurring,
      durable,
      createdAt: now,
      expiresAt: now + DEFAULT_EXPIRY_MS,
      sessionId,
    };

    try {
      addCronJob(job);
    } catch (err: any) {
      return JSON.stringify({
        error: `Failed to persist durable cron job: ${err?.message ?? err}`,
        hint: `Durable jobs are written to ${getCronFilePath()} — check that this directory exists and is writable, or create the job with durable=false (session-only).`,
      });
    }

    // Ensure scheduler is running
    startCronScheduler();

    const humanSchedule = cronToHuman(cron);
    const nextRunDate = new Date(nextRun);
    const nextRunStr = nextRunDate.toLocaleString();

    return JSON.stringify({
      id: job.id,
      humanSchedule,
      recurring,
      durable,
      nextRun: nextRunStr,
      message: `Scheduled: ${humanSchedule}${recurring ? ' (recurring)' : ' (one-shot)'}. Next run: ${nextRunStr}`,
    });
  },
};

export const cronDeleteTool: Tool = {
  name: 'cron_delete',
  description: 'Delete a scheduled cron job by its ID.',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: false,

  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The cron job ID to delete',
      },
    },
    required: ['id'],
  },

  async function(args: any): Promise<string> {
    const { id } = args;

    if (!id) {
      return JSON.stringify({ error: 'Job ID is required' });
    }

    const removed = removeCronJob(id);
    if (!removed) {
      return JSON.stringify({ error: `Cron job "${id}" not found` });
    }

    return JSON.stringify({
      id,
      message: `Cron job "${id}" deleted successfully`,
    });
  },
};

export const cronListTool: Tool = {
  name: 'cron_list',
  description: 'List all scheduled cron jobs and their status.',
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true,

  parameters: {
    type: 'object',
    properties: {},
  },

  async function(): Promise<string> {
    const jobs = listAllCronJobs();

    if (jobs.length === 0) {
      return JSON.stringify({ jobs: [], message: 'No scheduled cron jobs' });
    }

    const jobList = jobs.map(job => {
      const humanSchedule = cronToHuman(job.cron);
      const nextRun = nextCronRunMs(job.cron, job.lastFiredAt || job.createdAt);
      return {
        id: job.id,
        cron: job.cron,
        humanSchedule,
        prompt: job.prompt.length > 80 ? job.prompt.slice(0, 77) + '...' : job.prompt,
        recurring: job.recurring,
        durable: job.durable || undefined,
        nextRun: nextRun ? new Date(nextRun).toLocaleString() : 'expired',
      };
    });

    return JSON.stringify({ jobs: jobList, total: jobList.length });
  },
};
