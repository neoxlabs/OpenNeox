
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { buildImageToolResult } from './image/imageProcessor.js';

export const PHONE_ACTIONS = [
  'set_alarm', 'phone_call', 'send_sms', 'read_sms', 'contacts_search',
  'phone_calendar', 'get_location', 'open_app', 'read_notifications', 'sensors', 'camera', 'phone_ui',
] as const;
export type PhoneAction = (typeof PHONE_ACTIONS)[number];

export interface PhoneExecRequest { tool: PhoneAction; args: Record<string, unknown> }
/** image: 拍照时手机把图片本身带回来 (base64), 这里转成模型看得见的图片结果 */
export interface PhoneExecResult { ok: boolean; output: string; image?: { data: string; media_type: string } }
export type PhoneExecutor = (req: PhoneExecRequest) => Promise<PhoneExecResult>;

let executor: PhoneExecutor | null = null;
export function setPhoneExecutor(fn: PhoneExecutor | null): void { executor = fn; }
export function getPhoneExecutor(): PhoneExecutor | null { return executor; }

export const phoneTool: Tool = {
  name: 'phone',
  description:
    "Act on the user's paired Android phone (the Neox app must be connected). Pick `action` and pass its `args`:\n" +
    '- set_alarm {op:"alarm", hour, minute, label} | {op:"timer", seconds, label} — system clock app rings, works with Neox closed. ' +
    'Use for "wake me up at 7" (also schedule_reminder if they want a call).\n' +
    '- phone_call {to} — real call from the phone; `to` is a number or contact name.\n' +
    '- send_sms {to, text}\n' +
    '- read_sms {query?, since_minutes?, limit?} — e.g. verification codes: query "验证码", since_minutes 5.\n' +
    '- contacts_search {query}\n' +
    '- phone_calendar {op:"list", from?, to?} | {op:"add", title, start, end?, location?, notes?} — local time "YYYY-MM-DD HH:mm".\n' +
    '- get_location {} — where the phone is now (lat/lng).\n' +
    '- open_app {op:"list", query} | {op:"open", package} | {op:"uri", uri} — navigation: uri "geo:0,0?q=place".\n' +
    '- read_notifications {limit?} — recent phone notifications (delivery, bank, chat).\n' +
    '- sensors {} — ambient temperature / humidity / light / pressure / proximity / moving-or-still, battery level, charging. Most phones lack temp/humidity sensors (listed in missing) — then say you do not know.\n' +
    '- camera {facing?: back|front} — silently take a photo and look at it (you get the image). The phone must be in hand with Neox open. Ask before photographing other people.\n' +
    '- phone_ui {op, target?, text?, direction?, x?, y?, confirmed?} — operate any app on the phone like a person (order food, call a ride, check an order). ' +
    'Open the app with open_app first, then op:"snapshot" lists the screen with numbered elements; op:"tap" target:N; op:"type" target:N text; op:"scroll" direction:"down"|"up"; op:"back"|"home"; ' +
    'op:"screenshot" to see it as an image when elements have no text, then op:"tap_at" x y in screenshot pixels. Every action returns the new screen. ' +
    'The pay / place-order button is blocked: report_to_user(status=blocked) with what and how much first; only after the user agrees, tap it with confirmed:true.\n' +
    'If the phone is not connected the call fails; tell the user to open Neox on the phone.',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  capabilities: ['gui'],
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...PHONE_ACTIONS] },
      args: { type: 'object', description: 'Arguments for the action (see the list above).' },
    },
    required: ['action'],
  },
  function: async (raw: unknown) => {
    const a = (raw ?? {}) as { action?: string; args?: unknown };
    const action = a.action as PhoneAction;
    if (!PHONE_ACTIONS.includes(action)) {
      return JSON.stringify({ success: false, error: `action must be one of ${PHONE_ACTIONS.join(', ')}` });
    }
    const run = getPhoneExecutor();
    if (!run) return JSON.stringify({ success: false, error: 'Phone actions are only available in the Neox desktop app with a paired phone.' });
    const args = a.args && typeof a.args === 'object' ? (a.args as Record<string, unknown>) : {};
    try {
      const r = await run({ tool: action, args });
      if (r.ok && r.image?.data) {
        const screen = action === 'phone_ui';
        return buildImageToolResult([{ base64: r.image.data, mediaType: r.image.media_type || 'image/jpeg', label: screen ? 'phone screen' : 'phone camera' }],
          screen
            ? 'Screenshot of the phone screen just now. For op:"tap_at", give x / y in this image\'s pixels.'
            : 'Photo taken with the phone camera just now.');
      }
      return JSON.stringify({ success: r.ok, ...(r.ok ? { result: r.output } : { error: r.output }) });
    } catch (err) {
      return JSON.stringify({ success: false, error: String((err as Error)?.message ?? err) });
    }
  },
};

export const PHONE_TOOLS: Tool[] = [phoneTool];
