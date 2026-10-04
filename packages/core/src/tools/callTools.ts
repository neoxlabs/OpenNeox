
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { getCurrentChatSessionId } from '../runtime/shell/chatSessionContext.js';

export type CallUrgency = 'asked' | 'decision' | 'alert' | 'normal';

export interface CallUserRequest {
  sessionId?: string;
  /** 来电卡上那一行: 为什么打 */
  reason: string;
  /** 接通后说的第一句 —— 响铃时就合成好, 接起即播 */
  opening: string;
  urgency: CallUrgency;
}

export type CallOutcome = 'answered' | 'declined' | 'missed' | 'busy' | 'blocked';

export interface CallUserResult {
  status: CallOutcome;
  /** blocked / busy 的原因 (勿扰时段 / 超过每小时上限 / 正在通话 / 麦克风被占用 / 用户关掉了这类来电) */
  detail?: string;
}

export type CallUserExecutor = (req: CallUserRequest) => Promise<CallUserResult>;

let executor: CallUserExecutor | null = null;

export function setCallUserExecutor(fn: CallUserExecutor | null): void {
  executor = fn;
}

export function getCallUserExecutor(): CallUserExecutor | null {
  return executor;
}

const NEXT_STEP: Record<CallOutcome, string> = {
  answered: 'The user picked up and has heard your opening. Their spoken replies arrive as the next user messages. End this turn now; do not repeat the opening.',
  declined: 'The user declined the call. Send one short message instead that says what you needed. Do not call again for this.',
  missed: 'The user did not pick up. Send one short message instead that says what you needed. Do not call again right away.',
  busy: 'The user is busy (already in a call, the mic is in use, or quiet hours). Send a message instead.',
  blocked: 'This call was not placed. Send a message instead.',
};

export const callUserTool: Tool = {
  name: 'call_user',
  description:
    'Ring the user on their desktop and start a voice call. Only use when (1) the user explicitly asked to be called, ' +
    '(2) work is blocked on their decision and waiting has a cost, or (3) something they asked you to watch broke. ' +
    'A routine "done" is a message, not a call. Blocks until the call is answered, declined or missed (~25s). ' +
    'If it does not connect, send a message instead.',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  capabilities: ['gui'],
  parameters: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'One short line shown on the incoming-call card: why you are calling (e.g. "周报要你定一处").',
      },
      opening: {
        type: 'string',
        description: 'The first sentence you say when they pick up. Straight to the point, spoken style, no greeting.',
      },
      urgency: {
        type: 'string',
        enum: ['asked', 'decision', 'alert', 'normal'],
        description: 'asked = the user told you to call; decision = blocked on their call; alert = something they watch broke; normal = anything else (may be turned into a notification).',
      },
    },
    required: ['reason', 'opening', 'urgency'],
  },
  function: async (args: unknown) => {
    const a = (args ?? {}) as Partial<CallUserRequest>;
    const reason = String(a.reason ?? '').trim();
    const opening = String(a.opening ?? '').trim();
    const urgency: CallUrgency = (['asked', 'decision', 'alert', 'normal'] as const).includes(a.urgency as CallUrgency)
      ? (a.urgency as CallUrgency)
      : 'normal';
    if (!reason || !opening) {
      return JSON.stringify({ success: false, error: 'reason and opening are both required' });
    }
    const run = getCallUserExecutor();
    if (!run) {
      return JSON.stringify({ success: false, status: 'blocked', error: 'Calling is only available in the Neox desktop app.', next: NEXT_STEP.blocked });
    }
    try {
      const r = await run({ sessionId: getCurrentChatSessionId(), reason, opening, urgency });
      return JSON.stringify({ success: r.status === 'answered', status: r.status, ...(r.detail ? { detail: r.detail } : {}), next: NEXT_STEP[r.status] });
    } catch (err) {
      return JSON.stringify({ success: false, status: 'blocked', error: String((err as Error)?.message ?? err), next: NEXT_STEP.blocked });
    }
  },
};

export const CALL_TOOLS: Tool[] = [callUserTool];
