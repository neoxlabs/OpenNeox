
import * as React from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

let xtermModsPromise: Promise<{
  Terminal: typeof import('@xterm/xterm').Terminal;
  FitAddon: typeof import('@xterm/addon-fit').FitAddon;
  WebLinksAddon: typeof import('@xterm/addon-web-links').WebLinksAddon;
}> | null = null;
function loadXterm() {
  if (!xtermModsPromise) {
    xtermModsPromise = Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-web-links'),
      import('@xterm/xterm/css/xterm.css'),
    ]).then(([x, f, w]) => ({ Terminal: x.Terminal, FitAddon: f.FitAddon, WebLinksAddon: w.WebLinksAddon }));
  }
  return xtermModsPromise;
}
import { RUN_MANAGER_TOPIC } from '../../../../../ide/index.js';
import { useTopicSubscription } from '../../../platform/useTopicSubscription.js';

// ── xterm 实例和元数据 ─────────────────────────────────────
interface ProcessOutputEntry {
  processId: string;
  configurationId: string;
  configurationName: string;
  executorId: string;
  command: string;
  ended: boolean;
  exitCode: number | null;
  signal: string | null;
  error?: string;
  /** xterm 实例 — 懒创建: 面板首次 mount (useActiveTerminal) 时才 new, 之前为 null */
  term: Terminal | null;
  /** fit addon, 与 term 一起懒创建, panel mount 后调用 fit */
  fit: FitAddon | null;
  /** 持有 xterm DOM 的容器 div, 不在 DOM 树里时也存活 */
  container: HTMLDivElement;
  /** 是否已经 term.open 过 (xterm.open 只能调一次) */
  _opened: { v: boolean };
  /** open 之前 buffer 的 stdout/stderr 数据, open 之后一次性 flush */
  _pendingWrites: string[];
}

// ── Context ────────────────────────────────────────────────

// 给外部 (RunOutputPanel) 拿 entry 用 —— 类型 narrow 暴露
export type RunOutputEntry = ProcessOutputEntry;

export interface ProcessTabInfo {
  processId: string;
  configurationId: string;
  configurationName: string;
  executorId: string;
  ended: boolean;
  exitCode: number | null;
}

export interface RunOutputContextValue {
  /** 当前所有 (still-tracked) 进程 tab, 排序好 */
  tabs: readonly ProcessTabInfo[];
  /** 当前激活的 process id */
  activeProcessId: string | null;
  setActiveProcessId(id: string | null): void;
  /** 关掉一个 tab —— dispose xterm 实例 */
  closeTab(id: string): void;
  /** 清空当前 tab 的 xterm buffer */
  clearActive(): void;
  /** 拿到某个 process 的 detached xterm 容器 (for panel 来 mount) */
  getContainer(id: string): HTMLDivElement | null;
  /** 拿到 fit addon, panel mount/resize 后调 */
  getFitAddon(id: string): FitAddon | null;
  /** 内部 helper: 拿完整 entry 引用, 给 useActiveTerminal hook + 工具栏按钮 (scroll/copy) 用 */
  getEntry(id: string): RunOutputEntry | null;
  /** Panel 是否可见. localStorage 持久化. */
  visible: boolean;
  setVisible(v: boolean): void;
  /** Panel 高度 (像素). localStorage 持久化, 范围 120-1200. */
  height: number;
  setHeight(h: number): void;
}

const RunOutputContext = React.createContext<RunOutputContextValue | null>(null);

export function useRunOutput(): RunOutputContextValue {
  const v = React.useContext(RunOutputContext);
  if (!v) throw new Error('useRunOutput must be inside <RunOutputProvider>');
  return v;
}

// ── xterm 主题 (JetBrains New UI tool window 灰色背景) ─────
// 注: 比 TerminalPanel.tsx 更浅一档 —— 终端是独立 tool window 用 #1e1f22 深底,
// run output 跟 IDEA 的 Run tool window 视觉一致, 用中灰 #2b2d30.
const XTERM_THEME = {
  background: '#2b2d30',
  foreground: '#bcbec4',
  cursor: '#c9a227',
  cursorAccent: '#2b2d30',
  selectionBackground: 'rgba(47, 101, 202, 0.4)',
  black: '#2b2d30',
  red: '#f44747',
  green: '#4ec9b0',
  yellow: '#dcdcaa',
  blue: '#569cd6',
  magenta: '#c586c0',
  cyan: '#4dc9b0',
  white: '#d4d4d4',
  brightBlack: '#808080',
  brightRed: '#f44747',
  brightGreen: '#4ec9b0',
  brightYellow: '#dcdcaa',
  brightBlue: '#569cd6',
  brightMagenta: '#c586c0',
  brightCyan: '#4dc9b0',
  brightWhite: '#ffffff',
};

/* 只建容器 div — 同步、无 xterm 依赖。term/fit 在 useActiveTerminal 首次 mount 时懒创建. */
function createEntryShell(): Pick<ProcessOutputEntry, 'term' | 'fit' | 'container'> & { _opened: { v: boolean } } {
  // 容器只创建, 不立即 term.open. 等真正进入 DOM 时再 open —— 否则
  // xterm 在 detached 状态下 open() 后, 后续 attach 不会自动渲染.
  const container = document.createElement('div');
  container.className = 'rop-xterm-host';
  container.style.width = '100%';
  container.style.height = '100%';

  return { term: null, fit: null, container, _opened: { v: false } };
}

/* 懒创建 term + addons + stdin/resize 桥 — useActiveTerminal 首次 mount 调用. */
async function materializeTerminal(entry: ProcessOutputEntry): Promise<void> {
  if (entry.term) return;
  const { Terminal, FitAddon, WebLinksAddon } = await loadXterm();
  if (entry.term) return; /* await 期间别处已建好 */
  const term = new Terminal({
    // PTY 后端 → 可交互, 启用 stdin + 光标闪烁
    cursorBlink: true,
    disableStdin: false,
    convertEol: false, // 由 PTY 负责换行, xterm 别二次转换
    scrollback: 5000,
    fontSize: 13,
    fontFamily: '"SF Mono", "Fira Code", "Consolas", monospace',
    theme: XTERM_THEME,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  const webLinks = new WebLinksAddon();
  term.loadAddon(fit);
  term.loadAddon(webLinks);

  // 用户在 xterm 里敲的字符 → forward 到 pty stdin
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const neox = (window as any).neox;
  term.onData((data) => {
    neox?.runLaunchStdin?.(entry.processId, data);
  });
  // xterm fit 后尺寸变化 → resize pty, 避免 TUI 应用按错误宽度渲染
  term.onResize(({ cols, rows }) => {
    neox?.runLaunchResize?.(entry.processId, cols, rows);
  });

  entry.term = term;
  entry.fit = fit;
}

// ── Provider ───────────────────────────────────────────────

export interface RunOutputProviderProps {
  children: React.ReactNode;
}

// localStorage 持久化 keys (跟 gitLog 命名风格一致)
const LS_VISIBLE = 'neox-run-output-visible';
const LS_HEIGHT = 'neox-run-output-height';

export const RunOutputProvider: React.FC<RunOutputProviderProps> = ({ children }) => {
  // 用 useState 持有 tabs 元数据让 React 知道更新; xterm 实例放 useRef 里避免
  // 触发重渲染.
  const [tabs, setTabs] = React.useState<ProcessTabInfo[]>([]);
  const [activeProcessId, setActiveProcessId] = React.useState<string | null>(null);
  const [visible, setVisibleState] = React.useState<boolean>(() => {
    try {
      return window.localStorage.getItem(LS_VISIBLE) === 'true';
    } catch {
      return false;
    }
  });
  const [height, setHeightState] = React.useState<number>(() => {
    try {
      const saved = window.localStorage.getItem(LS_HEIGHT);
      const n = saved ? parseInt(saved, 10) : NaN;
      if (!isNaN(n) && n >= 120 && n <= 1200) return n;
    } catch {
      /* ignore */
    }
    return 320;
  });
  const entriesRef = React.useRef<Map<string, ProcessOutputEntry>>(new Map());

  const setVisible = React.useCallback((v: boolean) => {
    setVisibleState(v);
    try {
      window.localStorage.setItem(LS_VISIBLE, String(v));
    } catch {
      /* ignore */
    }
  }, []);

  const setHeight = React.useCallback((h: number) => {
    const clamped = Math.max(120, Math.min(1200, h));
    setHeightState(clamped);
    try {
      window.localStorage.setItem(LS_HEIGHT, String(clamped));
    } catch {
      /* ignore */
    }
  }, []);

  const refreshTabs = React.useCallback(() => {
    const next: ProcessTabInfo[] = [];
    for (const e of entriesRef.current.values()) {
      next.push({
        processId: e.processId,
        configurationId: e.configurationId,
        configurationName: e.configurationName,
        executorId: e.executorId,
        ended: e.ended,
        exitCode: e.exitCode,
      });
    }
    next.sort((a, b) => a.configurationName.localeCompare(b.configurationName));
    setTabs(next);
  }, []);

  // ── 把数据写入 entry: 如果 xterm 还没 open (或还没懒创建), 先 buffer ──
  const writeToEntry = (entry: ProcessOutputEntry, data: string) => {
    if (entry._opened.v && entry.term) {
      entry.term.write(data);
    } else {
      entry._pendingWrites.push(data);
    }
  };

  // ── 订阅 ──
  useTopicSubscription(RUN_MANAGER_TOPIC, {
    onExecutionStarted(e) {
      const { term, fit, container, _opened } = createEntryShell();
      const entry: ProcessOutputEntry = {
        processId: e.processId,
        configurationId: e.configurationId,
        configurationName: e.configurationName,
        executorId: e.executorId,
        command: e.command,
        ended: false,
        exitCode: null,
        signal: null,
        term,
        fit,
        container,
        _opened,
        _pendingWrites: [],
      };
      entriesRef.current.set(e.processId, entry);
      // 第一行: 灰色斜体的命令行
      writeToEntry(entry, `\x1b[2;3m> ${e.command}\x1b[0m\r\n`);
      refreshTabs();
      setActiveProcessId(e.processId);
      // 自动 show + 持久化
      setVisible(true);
    },
    onExecutionOutput(e) {
      const entry = entriesRef.current.get(e.processId);
      if (!entry) return;
      // stderr 不做特殊染色 —— 程序自己输出的 ANSI 已经携带颜色;
      // 如果想强制 stderr 红色, 可以加 wrap, 但通常会破坏程序原本的着色
      writeToEntry(entry, e.data);
    },
    onExecutionEnded(e) {
      const entry = entriesRef.current.get(e.processId);
      if (!entry) return;
      entry.ended = true;
      entry.exitCode = e.exitCode;
      entry.signal = e.signal;
      entry.error = e.error;
      const exitColor = e.exitCode === 0 ? '\x1b[32m' : '\x1b[31m';
      const exitMsg = e.error
        ? `\r\n\x1b[31m× error: ${e.error}\x1b[0m\r\n`
        : `\r\n${exitColor}[Process exited with code ${e.exitCode}${e.signal ? ` (signal ${e.signal})` : ''}]\x1b[0m\r\n`;
      writeToEntry(entry, exitMsg);
      refreshTabs();
    },
  });

  // ── 给 panel 的辅助: 拿 entry 引用 (用于 useActiveTerminal 真正 open xterm) ──
  const getEntry = React.useCallback((id: string): ProcessOutputEntry | null => {
    return entriesRef.current.get(id) ?? null;
  }, []);

  // ── 操作: 关 tab ──
  const closeTab = React.useCallback(
    (id: string) => {
      const entry = entriesRef.current.get(id);
      if (!entry) return;
      try {
        entry.term?.dispose();
      } catch {
        /* ignore */
      }
      entriesRef.current.delete(id);
      // 切到下一个 tab
      setActiveProcessId((prev) => {
        if (prev !== id) return prev;
        const remaining = [...entriesRef.current.keys()];
        return remaining[0] ?? null;
      });
      // 故意不 setVisible(false): 用户可能只是关了一个 tab, 想保留面板
      // 空着 (显示 "还没有运行任何配置"). 隐藏面板由 × 按钮 / 活动栏按钮显式控制.
      refreshTabs();
    },
    [refreshTabs],
  );

  // ── 操作: 清当前 ──
  const clearActive = React.useCallback(() => {
    if (!activeProcessId) return;
    const entry = entriesRef.current.get(activeProcessId);
    if (!entry) return;
    entry.term?.clear();
  }, [activeProcessId]);

  // ── 卸载: dispose 所有 xterm ──
  React.useEffect(() => {
    return () => {
      for (const entry of entriesRef.current.values()) {
        try {
          entry.term?.dispose();
        } catch {
          /* ignore */
        }
      }
      entriesRef.current.clear();
    };
  }, []);

  const value: RunOutputContextValue = React.useMemo(
    () => ({
      tabs,
      activeProcessId,
      setActiveProcessId,
      closeTab,
      clearActive,
      getContainer: (id: string) => entriesRef.current.get(id)?.container ?? null,
      getFitAddon: (id: string) => entriesRef.current.get(id)?.fit ?? null,
      getEntry,
      visible,
      setVisible,
      height,
      setHeight,
    }),
    [tabs, activeProcessId, closeTab, clearActive, getEntry, visible, setVisible, height, setHeight],
  );

  return <RunOutputContext.Provider value={value}>{children}</RunOutputContext.Provider>;
};

/**
 * useActiveTerminal —— RunOutputPanel 用这个 hook 把当前 active 进程的 xterm
 * 容器挂到自己的 hostRef.
 *
 * 关键: 如果该 entry 第一次 mount, 这里会 lazy 调用 term.open(host) 一次性
 * 初始化, 然后 flush pending writes. 这样避免了 term.open 在 detached 容器
 * 上调用导致 xterm 内部状态错乱的问题.
 *
 * 后续 panel 切换 tab 只是把 container 元素重新 appendChild 到新 host (xterm
 * 的 element 已经在 container 内, 跟 container 一起搬走), 不再 re-open.
 */
export function useActiveTerminal(
  hostRef: React.RefObject<HTMLDivElement | null>,
  activeProcessId: string | null,
): void {
  const ctx = React.useContext(RunOutputContext);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host || !ctx) return;
    if (!activeProcessId) {
      host.replaceChildren();
      return;
    }
    const entry = ctx.getEntry(activeProcessId);
    if (!entry) {
      host.replaceChildren();
      return;
    }

    // 1. 把容器挂到 host
    host.replaceChildren(entry.container);

    let cancelled = false;
    let rafId: number | null = null;
    const fitAndRefresh = () => {
      rafId = requestAnimationFrame(() => {
        try {
          entry.fit?.fit();
          if (entry.term) entry.term.refresh(0, entry.term.rows - 1);
        } catch {
          /* ignore */
        }
      });
    };

    // 2. 第一次 mount → 懒创建 term (loadXterm 动态 import) + term.open(container) + flush pending
    //    必须在 container 进 DOM 之后调用 open, 否则 xterm 渲染层初始化错乱.
    //    await 期间的 stdout/stderr 照旧进 _pendingWrites, open 后一次性 flush — 不丢字节.
    if (!entry._opened.v) {
      void (async () => {
        try {
          await materializeTerminal(entry);
          if (cancelled) return; /* 切走了 — 下次 mount 再 open (term 已建好, 秒开) */
          if (ctx.getEntry(entry.processId) !== entry) {
            /* await 期间 tab 被关掉, entry 已出表 — 别泄漏刚建的实例 */
            try { entry.term?.dispose(); } catch { /* ignore */ }
            entry.term = null;
            entry.fit = null;
            return;
          }
          if (!entry._opened.v && entry.term) {
            entry.term.open(entry.container);
            entry._opened.v = true;
            // 强制给 xterm root + 常见内部层打 inline background, 兜底 CSS 不够强的情况.
            // xterm v6 的 DOM renderer 有时会用 style=""直接内联 background, 走 inline
            // 比 CSS !important 更保险.
            const bg = '#2b2d30';
            const applyBg = (el: HTMLElement | null) => {
              if (!el) return;
              el.style.backgroundColor = bg;
            };
            applyBg(entry.term.element ?? null);
            entry.container.querySelectorAll<HTMLElement>('.xterm, .xterm-viewport, .xterm-screen, .xterm-rows').forEach(applyBg);
            for (const data of entry._pendingWrites) {
              entry.term.write(data);
            }
            entry._pendingWrites = [];
            fitAndRefresh();
          }
        } catch (err) {
          console.error('[RunOutput] term.open failed:', err);
        }
      })();
    } else {
      // 3. 已 open 过的 tab 切回来: 等一帧 layout 后 fit + refresh
      fitAndRefresh();
    }

    // 4. 监听窗口大小变化, 自动 re-fit
    const onResize = () => {
      try {
        entry.fit?.fit();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelled = true;
      if (rafId != null) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
    };
  }, [hostRef, activeProcessId, ctx]);
}
