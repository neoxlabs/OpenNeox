/* ============================================================
 * Diagnostics Recorder — long-running UX/perf evidence capture
 * ------------------------------------------------------------
 * 目标：长期测试 Agent / IDE / Timeline / Surface 时，不再靠用户口述。
 * 记录 ShellPerf、TimelineJank、全局错误、用户手动 mark 到 JSONL。
 * 默认不启用；通过 console 或未来设置页显式开启。
 * ============================================================ */

import { shellPerf } from './shellPerf';

type DiagnosticRecord = {
  ts: number;
  iso: string;
  sessionId: string;
  source: string;
  type: string;
  payload?: unknown;
};

type RecorderState = {
  installed: boolean;
  running: boolean;
  sessionId: string | null;
  filePath: string | null;
  startedAt: number;
  buffer: string[];
  flushTimer: number | null;
  flushInFlight: Promise<void> | null;
  listeners: Array<() => void>;
};

type RecorderWindow = Window & {
  __NEOX_DIAGNOSTICS_RECORDER_STATE__?: RecorderState;
  __neoxDiag?: typeof diagnosticsRecorder;
  __neoxDiagStart?: (label?: string, detail?: Record<string, unknown>) => string | null;
  __neoxDiagStop?: (reason?: string) => Promise<{ sessionId: string | null; path: string | null }>;
  __neoxDiagMark?: (type?: string, payload?: unknown) => void;
  __neoxDiagStatus?: () => Record<string, unknown>;
  __neoxDiagOpenFolder?: () => Promise<string | null>;
  __NEOX_SHELL_PERF__?: boolean;
};

const getWindow = (): RecorderWindow | null => (typeof window === 'undefined' ? null : window as RecorderWindow);
const now = () => Date.now();

const getState = (): RecorderState | null => {
  const w = getWindow();
  if (!w) return null;
  if (!w.__NEOX_DIAGNOSTICS_RECORDER_STATE__) {
    w.__NEOX_DIAGNOSTICS_RECORDER_STATE__ = {
      installed: false,
      running: false,
      sessionId: null,
      filePath: null,
      startedAt: 0,
      buffer: [],
      flushTimer: null,
      flushInFlight: null,
      listeners: [],
    };
  }
  return w.__NEOX_DIAGNOSTICS_RECORDER_STATE__;
};

const makeSessionId = (label = 'manual') => {
  const cleaned = label.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/-+/g, '-').slice(0, 36) || 'manual';
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${cleaned}-${Math.random().toString(16).slice(2, 8)}`;
};

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, (_key, val) => {
      if (val instanceof Error) return { name: val.name, message: val.message, stack: val.stack };
      if (typeof val === 'function') return `[Function ${val.name || 'anonymous'}]`;
      if (typeof val === 'bigint') return String(val);
      return val;
    });
  } catch (error) {
    return JSON.stringify({ type: 'json-serialize-error', message: error instanceof Error ? error.message : String(error) });
  }
};

const collectSnapshot = () => {
  const doc = typeof document === 'undefined' ? null : document;
  const feed = doc?.querySelector('.atl-feed') as HTMLElement | null;
  const shell = doc?.querySelector('.neox-shell') as HTMLElement | null;
  return {
    href: typeof location !== 'undefined' ? location.href : undefined,
    visibility: doc?.visibilityState,
    activeTag: (doc?.activeElement as HTMLElement | null)?.tagName,
    shellMode: shell?.getAttribute('data-mode'),
    timelineRowsDom: doc?.querySelectorAll('.atl-row-clamp').length,
    planCardsDom: doc?.querySelectorAll('.plan-card, .atl-plan-card').length,
    markdownDom: doc?.querySelectorAll('.markdown-body, .atl-markdown').length,
    feedScrollTop: feed ? Math.round(feed.scrollTop) : undefined,
    feedScrollHeight: feed ? Math.round(feed.scrollHeight) : undefined,
    feedClientHeight: feed ? Math.round(feed.clientHeight) : undefined,
  };
};

const appendRecord = (source: string, type: string, payload?: unknown) => {
  const state = getState();
  if (!state) return;
  if (!state.running || !state.sessionId) return;
  const ts = now();
  const record: DiagnosticRecord = {
    ts,
    iso: new Date(ts).toISOString(),
    sessionId: state.sessionId,
    source,
    type,
    payload,
  };
  const line = safeJson(record);
  state.buffer.push(line);
  if (state.buffer.length >= 40) void diagnosticsRecorder.flush();
  else scheduleFlush();
};

const scheduleFlush = () => {
  const state = getState();
  const w = getWindow();
  if (!state || !w || state.flushTimer !== null) return;
  state.flushTimer = w.setTimeout(() => {
    state.flushTimer = null;
    void diagnosticsRecorder.flush();
  }, 1200);
};

export const diagnosticsRecorder = {
  install() {
    const w = getWindow();
    const state = getState();
    if (!w || !state) return;

    w.__neoxDiag = diagnosticsRecorder;
    w.__neoxDiagStart = (label, detail) => diagnosticsRecorder.start(label, detail);
    w.__neoxDiagStop = (reason) => diagnosticsRecorder.stop(reason);
    w.__neoxDiagMark = (type = 'manual', payload) => diagnosticsRecorder.mark(type, payload);
    w.__neoxDiagStatus = () => diagnosticsRecorder.status();
    w.__neoxDiagOpenFolder = () => diagnosticsRecorder.openFolder();

    if (state.installed) return;
    state.installed = true;

    const onDiagnosticEvent = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      appendRecord(detail.source || 'renderer', detail.type || 'event', detail.payload ?? detail.event ?? detail);
    };
    w.addEventListener('neox:diagnostic-event', onDiagnosticEvent as EventListener);
    state.listeners.push(() => w.removeEventListener('neox:diagnostic-event', onDiagnosticEvent as EventListener));

    const onError = (event: ErrorEvent) => appendRecord('window', 'error', {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: event.error,
      snapshot: collectSnapshot(),
    });
    w.addEventListener('error', onError);
    state.listeners.push(() => w.removeEventListener('error', onError));

    const onRejection = (event: PromiseRejectionEvent) => appendRecord('window', 'unhandledrejection', {
      reason: event.reason,
      snapshot: collectSnapshot(),
    });
    w.addEventListener('unhandledrejection', onRejection);
    state.listeners.push(() => w.removeEventListener('unhandledrejection', onRejection));

    try { w.localStorage.removeItem('neox-diagnostics-auto'); } catch { /* ignore */ }
  },

  uninstall() {
    const state = getState();
    if (!state) return;
    state.listeners.splice(0).forEach((off) => off());
    state.installed = false;
  },

  start(label = 'manual', detail: Record<string, unknown> = {}) {
    const state = getState();
    const w = getWindow();
    if (!state || !w) return null;
    if (state.running) void diagnosticsRecorder.stop('restart');
    const sessionId = makeSessionId(label);
    state.running = true;
    state.sessionId = sessionId;
    state.filePath = null;
    state.startedAt = now();
    state.buffer = [];

    w.__NEOX_SHELL_PERF__ = true;
    shellPerf.install();
    shellPerf.startSampler(`diagnostics:${label}`, { sessionId, ...detail });
    (w as any).__neoxTimelineDebug = true;

    appendRecord('diagnostics', 'start', { label, detail, snapshot: collectSnapshot() });
    void diagnosticsRecorder.flush();
    return sessionId;
  },

  async stop(reason = 'manual-stop') {
    const state = getState();
    const w = getWindow();
    if (!state) return { sessionId: null, path: null };
    const sessionId = state.sessionId;
    appendRecord('diagnostics', 'stop', { reason, durationMs: state.startedAt ? now() - state.startedAt : 0, snapshot: collectSnapshot() });
    try { shellPerf.stopSampler(`diagnostics-${reason}`); } catch { /* ignore */ }
    await diagnosticsRecorder.flush();
    state.running = false;
    state.sessionId = null;
    state.startedAt = 0;
    if (w) w.localStorage.removeItem('neox-diagnostics-auto');
    return { sessionId, path: state.filePath };
  },

  mark(type = 'manual', payload?: unknown) {
    appendRecord('manual', type, { payload, snapshot: collectSnapshot() });
  },

  async flush() {
    const state = getState();
    const api = getWindow()?.neox;
    if (!state || !state.sessionId || !state.buffer.length || !api?.diagnosticsAppend) return;
    const lines = state.buffer.splice(0, state.buffer.length);
    const run = async () => {
      const result = await api.diagnosticsAppend?.({ sessionId: state.sessionId!, lines });
      if (result?.path) state.filePath = result.path;
      if (!result?.ok) throw new Error(result?.error || 'diagnostics append failed');
    };
    state.flushInFlight = (state.flushInFlight || Promise.resolve()).catch(() => undefined).then(run);
    try {
      await state.flushInFlight;
    } catch (error) {
      // 回写失败不能影响 UI；保留最近一批，避免瞬时 IPC 失败丢证据。
      state.buffer.unshift(...lines.slice(-80));
      // eslint-disable-next-line no-console
      console.warn('[DiagnosticsRecorder] flush failed', error);
    }
  },

  status() {
    const state = getState();
    return {
      installed: state?.installed ?? false,
      running: state?.running ?? false,
      sessionId: state?.sessionId ?? null,
      filePath: state?.filePath ?? null,
      buffered: state?.buffer.length ?? 0,
      durationMs: state?.running && state.startedAt ? now() - state.startedAt : 0,
      snapshot: collectSnapshot(),
    };
  },

  async openFolder() {
    return await getWindow()?.neox?.diagnosticsOpenFolder?.() ?? null;
  },
};

export default diagnosticsRecorder;
