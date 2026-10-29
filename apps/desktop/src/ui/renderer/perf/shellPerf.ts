/* ============================================================
 * ShellPerf — UI main-thread evidence logger
 * ------------------------------------------------------------
 * 目标：不要再凭体感猜 Agent/IDE 切换、右栏展开、Monaco layout 谁在卡。
 *
 * 重要原则：这个文件在 Vite dev/HMR 下必须是 window 级单例。
 * 如果每次热更新都新建 PerformanceObserver + rAF loop，监控本身就会制造
 * raf-gap/console 风暴，日志会被污染成 2x/3x/4x。这里所有可运行状态都挂到
 * window.__NEOX_SHELL_PERF_STATE__，并在 import.meta.hot.dispose 时清理。
 * ============================================================ */

export type ShellPerfDetail = Record<string, unknown>;

type ActiveInteraction = {
  id: number;
  name: string;
  startedAt: number;
  lastMarkAt: number;
};

type PerfSampler = {
  id: number;
  name: string;
  startedAt: number;
  lastSampleAt: number;
  lastFrameAt: number;
  frameGaps: number[];
  sampleFrameGaps: number[];
  longTasks: Array<{ duration: number; startTime: number; name?: string }>;
  reactMarks: Array<ShellPerfDetail & { at: number; label?: string }>;
  detail: ShellPerfDetail;
};

type ShellPerfState = {
  seq: number;
  active: ActiveInteraction | null;
  sampler: PerfSampler | null;
  installed: boolean;
  longTaskObserver: PerformanceObserver | null;
  rafId: number | null;
  lastRafAt: number;
  installVersion: number;
};

const STATE_KEY = '__NEOX_SHELL_PERF_STATE__';

const getWindow = () => (typeof window === 'undefined' ? null : window as any);

const getState = (): ShellPerfState | null => {
  const w = getWindow();
  if (!w) return null;
  if (!w[STATE_KEY]) {
    w[STATE_KEY] = {
      seq: 0,
      active: null,
      sampler: null,
      installed: false,
      longTaskObserver: null,
      rafId: null,
      lastRafAt: 0,
      installVersion: 0,
    } satisfies ShellPerfState;
  } else if (!('sampler' in w[STATE_KEY])) {
    w[STATE_KEY].sampler = null;
  }
  return w[STATE_KEY] as ShellPerfState;
};

/* 默认关 — 即使 dev 也得显式 opt-in。
 * 开启方式：
 *   window.__neoxShellPerfEnable()
 * 关闭方式：
 *   window.__neoxShellPerfDisable()
 */
const enabled = (): boolean => {
  const w = getWindow();
  return !!w && w.__NEOX_SHELL_PERF__ === true;
};

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const round = (n: number) => Math.round(n * 10) / 10;

const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
};

const frameStats = (gaps: number[]) => {
  const elapsed = gaps.reduce((sum, gap) => sum + gap, 0);
  const frames = gaps.length;
  const fps = elapsed > 0 ? (frames * 1000) / elapsed : 0;
  return {
    frames,
    fps: round(fps),
    avgFrameMs: frames ? round(elapsed / frames) : 0,
    p50FrameMs: round(percentile(gaps, 50)),
    p95FrameMs: round(percentile(gaps, 95)),
    p99FrameMs: round(percentile(gaps, 99)),
    maxFrameMs: gaps.length ? round(Math.max(...gaps)) : 0,
    over20: gaps.filter((gap) => gap > 20).length,
    over34: gaps.filter((gap) => gap > 34).length,
    over50: gaps.filter((gap) => gap > 50).length,
    over100: gaps.filter((gap) => gap > 100).length,
  };
};

const collectDomSnapshot = (): ShellPerfDetail => {
  const w = getWindow();
  const doc = w?.document;
  if (!doc) return {};
  const feed = doc.querySelector('.atl-feed') as HTMLElement | null;
  const shell = doc.querySelector('.neox-shell') as HTMLElement | null;
  const active = doc.activeElement as HTMLElement | null;
  return {
    timelineRoots: doc.querySelectorAll('.agent-timeline').length,
    timelineFeeds: doc.querySelectorAll('.atl-feed').length,
    timelineRowsDom: doc.querySelectorAll('.atl-row-clamp').length,
    timelineVirtualRowsDom: doc.querySelectorAll('.atl-feed .atl-row-clamp[data-timeline-row-index]').length,
    planCardsDom: doc.querySelectorAll('.plan-card, .atl-plan-card').length,
    markdownDom: doc.querySelectorAll('.markdown-body, .atl-markdown').length,
    feedScrollTop: feed ? round(feed.scrollTop) : undefined,
    feedScrollHeight: feed ? round(feed.scrollHeight) : undefined,
    feedClientHeight: feed ? round(feed.clientHeight) : undefined,
    shellMode: shell?.getAttribute('data-mode') ?? undefined,
    shellClass: shell?.className ?? undefined,
    activeTag: active?.tagName,
    activeClass: active?.className,
  };
};

const shouldPrintToConsole = (type: string, detail: ShellPerfDetail = {}) => {
  const w = getWindow();
  if (!w) return false;
  if (w.__NEOX_SHELL_PERF_CONSOLE__ === true) return true;
  if (type === 'fps-summary' || type === 'long-task' || type === 'end') return true;
  if (type === 'raf-gap') return (detail.frameGapMs as number | undefined) !== undefined && Number(detail.frameGapMs) >= 50;
  return false;
};

const log = (type: string, detail: ShellPerfDetail = {}) => {
  if (!enabled()) return;
  const state = getState();
  if (!state) return;
  const t = now();
  const active = state.active;
  const payload = {
    type,
    at: round(t),
    interaction: active ? {
      id: active.id,
      name: active.name,
      sinceStart: round(t - active.startedAt),
      sinceLast: round(t - active.lastMarkAt),
    } : null,
    ...detail,
  };
  const w = getWindow();
  if (w) {
    const events = (w.__NEOX_SHELL_PERF_EVENTS__ ||= []) as unknown[];
    events.push(payload);
    if (events.length > 800) events.splice(0, events.length - 800);
    w.__NEOX_SHELL_PERF_LAST__ = payload;
    try {
      w.dispatchEvent(new CustomEvent('neox:diagnostic-event', {
        detail: { source: 'shellPerf', type, payload },
      }));
    } catch { /* diagnostics recorder optional */ }
  }
  if (shouldPrintToConsole(type, detail)) {
    // eslint-disable-next-line no-console
    console.log('[ShellPerf]', payload);
  }
};

const emitSamplerSample = (sampler: PerfSampler, label = 'fps-sample') => {
  const sampleGaps = sampler.sampleFrameGaps;
  if (!sampleGaps.length) return;
  const longTasks = sampler.longTasks;
  const sinceStart = now() - sampler.startedAt;
  log(label, {
    samplerId: sampler.id,
    name: sampler.name,
    sinceStartMs: round(sinceStart),
    ...frameStats(sampleGaps),
    totalFrames: sampler.frameGaps.length,
    longTaskCount: longTasks.length,
    longTaskTotalMs: round(longTasks.reduce((sum, task) => sum + task.duration, 0)),
    longTaskMaxMs: longTasks.length ? round(Math.max(...longTasks.map((task) => task.duration))) : 0,
    reactMarkCount: sampler.reactMarks.length,
    ...collectDomSnapshot(),
  });
  sampler.sampleFrameGaps = [];
  sampler.lastSampleAt = now();
};

const stopInstalledWatchers = () => {
  const state = getState();
  if (!state) return;
  try { state.longTaskObserver?.disconnect(); } catch { /* ignore */ }
  state.longTaskObserver = null;
  if (state.rafId !== null && typeof window !== 'undefined') {
    try { window.cancelAnimationFrame(state.rafId); } catch { /* ignore */ }
  }
  state.rafId = null;
  state.installed = false;
  state.active = null;
  state.sampler = null;
};

export const shellPerf = {
  install() {
    const w = getWindow();
    const state = getState();
    if (!w || !state) return;

    w.__neoxShellPerf = shellPerf;
    w.__neoxShellPerfEnable = () => {
      w.__NEOX_SHELL_PERF__ = true;
      shellPerf.install();
    };
    w.__neoxShellPerfDisable = () => {
      w.__NEOX_SHELL_PERF__ = false;
      shellPerf.uninstall();
    };
    w.__neoxPerfStart = (name = 'manual', detail: ShellPerfDetail = {}) => shellPerf.startSampler(name, detail);
    w.__neoxPerfStop = (label = 'manual-stop', detail: ShellPerfDetail = {}) => shellPerf.stopSampler(label, detail);
    w.__neoxPerfSnapshot = () => shellPerf.snapshot();

    /* 不显式 opt-in 就完全不挂 observer/rAF。 */
    if (!enabled()) return;

    /* HMR/重复调用安全：
     *   · HMR dispose 会调用 uninstall，下一版 install 再重建 watcher；
     *   · 普通 startSampler / enable 重复调用不应该 stop/start watcher，否则监控本身会制造
     *     RAF 缺口和 `installed` 日志风暴。 */
    if (state.installed && state.rafId !== null) return;
    if (state.rafId !== null || state.longTaskObserver) stopInstalledWatchers();

    state.installed = true;
    state.installVersion += 1;
    const version = state.installVersion;

    if ('PerformanceObserver' in window) {
      try {
        state.longTaskObserver = new PerformanceObserver((list) => {
          /* 如果 HMR 后旧 observer 回调晚到，直接丢弃。 */
          if (getState()?.installVersion !== version) return;
          for (const entry of list.getEntries()) {
            const task = {
              duration: round(entry.duration),
              startTime: round(entry.startTime),
              name: entry.name,
            };
            const sampler = getState()?.sampler;
            if (sampler) sampler.longTasks.push(task);
            log('long-task', task);
          }
        });
        state.longTaskObserver.observe({ entryTypes: ['longtask'] as any });
      } catch { /* longtask may not be supported */ }
    }

    state.lastRafAt = now();
    const tick = () => {
      const current = getState();
      if (!current || !enabled() || !current.installed || current.installVersion !== version) return;
      const t = now();
      const gap = t - current.lastRafAt;
      if (current.sampler) {
        current.sampler.frameGaps.push(gap);
        current.sampler.sampleFrameGaps.push(gap);
        if (t - current.sampler.lastSampleAt >= 1000) emitSamplerSample(current.sampler);
      }
      if (gap > 34) log('raf-gap', { frameGapMs: round(gap) });
      current.lastRafAt = t;
      current.rafId = window.requestAnimationFrame(tick);
    };
    state.rafId = window.requestAnimationFrame(tick);

    log('installed', { version });
  },

  uninstall() {
    stopInstalledWatchers();
  },

  begin(name: string, detail: ShellPerfDetail = {}) {
    if (!enabled()) return 0;
    const state = getState();
    if (!state) return 0;
    const t = now();
    const id = ++state.seq;
    state.active = { id, name, startedAt: t, lastMarkAt: t };
    log('begin', { id, name, ...detail });
    return id;
  },

  mark(label: string, detail: ShellPerfDetail = {}) {
    if (!enabled()) return;
    const state = getState();
    if (!state) return;
    const t = now();
    const sinceLast = state.active ? t - state.active.lastMarkAt : 0;
    const sampler = state.sampler;
    if (sampler && (label === 'react-profiler' || label.includes('timeline') || label.includes('resize') || label.includes('layout'))) {
      sampler.reactMarks.push({ at: round(t), label, ...detail });
      if (sampler.reactMarks.length > 80) sampler.reactMarks.splice(0, sampler.reactMarks.length - 80);
    }
    log('mark', { label, sinceLast: round(sinceLast), ...detail });
    if (state.active) state.active.lastMarkAt = t;
  },

  end(label = 'end', detail: ShellPerfDetail = {}) {
    if (!enabled()) return;
    const state = getState();
    if (!state) return;
    const t = now();
    const current = state.active;
    log('end', {
      label,
      totalMs: current ? round(t - current.startedAt) : undefined,
      ...detail,
    });
    state.active = null;
  },

  startSampler(name: string, detail: ShellPerfDetail = {}) {
    if (!enabled()) return 0;
    shellPerf.install();
    const state = getState();
    if (!state) return 0;
    if (state.sampler) shellPerf.stopSampler('auto-stop-before-new-sampler');
    const t = now();
    const id = ++state.seq;
    state.sampler = {
      id,
      name,
      startedAt: t,
      lastSampleAt: t,
      lastFrameAt: t,
      frameGaps: [],
      sampleFrameGaps: [],
      longTasks: [],
      reactMarks: [],
      detail,
    };
    log('fps-begin', { samplerId: id, name, ...detail, ...collectDomSnapshot() });
    return id;
  },

  stopSampler(label = 'fps-stop', detail: ShellPerfDetail = {}) {
    if (!enabled()) return;
    const state = getState();
    const sampler = state?.sampler;
    if (!state || !sampler) return;
    emitSamplerSample(sampler, 'fps-sample-final-window');
    const longTasks = sampler.longTasks;
    const reactMarks = sampler.reactMarks.slice(-20);
    log('fps-summary', {
      samplerId: sampler.id,
      name: sampler.name,
      label,
      totalMs: round(now() - sampler.startedAt),
      ...frameStats(sampler.frameGaps),
      longTaskCount: longTasks.length,
      longTaskTotalMs: round(longTasks.reduce((sum, task) => sum + task.duration, 0)),
      longTaskMaxMs: longTasks.length ? round(Math.max(...longTasks.map((task) => task.duration))) : 0,
      worstLongTasks: longTasks.slice().sort((a, b) => b.duration - a.duration).slice(0, 5),
      recentReactMarks: reactMarks,
      initialDetail: sampler.detail,
      ...detail,
      ...collectDomSnapshot(),
    });
    state.sampler = null;
  },

  snapshot(detail: ShellPerfDetail = {}) {
    const state = getState();
    const sampler = state?.sampler;
    const payload = {
      sampler: sampler ? {
        id: sampler.id,
        name: sampler.name,
        totalMs: round(now() - sampler.startedAt),
        ...frameStats(sampler.frameGaps),
        longTaskCount: sampler.longTasks.length,
        longTaskTotalMs: round(sampler.longTasks.reduce((sum, task) => sum + task.duration, 0)),
        reactMarkCount: sampler.reactMarks.length,
      } : null,
      ...detail,
      ...collectDomSnapshot(),
    };
    log('snapshot', payload);
    return payload;
  },

  measure<T>(label: string, fn: () => T, detail: ShellPerfDetail = {}): T {
    const t0 = now();
    try {
      return fn();
    } finally {
      const cost = now() - t0;
      if (cost > 4) log('measure', { label, costMs: round(cost), ...detail });
    }
  },

  async measureAsync<T>(label: string, fn: () => Promise<T>, detail: ShellPerfDetail = {}): Promise<T> {
    const t0 = now();
    try {
      return await fn();
    } finally {
      const cost = now() - t0;
      if (cost > 4) log('measure-async', { label, costMs: round(cost), ...detail });
    }
  },
};

if (typeof import.meta !== 'undefined' && (import.meta as any).hot) {
  (import.meta as any).hot.dispose(() => {
    shellPerf.uninstall();
  });
}

export default shellPerf;
