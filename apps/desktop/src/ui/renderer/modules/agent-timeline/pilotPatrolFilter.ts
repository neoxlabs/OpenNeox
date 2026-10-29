
export const PILOT_PATROL_TAG = '<pilot-patrol';
/** 手机上来了通知 / 短信 / 未接来电, 宿主叫醒它看一眼 (services/pilotSignals.ts) —— 跟巡检同一个显示规矩 */
export const PILOT_SIGNAL_TAG = '<phone-signal';
/** 电脑离线期间手机上的它办过的事, 电脑回来时交回主脑 (手机 pilot_local.dart) —— 同一个显示规矩 */
export const PILOT_OFFLINE_TAG = '<phone-offline';
export const PILOT_QUIET = '[quiet]';
const isHostTrigger = (t: string) => {
  const s = t.trimStart();
  return s.startsWith(PILOT_PATROL_TAG) || s.startsWith(PILOT_SIGNAL_TAG) || s.startsWith(PILOT_OFFLINE_TAG);
};

interface EntryLike {
  type?: string;
  detail?: unknown;
  output?: unknown;
  text?: unknown;
}

/* 跟 mapTimeline 的 getMessageText 同一个取法 */
function textOf(e: EntryLike): string {
  return String(e.detail || e.output || e.text || '');
}

const ASSISTANT_TYPES = new Set(['assistant_message', 'agent_message', 'assistant_prefix']);
const isUser = (e: EntryLike) => e.type === 'user_message';
const isAssistant = (e: EntryLike) => ASSISTANT_TYPES.has(e.type ?? '');

export function dropPilotPatrolNoise<T extends EntryLike>(entries: T[], getText: (e: T) => string = textOf as (e: T) => string): T[] {
  if (!entries.some((e) => isUser(e) && isHostTrigger(getText(e)))) return entries;
  const out: T[] = [];
  let i = 0;
  while (i < entries.length) {
    const e = entries[i];
    if (!(isUser(e) && isHostTrigger(getText(e)))) {
      out.push(e);
      i += 1;
      continue;
    }
    /* 这一轮 = 触发之后到下一条用户消息之前 */
    let end = i + 1;
    while (end < entries.length && !isUser(entries[end])) end += 1;
    const turn = entries.slice(i + 1, end);
    const replies = turn.filter(isAssistant).map((r) => getText(r).trim()).filter(Boolean);
    const quiet = replies.length === 0 || replies.every((r) => r === PILOT_QUIET || r.endsWith(PILOT_QUIET));
    /* 还在跑 (没回复) 也先藏着: 多半是 [quiet], 真有事回复一到就会整轮出现 */
    if (!quiet) out.push(...turn.filter((r) => !(isAssistant(r) && getText(r).trim() === PILOT_QUIET)));
    i = end;
  }
  return out;
}
