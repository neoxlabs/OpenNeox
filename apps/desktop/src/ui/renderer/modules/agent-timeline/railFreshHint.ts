import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface RailSeen {
  /** 第一次看到这个会话的右栏的时刻 —— 早于它的改动不算"新" (否则刷新一下老标签全亮) */
  since: number;
  /** surfaceId → 用户最后一次看到它时它的 updatedAt */
  at: Map<string, number>;
}

/* 模块级: 右栏每次面板展开都会卸载, 状态不能挂在组件里 */
const seenBySession = new Map<string, RailSeen>();

export function railSeenFor(sessionId: string | null): RailSeen {
  const key = sessionId ?? '';
  let s = seenBySession.get(key);
  if (!s) {
    s = { since: Date.now(), at: new Map() };
    seenBySession.set(key, s);
  }
  return s;
}

const HINT_KEY = 'neox:rail-fresh-hint-count';
const HINT_LIMIT = 3;
/** 气泡挂多久自己收 —— 它是提示不是拦路, 不需要用户去点掉 */
const HINT_MS = 8000;

function hintCount(): number {
  try { return Number(localStorage.getItem(HINT_KEY) || '0') || 0; } catch { return HINT_LIMIT; }
}

/**
 * 返回这一刻该挂引导气泡的那一行 (没有 → null)。
 * 每出现一次新的"刚做好"就算一次, 满 HINT_LIMIT 次以后永远不再出。
 */
export function useRailFirstTimeHint(freshIds: ReadonlySet<string>): string | null {
  const [hintId, setHintId] = useState<string | null>(null);
  const first = freshIds.values().next().value as string | undefined;
  useEffect(() => {
    if (!first || hintId === first) return;
    const n = hintCount();
    if (n >= HINT_LIMIT) return;
    try { localStorage.setItem(HINT_KEY, String(n + 1)); } catch {  }
    setHintId(first);
    const t = window.setTimeout(() => setHintId(null), HINT_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first]);
  /* 那一行被点开了 (不再是"新") → 气泡立刻收 */
  return hintId && freshIds.has(hintId) ? hintId : null;
}

/**
 * 引导气泡本体。放在要指的那一行 <li> 里 (靠它量位置), 画到 body 上 ——
 * 右栏滚动区是 overflow-x: hidden, 往左伸出去的气泡在栏内会被裁掉。
 */
export const RailHintBubble: React.FC<{ text: string }> = ({ text }) => {
  const probe = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  useLayoutEffect(() => {
    const row = probe.current?.parentElement;
    if (!row) return;
    const r = row.getBoundingClientRect();
    setPos({ top: r.top + r.height / 2, right: window.innerWidth - r.left + 10 });
  }, []);
  return React.createElement(
    React.Fragment,
    null,
    React.createElement('span', { ref: probe, hidden: true }),
    pos && createPortal(
      React.createElement('span', {
        className: 'atl-ctx-rail__hint',
        role: 'status',
        style: { top: pos.top, right: pos.right },
      }, text),
      document.body,
    ),
  );
};
