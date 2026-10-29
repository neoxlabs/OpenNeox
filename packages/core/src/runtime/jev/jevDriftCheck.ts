import { askJev, type JevSettings } from './jevClient.js';

const ON_TRACK_FLOOR = 0.2;
export const DRIFT_MAX_NUDGES_PER_RUN = 2;
const MAX_REQUEST_LEN = 3000;
const REQUEST_TIMEOUT_MS = 3000;

/** 在轨概率; 请求失败返回 null */
export async function judgeOnTrack(settings: JevSettings, request: string, recent: string): Promise<number | null> {
  try {
    const r = await askJev(settings, { request: request.trim().slice(0, MAX_REQUEST_LEN), recent_actions: recent.trim() }, {
      on_track: {
        type: 'noul',
        instructions: { question: 'Are the agent\'s `recent_actions` still working toward what `request` asks for?' },
        criteria: {
          yes: 'The actions plausibly serve the request — including investigating, setting up, running checks, '
            + 'or fixing a problem that blocks it',
          no: 'The actions pursue a different goal the user did not ask for',
        },
      },
    }, { timeoutMs: REQUEST_TIMEOUT_MS });
    const a = r.answers.on_track;
    return a?.type === 'noul' ? a.noul : null;
  } catch {
    return null;
  }
}

export function isDrifting(onTrack: number | null): boolean {
  return onTrack !== null && onTrack < ON_TRACK_FLOOR;
}

export function driftReminder(request: string): string {
  const excerpt = request.trim().replace(/\s+/g, ' ').slice(0, 300);
  return `Check against the user's request: "${excerpt}". Your recent actions look unrelated to it. `
    + 'If this detour is needed for the request, say why in one line and continue; otherwise get back to the request.';
}
