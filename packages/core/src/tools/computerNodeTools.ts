
import type { Tool } from '@neoxlabs/kernel/types/index.js';

export const COMPUTER_ACTIONS = [
  'calendar_events', 'calendar_add', 'apple_reminders', 'contacts_search', 'send_imessage', 'notify',
] as const;
export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];

export interface ComputerExecRequest { tool: ComputerAction; args: Record<string, unknown> }
export interface ComputerExecResult { ok: boolean; output: string }
export type ComputerExecutor = (req: ComputerExecRequest) => Promise<ComputerExecResult>;

let executor: ComputerExecutor | null = null;
export function setComputerExecutor(fn: ComputerExecutor | null): void { executor = fn; }
export function getComputerExecutor(): ComputerExecutor | null { return executor; }

export const computerTool: Tool = {
  name: 'computer',
  description:
    "Act on the user's Mac (the Neox desktop app must be running and signed in). Pick `action` and pass its `args`:\n" +
    '- calendar_events {days_ahead?, days_back?, calendar?} — read Mac Calendar events (iCloud / Exchange / Google calendars added to the Mac).\n' +
    '- calendar_add {title, start, end?, location?, notes?, calendar?} — put an event on the Mac calendar; local time "YYYY-MM-DD HH:mm".\n' +
    '- apple_reminders {action:"list"|"add"|"complete", title?, due?, list_name?, notes?} — the system Reminders app (syncs to iPhone).\n' +
    '- contacts_search {query} — phone numbers / emails / birthday from Mac Contacts.\n' +
    '- send_imessage {recipient, message} — send an iMessage from the user\'s own Messages app. Only when the user asked for iMessage / to send from the Mac; for an SMS / text message / 短信 use the phone tool\'s send_sms instead.\n' +
    '- notify {title, body} — pop a notification on the Mac screen.\n' +
    'Calendar / reminders / contacts / messages are also synced into the personal records (pilot_query) — query there first for past data; use this tool for what is live right now or to change something.\n' +
    'If the computer is off or asleep the call fails: say so and use the phone or the board instead.',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...COMPUTER_ACTIONS] },
      args: { type: 'object', description: 'Arguments for the action (see the list above).' },
    },
    required: ['action'],
  },
  function: async (raw: unknown) => {
    const a = (raw ?? {}) as { action?: string; args?: unknown };
    const action = a.action as ComputerAction;
    if (!COMPUTER_ACTIONS.includes(action)) {
      return JSON.stringify({ success: false, error: `action must be one of ${COMPUTER_ACTIONS.join(', ')}` });
    }
    const run = getComputerExecutor();
    if (!run) return JSON.stringify({ success: false, error: 'The user\'s computer is not linked to you.' });
    const args = a.args && typeof a.args === 'object' ? (a.args as Record<string, unknown>) : {};
    try {
      const r = await run({ tool: action, args });
      return JSON.stringify({ success: r.ok, ...(r.ok ? { result: r.output } : { error: r.output }) });
    } catch (err) {
      return JSON.stringify({ success: false, error: String((err as Error)?.message ?? err) });
    }
  },
};
