
const KEY = 'neox.perf.jank';
const LONG_FRAME_MS = 33;      /* 掉一帧以上 */
const RING = 300;

interface JankEntry {
  /** 页面启动后的毫秒数 */
  t: number;
  /** 这一帧比上一帧晚了多少 */
  gap: number;
  /** 卡顿发生时的交互上下文 —— 没有它, 一堆孤立的数字没法定位 */
  ctx: string;
}

interface JankState {
  entries: JankEntry[];
  frames: number;
  gaps: number[];
  started: number;
}

function currentContext(): string {
  const bits: string[] = [];
  try {
    /* 正在流式输出 = 主线程在被 React 反复重渲染, 最可能的卡顿来源 */
    if (document.querySelector('.atl-msg.is-streaming, .atl-msg.is-pending')) bits.push('streaming');
    const ae = document.activeElement;
    if (ae && /INPUT|TEXTAREA/.test(ae.tagName)) bits.push('typing');
    if (ae && ae.closest?.('.monaco-editor')) bits.push('monaco');
    if (document.querySelector('.settings-layout')) bits.push('settings');
    if (document.querySelector('.sfc-doc, .sfc-chrome__tab')) bits.push('surface');
    /* 屏上元素数量 —— 卡顿常常跟"这一屏有多重"直接相关 */
    bits.push('n=' + document.querySelectorAll('*').length);
  } catch { /* 记录器自己绝不能抛 */ }
  return bits.join(',') || 'idle';
}

export function installJankRecorder(): void {
  if (typeof window === 'undefined') return;
  let on = false;
  try { on = window.localStorage.getItem(KEY) === '1'; } catch { /* ignore */ }

  const state: JankState = { entries: [], frames: 0, gaps: [], started: performance.now() };
  (window as any).__neoxJank = {
    enabled: () => on,
    /** 打开/关闭并落盘 —— 改完刷新页面生效 */
    set: (v: boolean) => { try { window.localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* ignore */ } },
    dump: () => {
      const g = state.gaps.slice().sort((a, b) => a - b);
      const q = (x: number) => (g.length ? +g[Math.min(g.length - 1, Math.floor(g.length * x))].toFixed(1) : 0);
      /* 按上下文聚合 —— "掉帧都发生在 streaming 时"这种结论才有行动价值 */
      const byCtx: Record<string, number> = {};
      for (const e of state.entries) {
        const k = e.ctx.replace(/,n=\d+/, '');
        byCtx[k] = (byCtx[k] ?? 0) + 1;
      }
      return {
        enabled: on,
        wallSec: +((performance.now() - state.started) / 1000).toFixed(1),
        frames: state.frames,
        p50: q(0.5), p95: q(0.95), p99: q(0.99),
        longFrames: state.entries.length,
        worst: state.entries.length ? Math.max(...state.entries.map((e) => e.gap)) : 0,
        byContext: byCtx,
        recent: state.entries.slice(-30),
      };
    },
    reset: () => { state.entries.length = 0; state.gaps.length = 0; state.frames = 0; state.started = performance.now(); },
  };

  if (!on) return;

  let last = 0;
  const tick = (t: number) => {
    if (last) {
      const gap = t - last;
      state.frames++;
      state.gaps.push(gap);
      /* gaps 也要封顶, 否则长会话下这个数组本身就是内存泄漏 */
      if (state.gaps.length > 20000) state.gaps.splice(0, 10000);
      if (gap > LONG_FRAME_MS) {
        state.entries.push({ t: +(t - state.started).toFixed(0), gap: +gap.toFixed(1), ctx: currentContext() });
        if (state.entries.length > RING) state.entries.shift();
      }
    }
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
