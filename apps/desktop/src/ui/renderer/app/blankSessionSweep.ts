
import { useCallback, useEffect, useRef } from 'react';

const AUTO_NAME_RE = /^(New Chat\b|工作·\d{1,2}月\d{1,2}日$|Work · )/i;
export function isAutoCreatedSession(id: string, name: string | null | undefined): boolean {
  return /^session-\d{10,}-/.test(id) && (!name || AUTO_NAME_RE.test(name.trim()));
}

export interface BlankSweepDeps {
  getSession: (id: string) => Promise<{ name?: string | null; kind?: string | null; pinned?: boolean; messageCount?: number | null; messages?: unknown[] | null } | null | undefined>;
  /** 内存里的 timeline (还没落盘的也在这) */
  memoryTimelineLength: (id: string) => number;
  /** 磁盘上的 timeline */
  loadTimelineLength: (id: string) => Promise<number>;
  isBusy: (id: string) => boolean;
}

export async function isRecyclableBlankSession(id: string, deps: BlankSweepDeps): Promise<boolean> {
  if (!id || deps.isBusy(id)) return false;
  if (deps.memoryTimelineLength(id) > 0) return false;
  const s = await deps.getSession(id);
  if (!s || !isAutoCreatedSession(id, s.name)) return false;
  if ((s.kind ?? 'chat') !== 'chat' || s.pinned) return false;
  if ((s.messageCount ?? 0) > 0 || (s.messages?.length ?? 0) > 0) return false;
  if ((await deps.loadTimelineLength(id)) > 0) return false;
  /* 查磁盘期间可能刚好发了第一句 */
  return deps.memoryTimelineLength(id) === 0 && !deps.isBusy(id);
}

/** 启动扫: 只看一分钟前建的 (刚建还没来得及打字的不算), 当前会话不动 */
export const SWEEP_MIN_AGE_MS = 60_000;

export function sweepCandidates(
  sessions: Array<{ id: string; name?: string | null; createdAt?: number; kind?: string | null; messageCount?: number | null }>,
  activeId: string | null,
  now: number,
): string[] {
  return sessions
    .filter((s) => s.id !== activeId && isAutoCreatedSession(s.id, s.name))
    .filter((s) => (s.kind ?? 'chat') === 'chat' && (s.messageCount ?? 0) === 0)
    .filter((s) => typeof s.createdAt === 'number' && now - s.createdAt > SWEEP_MIN_AGE_MS)
    .map((s) => s.id);
}

/**
 * 接进 NeoxRuntimeBridge: 活跃会话一换, 刚离开的那条是空的就删; 会话列表第一次加载完扫一遍。
 * remove 只做删除本身 (IPC + 列表 + timeline 缓存), 不弹提示 —— 用户没做任何操作。
 */
export function useBlankSessionRecycler(input: {
  activeSessionId: string | null;
  sessionsLoaded: boolean;
  sessions: Array<{ id: string; name?: string | null; createdAt?: number; kind?: string | null; messageCount?: number | null }>;
  activeIdRef: { current: string | null };
  deps: BlankSweepDeps;
  remove: (id: string) => Promise<void>;
}): void {
  const { activeSessionId, sessionsLoaded, sessions, activeIdRef, deps, remove } = input;
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const removeRef = useRef(remove);
  removeRef.current = remove;

  const recycle = useCallback(async (id: string) => {
    try {
      if (!(await isRecyclableBlankSession(id, depsRef.current))) return;
      if (activeIdRef.current === id) return; /* 查的这会儿用户又切回去了 */
      await removeRef.current(id);
    } catch (err) {
      console.warn('[blankSessionSweep] recycle failed', id, err);
    }
  }, [activeIdRef]);

  const prevRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = activeSessionId;
    if (prev && prev !== activeSessionId) void recycle(prev);
  }, [activeSessionId, recycle]);

  const sweptRef = useRef(false);
  useEffect(() => {
    if (!sessionsLoaded || sweptRef.current || sessions.length === 0) return;
    sweptRef.current = true;
    const ids = sweepCandidates(sessions, activeIdRef.current, Date.now()).slice(0, 50);
    void (async () => { for (const id of ids) await recycle(id); })();
  }, [sessionsLoaded, sessions, activeIdRef, recycle]);
}
