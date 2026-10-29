
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { getCurrentChatSessionId } from '../runtime/shell/chatSessionContext.js';

export type ReportStatus = 'done' | 'blocked' | 'failed' | 'progress';
export type ReportUrgency = 'fyi' | 'attention' | 'urgent';

export interface ReportRequest {
  sessionId?: string;
  status: ReportStatus;
  /** 任务板上那一行 */
  title: string;
  /** 结论 + 做了什么 + 替用户定了什么 —— 念得出来的话 */
  summary: string;
  options?: string[];
  urgency: ReportUrgency;
}

export interface ReportResult {
  id: string;
  /** 宿主会怎么送到人, 原样告诉模型 */
  delivery: string;
}

export type ReportExecutor = (req: ReportRequest) => Promise<ReportResult>;

let executor: ReportExecutor | null = null;
export function setReportExecutor(fn: ReportExecutor | null): void {
  executor = fn;
}
export function getReportExecutor(): ReportExecutor | null {
  return executor;
}

const STATUSES: ReportStatus[] = ['done', 'blocked', 'failed', 'progress'];
const URGENCIES: ReportUrgency[] = ['fyi', 'attention', 'urgent'];

export const reportToUserTool: Tool = {
  name: 'report_to_user',
  description:
    'Report to the user, the way an employee reports to their boss. This is the ONLY way to reach the user outside a live conversation — '
    + 'Neox decides how to deliver it (task board, notification, phone call, retries) from status and urgency. Returns immediately; keep working on anything else.\n'
    + '- done: the job is finished AND you verified it (tests ran, file opened, page checked). Say what you decided on their behalf.\n'
    + '- blocked: the next step sends something to other people, spends money, or cannot be undone. Finish everything else first, then report with at most two options.\n'
    + '- failed: you could not do it; say why and what you tried.\n'
    + '- progress: a long job passed a milestone the user would want to know about (rarely).\n'
    + 'urgency: fyi = shows on the board; attention = notifies, and calls them if unread for 30 minutes; urgent = calls now (they asked to be called when done, or something they watch broke).',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: false,
  capabilities: ['gui'],
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: STATUSES },
      title: { type: 'string', description: 'One short line for the task board, e.g. "登录功能做完了" / "订票要你选时段".' },
      summary: { type: 'string', description: 'Conclusion first, then what you did and what you decided for them. Spoken style, 1-4 sentences, no markdown.' },
      options: { type: 'array', items: { type: 'string' }, description: 'blocked only: at most two short choices the user can tap.' },
      urgency: { type: 'string', enum: URGENCIES },
    },
    required: ['status', 'title', 'summary', 'urgency'],
  },
  function: async (args: unknown) => {
    const a = (args ?? {}) as Partial<ReportRequest>;
    const status = STATUSES.includes(a.status as ReportStatus) ? (a.status as ReportStatus) : 'done';
    const urgency = URGENCIES.includes(a.urgency as ReportUrgency) ? (a.urgency as ReportUrgency) : 'fyi';
    const title = String(a.title ?? '').trim();
    const summary = String(a.summary ?? '').trim();
    if (!title || !summary) return JSON.stringify({ success: false, error: 'title and summary are both required' });
    const options = Array.isArray(a.options) ? a.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 2) : undefined;
    const run = getReportExecutor();
    if (!run) return JSON.stringify({ success: false, error: 'Reporting is only available in the Neox desktop app. Say it in your reply instead.' });
    try {
      const r = await run({ sessionId: getCurrentChatSessionId(), status, title, summary, options, urgency });
      return JSON.stringify({ success: true, id: r.id, delivery: r.delivery,
        next: status === 'blocked'
          ? 'The user will answer when they see it; their answer arrives as a new message. Do not wait — continue with other work or end your turn.'
          : 'Reported. End your turn unless there is more work.' });
    } catch (err) {
      return JSON.stringify({ success: false, error: String((err as Error)?.message ?? err) });
    }
  },
};

export const REPORT_TOOLS: Tool[] = [reportToUserTool];
