
import type { TimelineEntry } from "../../utils/workspaceUtils";

export interface TimelineTestHookApi {
  appendEntry: (sessionId: string, entry: TimelineEntry) => void;
  updateEntry: (
    sessionId: string,
    entryId: string,
    patch: Partial<TimelineEntry>
  ) => void;
  getActiveSessionId: () => string | null | undefined;
}

export interface TimelineStreamingHookApi {
  setStreaming: (value: boolean) => void;
  pickModel: (needle: string) => { id: string } | { error: string };
  getSelectedModelId: () => string | null;
}

/** 由 timelineStore 调用一次。非 dev 构建里整体被剥掉。 */
export function registerTimelineTestHooks(api: TimelineTestHookApi): void {
  if (!import.meta.env.DEV) return;
  if (typeof window === "undefined") return;
  const w = window as unknown as Record<string, unknown>;
  w.__neoxTestAppend = (entry: TimelineEntry, sessionId?: string) => {
    const sid = sessionId || api.getActiveSessionId();
    if (!sid) return "no active session";
    api.appendEntry(sid, entry);
    return sid;
  };
  w.__neoxTestUpdate = (
    entryId: string,
    patch: Partial<TimelineEntry>,
    sessionId?: string
  ) => {
    const sid = sessionId || api.getActiveSessionId();
    if (!sid) return "no active session";
    api.updateEntry(sid, entryId, patch);
    return sid;
  };
  w.__neoxTestActiveSession = () => api.getActiveSessionId() ?? null;
}

/** 由 NeoxRuntimeBridge 调用一次。非 dev 构建里整体被剥掉。 */
export function registerTimelineStreamingTestHooks(
  api: TimelineStreamingHookApi
): void {
  if (!import.meta.env.DEV) return;
  if (typeof window === "undefined") return;
  const w = window as unknown as Record<string, unknown>;
  w.__neoxTestSetStreaming = (value: boolean) => api.setStreaming(!!value);
  w.__neoxTestPickModel = (needle: string) => api.pickModel(needle);
  w.__neoxTestSelectedModel = () => api.getSelectedModelId();
}
