import { useSyncExternalStore } from 'react';
import type { TimelineEntry } from '../utils/workspaceUtils';

/* useSyncExternalStore 要求 getSnapshot 返回**稳定引用**, 否则无限 rerender
 * (见 memory/feedback_usesyncexternalstore_stable_snapshot)。冻结的空数组就是那个常量。
 * `as unknown as` 是 TS 要求的写法: Object.freeze([]) 推成 readonly never[],
 * 跟 TimelineEntry[] 没有交集, 单层 as 会被 TS2352 拦下。运行时就是一个空数组。 */
const EMPTY: TimelineEntry[] = Object.freeze([]) as unknown as TimelineEntry[];

let entries: TimelineEntry[] = EMPTY;
let sessionId: string | null = null;
let version = 0;

let hydratingSessionId: string | null = null;

let pendingEntries: TimelineEntry[] | null = null;
let pendingSessionId: string | null = null;
let rafId = 0;

const listeners = new Set<() => void>();

const rafImpl =
  typeof globalThis !== 'undefined' && typeof globalThis.requestAnimationFrame === 'function'
    ? globalThis.requestAnimationFrame.bind(globalThis)
    : null;
const cancelRafImpl =
  typeof globalThis !== 'undefined' && typeof globalThis.cancelAnimationFrame === 'function'
    ? globalThis.cancelAnimationFrame.bind(globalThis)
    : null;

const scheduleFrame = (cb: () => void): number =>
  rafImpl ? rafImpl(cb) : (setTimeout(cb, 16) as unknown as number);
const cancelFrame = (id: number): void => {
  if (cancelRafImpl) cancelRafImpl(id);
  else clearTimeout(id);
};

function notify(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* 单个订阅者异常不影响其它 */
    }
  }
}

function flushPending(): void {
  rafId = 0;
  if (pendingEntries === null) return;
  const nextEntries = pendingEntries;
  const nextSid = pendingSessionId;
  pendingEntries = null;
  if (nextEntries === entries && nextSid === sessionId) return;
  entries = nextEntries.length === 0 ? EMPTY : nextEntries;
  sessionId = nextSid;
  version += 1;
  notify();
}

export type PublishTimelineFeedOptions = {
  /** 阻塞交互 / 切会话: 跳过 rAF, 同帧可见 */
  immediate?: boolean;
};

/**
 * Bridge / timelineStore 出口调用。`next` 应为调用方持有的数组引用
 * (合批期内多次 publish 只保留最后一次)。
 */
export function publishTimelineFeed(
  nextSessionId: string | null,
  next: TimelineEntry[],
  opts?: PublishTimelineFeedOptions,
): void {
  pendingEntries = next;
  pendingSessionId = nextSessionId;
  if (opts?.immediate) {
    if (rafId) {
      cancelFrame(rafId);
      rafId = 0;
    }
    flushPending();
    return;
  }
  if (rafId) return;
  rafId = scheduleFrame(flushPending);
}

/**
 * 标记/解除水合。**必须成对**, 且解除要放在 finally ——
 * 加载失败时没解除的话, 界面会永远停在骨架上, 比闪一下糟得多。
 */
export function setTimelineHydrating(sid: string | null): void {
  if (hydratingSessionId === sid) return;
  hydratingSessionId = sid;
  notify();
}

export function getTimelineHydratingSessionId(): string | null {
  return hydratingSessionId;
}

export function useTimelineHydratingSessionId(): string | null {
  return useSyncExternalStore(subscribeTimelineFeed, getTimelineHydratingSessionId, () => null);
}

export function getTimelineFeed(): TimelineEntry[] {
  return entries;
}

export function getTimelineFeedSessionId(): string | null {
  return sessionId;
}

export function getTimelineFeedVersion(): number {
  return version;
}

export function subscribeTimelineFeed(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前活跃会话 timeline — 仅 feed 消费者订阅, 不经 Runtime Context */
export function useTimelineFeed(): TimelineEntry[] {
  return useSyncExternalStore(subscribeTimelineFeed, getTimelineFeed, () => EMPTY);
}

export function useTimelineFeedSessionId(): string | null {
  return useSyncExternalStore(
    subscribeTimelineFeed,
    getTimelineFeedSessionId,
    () => null,
  );
}
