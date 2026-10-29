import { useEffect, useState } from 'react';

const KEY_DEFAULT = 'neox:chat-mode:default';
const KEY_SESSIONS = 'neox:chat-mode:sessions';
const MAX_SESSIONS = 500;
const EVENT = 'neox:chat-mode-changed';

let defaultOn = false;
let bySession: Record<string, boolean> = {};

try {
  defaultOn = localStorage.getItem(KEY_DEFAULT) === '1';
  const raw = localStorage.getItem(KEY_SESSIONS);
  const parsed = raw ? JSON.parse(raw) : null;
  if (parsed && typeof parsed === 'object') bySession = parsed as Record<string, boolean>;
} catch { /* 读不到 = Agent */ }

function persist(): void {
  try {
    const ids = Object.keys(bySession);
    if (ids.length > MAX_SESSIONS) {
      /* 插入顺序即时间顺序, 丢最早的 */
      for (const id of ids.slice(0, ids.length - MAX_SESSIONS)) delete bySession[id];
    }
    localStorage.setItem(KEY_DEFAULT, defaultOn ? '1' : '0');
    localStorage.setItem(KEY_SESSIONS, JSON.stringify(bySession));
  } catch { /* 存不下只影响下次启动 */ }
}

function emit(): void {
  try { window.dispatchEvent(new CustomEvent(EVENT)); } catch { /* noop */ }
}

/** 落库 (chat:C1-01)。失败不抛 —— 界面照旧用本机值, 下次切还会再写一次。 */
function persistSessionChatMode(sessionId: string, on: boolean): void {
  try {
    const api = (window as unknown as { neox?: { setSessionChatMode?: (id: string, v: boolean) => Promise<unknown> } }).neox;
    void api?.setSessionChatMode?.(sessionId, on)?.catch(() => { /* 写库失败不影响本轮 */ });
  } catch { /* 非 electron 环境 (测试 / 纯 web) */ }
}

/** 这个会话现在是不是聊天模式。
 *  本机切过的值优先 (切的同时已经写库); 没切过 (新设备 / 重装 / 手机打开) 才看会话记录。 */
export function isChatMode(sessionId?: string | null, recordChatMode?: boolean | null): boolean {
  if (sessionId && Object.prototype.hasOwnProperty.call(bySession, sessionId)) return bySession[sessionId] === true;
  if (recordChatMode === true || recordChatMode === false) return recordChatMode;
  return defaultOn;
}

/** 用户切换: 改这个会话, 同时改新会话的默认值。 */
export function setChatMode(sessionId: string | null | undefined, on: boolean): void {
  defaultOn = on;
  if (sessionId) {
    delete bySession[sessionId];
    bySession[sessionId] = on;
    persistSessionChatMode(sessionId, on);
  }
  persist();
  emit();
}

/** 发消息时调: 还没钉过的会话把当前生效的模式钉住。
 *  当前生效 = 本机没切过时的会话记录值 (新设备打开聊天会话, 不能按本机默认值把它钉成 Agent)。 */
export function pinChatMode(sessionId: string, recordChatMode?: boolean | null): void {
  if (Object.prototype.hasOwnProperty.call(bySession, sessionId)) {
    /* 已经钉过: 顺手把库补上 (存量会话第一次在新版本里发消息的机会) */
    persistSessionChatMode(sessionId, bySession[sessionId] === true);
    return;
  }
  const effective = recordChatMode === true || recordChatMode === false ? recordChatMode : defaultOn;
  bySession[sessionId] = effective;
  persistSessionChatMode(sessionId, effective);
  persist();
  emit();
}

export function useChatMode(
  sessionId?: string | null,
  recordChatMode?: boolean | null,
): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => isChatMode(sessionId, recordChatMode));
  useEffect(() => {
    setOn(isChatMode(sessionId, recordChatMode));
    const sync = () => setOn(isChatMode(sessionId, recordChatMode));
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, [sessionId, recordChatMode]);
  return [on, (next: boolean) => setChatMode(sessionId, next)];
}

