
const BUS_EVENT_XML = /^\s*<(background-task-notification|agent-completion|scheduled-wakeup|scheduled-task-fired|life-reminder-fired|monitor-event|session-message)\b/i;

export function isBusEventMessage(text: string | undefined | null): boolean {
  return !!text && BUS_EVENT_XML.test(text);
}

export interface BackgroundShellNotification {
  pid: number;
  command: string;
  status: 'completed' | 'failed' | 'killed' | string;
  exitCode?: number;
  terminatedBy?: 'user' | 'agent' | 'system' | string;
  summary: string;
}

export interface AgentCompletion {
  agentId: string;
  name?: string;
  status: 'completed' | 'failed' | 'aborted' | string;
  elapsedSeconds: number;
  toolUseCount: number;
  description: string;
  summary: string;
}

export interface ScheduledWakeup {
  reason: string;
  elapsedSeconds: number;
  prompt: string;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function pickTag(text: string, tag: string): string {
  return new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(text)?.[1]?.trim() ?? '';
}

export function parseBackgroundTaskNotification(text: string): BackgroundShellNotification | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('<background-task-notification>')) return null;
  const exitRaw = pickTag(trimmed, 'exit-code');
  return {
    pid: Number(pickTag(trimmed, 'pid')) || 0,
    command: decodeXml(pickTag(trimmed, 'command')),
    status: pickTag(trimmed, 'status') || 'completed',
    exitCode: exitRaw === '' ? undefined : (Number(exitRaw) || 0),
    terminatedBy: pickTag(trimmed, 'terminated-by') || undefined,
    summary: decodeXml(pickTag(trimmed, 'summary')),
  };
}

export function parseAgentCompletion(text: string): AgentCompletion | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('<agent-completion>')) return null;
  return {
    agentId: decodeXml(pickTag(trimmed, 'agent-id')),
    name: pickTag(trimmed, 'name') ? decodeXml(pickTag(trimmed, 'name')) : undefined,
    status: pickTag(trimmed, 'status') || 'completed',
    elapsedSeconds: Number(pickTag(trimmed, 'elapsed-seconds')) || 0,
    toolUseCount: Number(pickTag(trimmed, 'tool-use-count')) || 0,
    description: decodeXml(pickTag(trimmed, 'description')),
    summary: decodeXml(pickTag(trimmed, 'summary')),
  };
}

export function parseScheduledWakeup(text: string): ScheduledWakeup | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('<scheduled-wakeup>')) return null;
  return {
    reason: decodeXml(pickTag(trimmed, 'reason')),
    elapsedSeconds: Number(pickTag(trimmed, 'elapsed-seconds')) || 0,
    prompt: decodeXml(pickTag(trimmed, 'prompt')),
  };
}

/** <scheduled-task-fired>: cron_create 的任务到点 (core server/main.ts setCronFireCallback) */
export interface ScheduledTaskFired {
  cron: string;
  prompt: string;
  lateByMinutes?: number;
}

export function parseScheduledTaskFired(text: string): ScheduledTaskFired | null {
  const trimmed = (text || '').trim();
  if (!trimmed.startsWith('<scheduled-task-fired>')) return null;
  const late = Number(pickTag(trimmed, 'late-by-minutes'));
  return {
    cron: decodeXml(pickTag(trimmed, 'cron')),
    prompt: decodeXml(pickTag(trimmed, 'prompt')),
    lateByMinutes: Number.isFinite(late) && late > 0 ? late : undefined,
  };
}

/** <life-reminder-fired>: schedule_reminder 到点 (desktop reminderJobRunner) */
export interface ReminderFired {
  title: string;
  context?: string;
  lateByMinutes?: number;
}

export function parseReminderFired(text: string): ReminderFired | null {
  const trimmed = (text || '').trim();
  if (!trimmed.startsWith('<life-reminder-fired>')) return null;
  const late = Number(pickTag(trimmed, 'late-by-minutes'));
  return {
    title: decodeXml(pickTag(trimmed, 'title')),
    context: decodeXml(pickTag(trimmed, 'context')) || undefined,
    lateByMinutes: Number.isFinite(late) && late > 0 ? late : undefined,
  };
}

/** <session-message>: 本机别的会话用 send_to_session 发来的话 (core runtime/peers/sessionPeers.ts) */
export interface SessionMessage {
  fromName: string;
  fromSessionId: string;
  fromCwd: string;
  fromClient: 'cli' | 'desktop' | string;
  body: string;
}

export function parseSessionMessage(text: string): SessionMessage | null {
  const trimmed = (text || '').trim();
  if (!trimmed.startsWith('<session-message>')) return null;
  return {
    fromName: decodeXml(pickTag(trimmed, 'from')),
    fromSessionId: decodeXml(pickTag(trimmed, 'from-session')),
    fromCwd: decodeXml(pickTag(trimmed, 'from-cwd')),
    fromClient: pickTag(trimmed, 'from-client'),
    body: decodeXml(pickTag(trimmed, 'body')),
  };
}

/** <monitor-event>: monitor_start / monitor_poll 命中或到期 (core runtime/shell/monitorRegistry.ts) */
export interface MonitorEvent {
  label: string;
  outcome: 'fired' | 'timeout' | string;
  watching: string;
  fire: string;
  detail: string;
}

export function parseMonitorEvent(text: string): MonitorEvent | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('<monitor-event>')) return null;
  return {
    label: decodeXml(pickTag(trimmed, 'label')),
    outcome: pickTag(trimmed, 'outcome') || 'fired',
    watching: decodeXml(pickTag(trimmed, 'watching')),
    fire: pickTag(trimmed, 'fire'),
    detail: decodeXml(pickTag(trimmed, 'detail')),
  };
}

/**
 * 一次性 router: 给一段文本判断它是不是某种系统 XML, 返回 hit 类型 + 解析结果.
 *   MessageRow / 后续 cell router 都用这个, 避免每次 3 个 parser 各跑一遍.
 */
export type SystemMessageHit =
  | { kind: 'background_shell'; data: BackgroundShellNotification }
  | { kind: 'agent_completion'; data: AgentCompletion }
  | { kind: 'scheduled_wakeup'; data: ScheduledWakeup }
  | { kind: 'monitor_event'; data: MonitorEvent }
  | { kind: 'scheduled_task'; data: ScheduledTaskFired }
  | { kind: 'reminder'; data: ReminderFired }
  | { kind: 'session_message'; data: SessionMessage }
  | null;

export function detectSystemMessage(text: string): SystemMessageHit {
  if (!text) return null;
  const trimmed = text.trim();
  // 快速前缀判断, 避免 3 个 regex 各跑
  if (trimmed.startsWith('<background-task-notification>')) {
    const data = parseBackgroundTaskNotification(text);
    return data ? { kind: 'background_shell', data } : null;
  }
  if (trimmed.startsWith('<agent-completion>')) {
    const data = parseAgentCompletion(text);
    return data ? { kind: 'agent_completion', data } : null;
  }
  if (trimmed.startsWith('<scheduled-wakeup>')) {
    const data = parseScheduledWakeup(text);
    return data ? { kind: 'scheduled_wakeup', data } : null;
  }
  if (trimmed.startsWith('<monitor-event>')) {
    const data = parseMonitorEvent(text);
    return data ? { kind: 'monitor_event', data } : null;
  }
  if (trimmed.startsWith('<scheduled-task-fired>')) {
    const data = parseScheduledTaskFired(text);
    return data ? { kind: 'scheduled_task', data } : null;
  }
  if (trimmed.startsWith('<life-reminder-fired>')) {
    const data = parseReminderFired(text);
    return data ? { kind: 'reminder', data } : null;
  }
  if (trimmed.startsWith('<session-message>')) {
    const data = parseSessionMessage(text);
    return data ? { kind: 'session_message', data } : null;
  }
  return null;
}

const BUS_EVENT_BLOCK = /<(background-task-notification|agent-completion|scheduled-wakeup|scheduled-task-fired|life-reminder-fired|monitor-event|session-message)>[\s\S]*?<\/\1>/g;

export function detectSystemMessages(text: string): Exclude<SystemMessageHit, null>[] {
  if (!isBusEventMessage(text)) return [];
  const hits: Exclude<SystemMessageHit, null>[] = [];
  for (const m of text.matchAll(BUS_EVENT_BLOCK)) {
    const hit = detectSystemMessage(m[0]);
    if (hit) hits.push(hit);
  }
  return hits;
}
