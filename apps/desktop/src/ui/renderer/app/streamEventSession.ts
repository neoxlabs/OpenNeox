
/** onStream 回调收到的事件里, 跟归属有关的那部分 */
import { noteStreamDrop } from '../state/streamDropLedger';

export type StreamEventLike = { type?: string; sessionId?: string | null };

/**
 * 取这条流事件属于哪个会话。
 *
 * @returns 会话 id; 事件没带归属时返回 null（调用方应当**丢弃**该事件, 不要回落到
 *          "当前打开的会话" —— 那正是这个模块存在的原因）。
 */
export function streamEventSessionId(event: StreamEventLike | null | undefined): string | null {
  const id = event?.sessionId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * 取归属并在缺失时报错 —— 给"必须落到某个会话"的分支用 (append/update timeline)。
 *
 * 单独一个变体是为了让调用点读起来就是一句话, 而不是每处再写一遍 warn:
 * 三处各写一遍 console 文案, 下次排查时搜不到统一的关键字。
 */
export function requireStreamEventSession(
  event: StreamEventLike | null | undefined,
  context: string,
): string | null {
  const id = streamEventSessionId(event);
  if (!id) {
    noteStreamDrop(`no-session:${context}`, event);
    console.error(
      `[stream] 丢弃无会话归属的事件 — 上游必须带 sessionId, 不回落"当前会话" (${context})`,
      { type: event?.type },
    );
  }
  return id;
}
