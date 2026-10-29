const TIMELINE_SCROLL_STATE_LIMIT = 80;
const TIMELINE_SCROLL_STATE_WRITE_DEBOUNCE_MS = 220;
const FALLBACK_TIMELINE_SESSION_KEY = "__timeline__";
const TIMELINE_SCROLL_STATE_STORAGE_PREFIX = "timelineScrollState:v1:";

export interface PersistedTimelineScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  maxScroll: number;
  gapToBottom: number;
  anchorKey?: string;
  anchorIndex?: number;
  anchorOffsetTop?: number;
  atBottom: boolean;
  userScrolledAway: boolean;
  bottomStickIntent: boolean;
  rowsLength: number;
  updatedAt: number;
}

export const timelineScrollStateBySession = new Map<
  string,
  PersistedTimelineScrollState
>();
const timelineScrollStateLoadStatus = new Map<string, "loading" | "loaded">();
const timelineScrollStatePendingWrites = new Map<
  string,
  PersistedTimelineScrollState
>();
const timelineScrollStateWriteTimers = new Map<string, number>();
const timelineScrollStateLoadCallbacks = new Map<string, Set<() => void>>();

export function timelineSessionScrollKey(
  sessionId?: string | null,
  scrollScope?: string
): string {
  const key = sessionId || FALLBACK_TIMELINE_SESSION_KEY;
  return scrollScope && scrollScope !== "main" ? `${scrollScope}:${key}` : key;
}

function timelineScrollStateStorageKey(key: string): string {
  return `${TIMELINE_SCROLL_STATE_STORAGE_PREFIX}${key}`;
}

function isPersistedTimelineScrollState(
  value: unknown
): value is PersistedTimelineScrollState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<PersistedTimelineScrollState>;
  return (
    typeof state.scrollTop === "number" &&
    typeof state.scrollHeight === "number" &&
    typeof state.clientHeight === "number" &&
    typeof state.maxScroll === "number" &&
    typeof state.gapToBottom === "number" &&
    typeof state.atBottom === "boolean" &&
    typeof state.userScrolledAway === "boolean" &&
    typeof state.bottomStickIntent === "boolean" &&
    typeof state.rowsLength === "number" &&
    typeof state.updatedAt === "number" &&
    (state.anchorKey === undefined || typeof state.anchorKey === "string") &&
    (state.anchorIndex === undefined ||
      typeof state.anchorIndex === "number") &&
    (state.anchorOffsetTop === undefined ||
      typeof state.anchorOffsetTop === "number")
  );
}

function parseTimelineScrollState(
  raw: string | null | undefined
): PersistedTimelineScrollState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return isPersistedTimelineScrollState(value) ? value : null;
  } catch {
    return null;
  }
}

function cacheTimelineScrollState(
  key: string,
  state: PersistedTimelineScrollState
) {
  timelineScrollStateBySession.delete(key);
  timelineScrollStateBySession.set(key, state);
  while (timelineScrollStateBySession.size > TIMELINE_SCROLL_STATE_LIMIT) {
    const oldestKey = timelineScrollStateBySession.keys().next().value;
    if (!oldestKey) break;
    timelineScrollStateBySession.delete(oldestKey);
  }
}

function readTimelineScrollStateFromLocalStorage(
  key: string
): PersistedTimelineScrollState | null {
  if (typeof window === "undefined") return null;
  try {
    return parseTimelineScrollState(
      window.localStorage?.getItem(timelineScrollStateStorageKey(key))
    );
  } catch {
    return null;
  }
}

function writeTimelineScrollStateToLocalStorage(
  key: string,
  state: PersistedTimelineScrollState
) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(
      timelineScrollStateStorageKey(key),
      JSON.stringify(state)
    );
  } catch {
    /* UI state IPC is the primary durable path; localStorage is only a sync fallback. */
  }
}

function persistTimelineScrollStateNow(
  key: string,
  state: PersistedTimelineScrollState
) {
  writeTimelineScrollStateToLocalStorage(key, state);
  if (typeof window === "undefined") return;
  const api = window.neox;
  if (!api?.uiStateSet) return;
  void api
    .uiStateSet(timelineScrollStateStorageKey(key), JSON.stringify(state))
    .catch(() => {
      /* Scroll position must not break timeline rendering if persistence fails. */
    });
}

function schedulePersistTimelineScrollState(
  key: string,
  state: PersistedTimelineScrollState
) {
  cacheTimelineScrollState(key, state);
  if (typeof window === "undefined") return;
  timelineScrollStatePendingWrites.set(key, state);
  if (timelineScrollStateWriteTimers.has(key)) return;
  const timer = window.setTimeout(() => {
    timelineScrollStateWriteTimers.delete(key);
    const pending = timelineScrollStatePendingWrites.get(key);
    timelineScrollStatePendingWrites.delete(key);
    if (pending) persistTimelineScrollStateNow(key, pending);
  }, TIMELINE_SCROLL_STATE_WRITE_DEBOUNCE_MS);
  timelineScrollStateWriteTimers.set(key, timer);
}

export function flushTimelineScrollStateWrite(key: string) {
  if (typeof window !== "undefined") {
    const timer = timelineScrollStateWriteTimers.get(key);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timelineScrollStateWriteTimers.delete(key);
    }
  }
  const pending =
    timelineScrollStatePendingWrites.get(key) ??
    timelineScrollStateBySession.get(key);
  timelineScrollStatePendingWrites.delete(key);
  if (pending) persistTimelineScrollStateNow(key, pending);
}

export function rememberTimelineScrollState(
  key: string,
  state: PersistedTimelineScrollState
) {
  schedulePersistTimelineScrollState(key, state);
}

export function loadTimelineScrollStateSync(key: string) {
  if (timelineScrollStateBySession.has(key)) return true;
  const localState = readTimelineScrollStateFromLocalStorage(key);
  if (!localState) return false;
  cacheTimelineScrollState(key, localState);
  return true;
}

export function ensureDurableTimelineScrollStateLoaded(
  key: string,
  onLoaded: () => void
): "loading" | "loaded" {
  if (loadTimelineScrollStateSync(key)) {
    timelineScrollStateLoadStatus.set(key, "loaded");
    return "loaded";
  }
  const status = timelineScrollStateLoadStatus.get(key);
  if (status === "loading") {
    let callbacks = timelineScrollStateLoadCallbacks.get(key);
    if (!callbacks) {
      callbacks = new Set();
      timelineScrollStateLoadCallbacks.set(key, callbacks);
    }
    callbacks.add(onLoaded);
    return status;
  }
  if (status) return status;
  if (typeof window === "undefined" || !window.neox?.uiStateGet) {
    timelineScrollStateLoadStatus.set(key, "loaded");
    return "loaded";
  }
  timelineScrollStateLoadStatus.set(key, "loading");
  timelineScrollStateLoadCallbacks.set(key, new Set([onLoaded]));
  void window.neox
    .uiStateGet(timelineScrollStateStorageKey(key))
    .then((result) => {
      if (result?.success) {
        const state = parseTimelineScrollState(result.value);
        if (state) {
          cacheTimelineScrollState(key, state);
          writeTimelineScrollStateToLocalStorage(key, state);
        }
      }
    })
    .catch(() => {
      /* Treat failed UI state reads as a cache miss. */
    })
    .finally(() => {
      timelineScrollStateLoadStatus.set(key, "loaded");
      const callbacks = timelineScrollStateLoadCallbacks.get(key);
      timelineScrollStateLoadCallbacks.delete(key);
      callbacks?.forEach((callback) => callback());
    });
  return "loading";
}

export function rowKeySignature(rowKeys: string[]): string {
  const length = rowKeys.length;
  if (length === 0) return "0";
  const middle = rowKeys[Math.floor(length / 2)] ?? "";
  return `${length}:${rowKeys[0] ?? ""}:${middle}:${rowKeys[length - 1] ?? ""}`;
}

export function persistedAnchorMissing(
  state: PersistedTimelineScrollState | undefined,
  rowKeys: string[]
): boolean {
  if (!state || state.atBottom || !state.anchorKey) return false;
  return rowKeys.indexOf(state.anchorKey) < 0;
}

export function shouldRestoreLiveSessionToBottom(args: {
  sessionStreaming: boolean;
  saved?: Pick<
    PersistedTimelineScrollState,
    "atBottom" | "userScrolledAway" | "anchorKey"
  > | null;
  lastRowKey?: string;
}): boolean {
  if (!args.sessionStreaming) return false;
  const saved = args.saved;
  if (!saved) return true;
  if (saved.atBottom || !saved.userScrolledAway) return true;
  if (args.lastRowKey && saved.anchorKey === args.lastRowKey) return true;
  return false;
}

const TIMELINE_ROW_SIZE_CACHE_LIMIT = 8;
const timelineRowSizeCacheBySession = new Map<string, Map<string, number>>();

export function timelineRowSizeCacheForSession(key: string): Map<string, number> {
  const existing = timelineRowSizeCacheBySession.get(key);
  if (existing) {
    timelineRowSizeCacheBySession.delete(key);
    timelineRowSizeCacheBySession.set(key, existing);
    return existing;
  }
  const created = new Map<string, number>();
  timelineRowSizeCacheBySession.set(key, created);
  while (timelineRowSizeCacheBySession.size > TIMELINE_ROW_SIZE_CACHE_LIMIT) {
    const oldest = timelineRowSizeCacheBySession.keys().next().value;
    if (!oldest || oldest === key) break;
    timelineRowSizeCacheBySession.delete(oldest);
  }
  return created;
}
