import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNeoxRuntimeOptional } from '../../../app/NeoxRuntimeContext';
import { useI18n } from '../../../hooks/useI18n';
import { parkTerminal, takeParkedTerminal } from '../terminalKeepalivePool';
import { CopyIconButton, stripAnsi } from '../../../components/CopyIconButton';
import '@xterm/xterm/css/xterm.css';

/* 运行中实时计时组件 — 每秒更新 "3s" → "4s" → "1m 5s" */
const RunningTimer: React.FC<{ startTime?: number }> = ({ startTime }) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    if (!startTime) return;
    const id = setInterval(() => forceUpdate(n => n + 1), 1000);
    return () => clearInterval(id);
  }, [startTime]);
  if (!startTime) return null;
  const elapsed = Date.now() - startTime;
  const s = Math.floor(elapsed / 1000);
  const display = s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  return <span className="atl-term__chip atl-term__chip--elapsed">{display}</span>;
};

/**
 * isActiveSessionCloud — 同步读 cached cloud 状态.
 *   NeoxShellHost / NeoxRuntimeBridge 已经在监听 'neox:active-session-cloud-state' 事件,
 *   这里只是窗口级别 cache 一个 boolean 让纯函数路径 (e.g. xterm prompt builder) 同步取.
 */
let __activeCloud = false;
if (typeof window !== 'undefined') {
  window.addEventListener('neox:active-session-cloud-state', (e) => {
    __activeCloud = !!(e as CustomEvent).detail?.cloudActive;
  });
  /* 挂载时主动 ping 一次让 NeoxShellHost 广播当前态 */
  window.dispatchEvent(new CustomEvent('neox:request-cloud-state'));
}
function isActiveSessionCloud(): boolean { return __activeCloud; }

function stripCdPrefix(cmd: string, _workspacePath?: string): string {
  if (!cmd) return cmd;
  const m = cmd.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)\s*/);
  if (!m) return cmd;
  return cmd.slice(m[0].length).trimStart();
}

/**
 * dedent shell output — 找出所有非空行的最小前导空白宽度, 同等减去.
 *   wc -l 输出 "      44" → "44" (6 space padding 被吃掉)
 *   ls -l 输出 "total 5\n-rw..." → 不变 (minIndent=0)
 *   缩进的多行(如 mermaid)→ 相对缩进保留
 *   只用于 UI 展示, 不影响真实 stdout 数据.
 */
function dedentShellOutput(s: string): string {
  if (!s) return s;
  const lines = s.split('\n');
  /* 计算最小前导空白宽度 — 只看非空行 */
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.length === 0) continue;
    const m = line.match(/^[ \t]*/);
    const indent = m ? m[0].length : 0;
    /* 整行全是空白的不算 */
    if (indent === line.length) continue;
    if (indent < minIndent) minIndent = indent;
  }
  if (!Number.isFinite(minIndent) || minIndent === 0) return s;
  return lines.map(line => line.length >= minIndent ? line.slice(minIndent) : line).join('\n');
}

const XTERM_WRITE_TARGET_DRAIN_MS = 520;
const XTERM_WRITE_MIN_CPS = 5000;
const XTERM_WRITE_MAX_CPS = 52000;
const XTERM_WRITE_MIN_FRAME_CHARS = 96;
const XTERM_WRITE_MAX_FRAME_CHARS = 1600;
const XTERM_WRITE_PRESSURE_FRAME_MS = 22;
const XTERM_WRITE_PRESSURE_MAX_FRAME_CHARS = 8000;
function clampNumber(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function pendingTextLength(chunks: string[]): number {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  return total;
}

const TERMINAL_DONE_MIN_ROWS = 2;
const TERMINAL_DONE_MAX_ROWS = 10;
const TERMINAL_RUNNING_MIN_ROWS = 1;
const TERMINAL_RUNNING_MAX_ROWS = 12;
const TERMINAL_XTERM_FALLBACK_ROW_HEIGHT_PX = 15;
const TERMINAL_XTERM_VERTICAL_GUARD_PX = 22;

/* ---------- terminal (xterm.js) ----------
 * 真终端: 字节流直通, ANSI 序列保真(颜色 / `\r` 进度条原地刷新 / 光标控制都能正确渲染).
 *
 * 输入有两条:
 *   1. terminalChunkBus —— useStreamHandler 收到 shell_output_stream 时 emit 的 outputDelta.
 *      首选路径: 字节级保真, 不经过 React prop diff, 不会因为 timeline rerender 丢序列完整性.
 *   2. output prop —— timeline state 累积的全量字符串. 用于:
 *      a. mount 时 replay (历史回放 / 页面刷新)
 *      b. 兜底 (toolId 缺失 → bus 不可用 → 只能从 prop 算 delta)
 *
 * mount 后 output prop 后续变化对有 toolId 的路径**忽略**, 否则会跟 bus 重复 write.
 */
export const TerminalView: React.FC<{
  command?: string;
  output?: string;
  exitCode?: number;
  streaming?: boolean;
  toolId?: string;
  /** PTY pid — 有就接通 xterm 双向交互: onData → window.neox.shellStdin, ResizeObserver → shellResize */
  pid?: number;
  /** 命令转到后台继续跑了: 脚注写「已转后台」, 不写 exit 0 */
  backgrounded?: boolean;
}> = ({ command, output, exitCode, streaming, toolId, pid, backgrounded }) => {
  /* runtime context — 拿 workspacePath 拼 prompt cwd 用 (cd 后真实 cwd 拿不到, 用工作区根算 leaf 已够) */
  const runtime = useNeoxRuntimeOptional();
  const { isZh } = useI18n();
  const termRootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const themeObserverRef = useRef<MutationObserver | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const termStartRef = useRef<number>(streaming ? Date.now() : 0);
  // 兜底路径: 没 toolId 时记录已 write 长度, output prop 增长就 write delta
  const lastWrittenLenRef = useRef<number>(0);
  const pendingXtermChunksRef = useRef<string[]>([]);
  const xtermWriteFrameRef = useRef<number | null>(null);
  const xtermLastWriteAtRef = useRef<number | null>(null);
  const xtermWriteCarryRef = useRef(0);
  // 动态行数: 内容多少 ↔ xterm rows ↔ 容器高度. 长输出交给 xterm 内部滚动，不撑开 timeline。
  const displayRowsRef = useRef<number>(streaming ? TERMINAL_RUNNING_MIN_ROWS : TERMINAL_DONE_MIN_ROWS);
  const rowLimitRef = useRef({
    min: streaming ? TERMINAL_RUNNING_MIN_ROWS : TERMINAL_DONE_MIN_ROWS,
    max: streaming ? TERMINAL_RUNNING_MAX_ROWS : TERMINAL_DONE_MAX_ROWS,
  });
  /* PTY 接通后注册的 disposable — pid 变化或 unmount 时释放, 否则 onData 会重复 */
  const ptyBindingsRef = useRef<{ onDataDispose?: any; onResizeDispose?: any; lastResize?: { cols: number; rows: number } }>({});
  const trimTimerRef = useRef<number | null>(null);
  const scheduleTrimRows = useCallback(() => {
    if (trimTimerRef.current !== null) window.clearTimeout(trimTimerRef.current);
    let lastUsed = -1;
    const tick = () => {
      const term = xtermRef.current;
      if (!term) { trimTimerRef.current = null; return; }
      let used = 0;
      try {
        const buf = term.buffer.active;
        for (let i = buf.length - 1; i >= 0; i--) {
          if (buf.getLine(i)?.translateToString(true).trim()) { used = i + 1; break; }
        }
      } catch { trimTimerRef.current = null; return; /* 已 dispose */ }
      if (used !== lastUsed) {          /* 还在变 —— 再等一拍, 别抢在写入前面 */
        lastUsed = used;
        trimTimerRef.current = window.setTimeout(tick, 160);
        return;
      }
      trimTimerRef.current = null;
      if (used <= 0) return;
      const { min, max } = rowLimitRef.current;
      const want = Math.max(min, Math.min(max, used));
      if (want >= displayRowsRef.current) return;   /* 只收不放 */
      displayRowsRef.current = want;
      try { term.resize(term.cols, want); } catch { /* 已 dispose */ }
    };
    trimTimerRef.current = window.setTimeout(tick, 160);
  }, []);
  const flushXtermChunks = useCallback((now?: number) => {
    xtermWriteFrameRef.current = null;
    const term = xtermRef.current;
    const chunks = pendingXtermChunksRef.current;
    if (!term || chunks.length === 0) return;
    const last = xtermLastWriteAtRef.current ?? now ?? performance.now();
    const currentTime = now ?? performance.now();
    const elapsed = Math.max(8, Math.min(80, currentTime - last));
    xtermLastWriteAtRef.current = currentTime;
    const backlog = pendingTextLength(chunks);
    const charsPerSecond = clampNumber(
      backlog / (XTERM_WRITE_TARGET_DRAIN_MS / 1000),
      XTERM_WRITE_MIN_CPS,
      XTERM_WRITE_MAX_CPS,
    );
    xtermWriteCarryRef.current += charsPerSecond * (elapsed / 1000);
    const pressure = elapsed > XTERM_WRITE_PRESSURE_FRAME_MS || backlog > 12_000;
    const frameBudget = clampNumber(
      Math.floor(xtermWriteCarryRef.current),
      XTERM_WRITE_MIN_FRAME_CHARS,
      pressure ? XTERM_WRITE_PRESSURE_MAX_FRAME_CHARS : XTERM_WRITE_MAX_FRAME_CHARS,
    );
    xtermWriteCarryRef.current = Math.max(0, xtermWriteCarryRef.current - frameBudget);
    let written = '';
    let remainingBudget = frameBudget;
    while (chunks.length > 0 && remainingBudget > 0) {
      const head = chunks[0];
      if (head.length <= remainingBudget) {
        written += head;
        remainingBudget -= head.length;
        chunks.shift();
      } else {
        written += head.slice(0, remainingBudget);
        chunks[0] = head.slice(remainingBudget);
        remainingBudget = 0;
      }
    }
    try { if (written) term.write(written); } catch { /* xterm 已 dispose */ }
    if (chunks.length > 0) {
      xtermWriteFrameRef.current = requestAnimationFrame(flushXtermChunks);
    } else {
      xtermLastWriteAtRef.current = null;
      xtermWriteCarryRef.current = 0;
    }
  }, []);
  const enqueueXtermChunk = useCallback((chunk: string) => {
    if (!chunk) return;
    pendingXtermChunksRef.current.push(chunk);
    if (xtermWriteFrameRef.current !== null) return;
    xtermWriteFrameRef.current = requestAnimationFrame(flushXtermChunks);
  }, [flushXtermChunks]);
  /* 命令退出后追加空 prompt 行 (真 terminal 视觉) — closure 引用 mount IIFE 里算好的
   * tailPrompt 字节串, 不重复算 osInfo / wsLeaf. dedup ref 防止多次写. */
  const tailPromptRef = useRef<string | null>(null);
  const tailPromptWrittenRef = useRef<boolean>(false);
  const suppressedLineFeedResizeRef = useRef(0);
  const writeTailPromptIfNeeded = useCallback(() => {
    if (tailPromptWrittenRef.current) return;
    const seq = tailPromptRef.current;
    if (!seq) return;
    tailPromptWrittenRef.current = true;
    suppressedLineFeedResizeRef.current += 1;
    enqueueXtermChunk(seq);
  }, [enqueueXtermChunk]);

  const state =
    streaming ? 'is-running' :
    exitCode === 0 ? 'is-ok' :
    typeof exitCode === 'number' ? 'is-fail' : 'is-ok';

  /** 从本终端卡片优先读取 CSS var；背景用实际 computed background，避免 xterm 黑底和卡片底色割裂。 */
  const buildXtermTheme = () => {
    const rootCs = getComputedStyle(document.documentElement);
    const termCs = termRootRef.current ? getComputedStyle(termRootRef.current) : rootCs;
    const token = (n: string) => termCs.getPropertyValue(n).trim() || rootCs.getPropertyValue(n).trim();
    const cardBg = termCs.backgroundColor?.trim();
    const resolvedBg = cardBg && cardBg !== 'rgba(0, 0, 0, 0)' && cardBg !== 'transparent'
      ? cardBg
      : token('--xterm-bg');
    const v = (n: string, f: string) => token(n) || f;
    const bg = resolvedBg || '#1e1f22';
    return {
      background:          bg,
      foreground:          v('--xterm-fg',            '#dfe1e5'),
      cursor:              v('--xterm-cursor',        '#c19a6b'),
      cursorAccent:        v('--xterm-cursor-accent', bg),
      selectionBackground: v('--xterm-selection',     'rgba(193,154,107,0.28)'),
      /* 失焦后的选区 xterm 默认画成近黑块 (浅色主题下像一块黑胶布), 跟聚焦时同色 */
      selectionInactiveBackground: v('--xterm-selection', 'rgba(193,154,107,0.28)'),
      black:         v('--xterm-black',          '#1e1f22'),
      red:           v('--xterm-red',            '#f44747'),
      green:         v('--xterm-green',          '#4ec9b0'),
      yellow:        v('--xterm-yellow',         '#dcdcaa'),
      blue:          v('--xterm-blue',           '#569cd6'),
      magenta:       v('--xterm-magenta',        '#c586c0'),
      cyan:          v('--xterm-cyan',           '#4dc9b0'),
      white:         v('--xterm-white',          '#d4d4d4'),
      brightBlack:   v('--xterm-bright-black',   '#808080'),
      brightRed:     v('--xterm-bright-red',     '#f14c4c'),
      brightGreen:   v('--xterm-bright-green',   '#23d18b'),
      brightYellow:  v('--xterm-bright-yellow',  '#f5f543'),
      brightBlue:    v('--xterm-bright-blue',    '#3b8eea'),
      brightMagenta: v('--xterm-bright-magenta', '#d670d6'),
      brightCyan:    v('--xterm-bright-cyan',    '#29b8db'),
      brightWhite:   v('--xterm-bright-white',   '#ffffff'),
    };
  };

  /* xterm 实例生命周期 — mount/unmount; toolId 可停泊复用, 避免虚拟窗口反复冷启. */
  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let unsubscribeChunk: (() => void) | null = null;
    let parkOnCleanup = false;

    const attachObservers = (terminal: any, fitAddon: any) => {
      const themeObs = new MutationObserver(() => {
        if (!xtermRef.current) return;
        try { xtermRef.current.options.theme = buildXtermTheme(); } catch { /* ignore */ }
      });
      themeObs.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'data-theme-pack', 'data-theme-preset', 'data-darkmode', 'data-glass-off', 'class', 'style'],
      });
      themeObserverRef.current = themeObs;

      if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
        const ro = new ResizeObserver(() => {
          try { fitAddonRef.current?.fit(); } catch { /* ignore */ }
        });
        ro.observe(containerRef.current);
        resizeObserverRef.current = ro;
      }
      void terminal;
      void fitAddon;
    };

    const fontReady = (document as any).fonts?.load
      ? (document as any).fonts.load('12px "JetBrains Mono"').catch(() => undefined)
      : Promise.resolve();

    void (async () => {
      try { await fontReady; } catch { /* ignore */ }
      if (disposed || !containerRef.current) return;

      /* 保活池: 同 toolId 再进视口 → 只重新挂 DOM, 不 new Terminal */
      const parked = takeParkedTerminal(toolId);
      if (parked && containerRef.current) {
        try {
          containerRef.current.appendChild(parked.element);
          xtermRef.current = parked.terminal;
          fitAddonRef.current = parked.fitAddon;
          parkOnCleanup = !!toolId;
          try { parked.fitAddon?.fit(); } catch { /* ignore */ }
          requestAnimationFrame(() => {
            try { fitAddonRef.current?.fit(); } catch { /* ignore */ }
          });
          if (toolId) {
            const { subscribeTerminalChunk } = await import('../terminalChunkBus');
            if (disposed) return;
            unsubscribeChunk = subscribeTerminalChunk(toolId, (chunk) => {
              enqueueXtermChunk(chunk);
            });
          }
          attachObservers(parked.terminal, parked.fitAddon);
          return;
        } catch {
          try { parked.terminal.dispose(); } catch { /* ignore */ }
        }
      }

      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed || !containerRef.current) return;

      const cs = getComputedStyle(document.documentElement);
      const fontFamily =
        cs.getPropertyValue('--xterm-font-family').trim() ||
        cs.getPropertyValue('--font-mono').trim() ||
        '"JetBrains Mono", "SF Mono", "Fira Code", "Consolas", monospace';
      const fontSizeRaw = cs.getPropertyValue('--xterm-font-size').trim();
      const fontSize = parseInt(fontSizeRaw, 10) || 12;

      /* Timeline 内的 shell 必须克制高度：短输出 2-3 行起步，长输出在 xterm 内滚动。 */
      const MIN_ROWS = streaming ? TERMINAL_RUNNING_MIN_ROWS : TERMINAL_DONE_MIN_ROWS;
      const MAX_ROWS = streaming ? TERMINAL_RUNNING_MAX_ROWS : TERMINAL_DONE_MAX_ROWS;
      rowLimitRef.current = { min: MIN_ROWS, max: MAX_ROWS };
      termRootRef.current?.style.setProperty(
        '--atl-term-xterm-max-height',
        `${Math.ceil(fontSize * 1.2 * MAX_ROWS + TERMINAL_XTERM_VERTICAL_GUARD_PX)}px`,
      );

      const terminal = new Terminal({
        cursorBlink: false,
        cursorStyle: 'underline',
        /* xterm v5: 失焦时 cursor 隐藏 — 我们这个 xterm 用户不会去 focus, 等于永远隐藏 cursor.
           工具完成后不该再有光标块漂着. */
        cursorInactiveStyle: 'none' as any,
        /* disableStdin: false — 默认开 stdin, pid 没拿到时 onData 也只是一个空函数兜底,
           真有 pid 后副作用 effect 会注册 onData → window.neox.shellStdin. */
        disableStdin: false,
        fontSize,
        fontFamily,
        theme: buildXtermTheme(),
        scrollback: 5000,
        convertEol: true,
        allowProposedApi: true,
        /* 视觉调到接近真实 Terminal.app:
             · lineHeight 1.2 → 行间距更舒服, 不挤
             · letterSpacing 0 → cell 紧贴, 拉丁字符不漂
             · drawBoldTextInBrightColors false → 粗体不再变成 bright 色, 真终端默认行为
             · macOptionIsMeta true → Mac 用户 ⌥+键能在 vim/emacs 里发 Meta */
        lineHeight: 1.2,
        letterSpacing: 0,
        drawBoldTextInBrightColors: false,
        macOptionIsMeta: true,
        rows: MIN_ROWS,
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(containerRef.current);
      xtermRef.current = terminal;
      fitAddonRef.current = fitAddon;
      parkOnCleanup = !!toolId;
      try { fitAddon.fit(); } catch { /* ignore */ }

      /* 字体未 ready 时, fit() 用浏览器度量算的 char width 偏小, cols 算大,
       * 长 prompt 行(LLM 自带 cd 前缀)就不 wrap, 撑出容器横向溢出.
       * 字体 ready + 下一帧再 fit 一次, 让 cols 跟容器实际宽度匹配. */
      if (typeof document !== 'undefined' && (document as any).fonts?.ready) {
        (document as any).fonts.ready.then(() => {
          try { fitAddonRef.current?.fit(); } catch { /* ignore */ }
        }).catch(() => { /* ignore */ });
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          try { fitAddonRef.current?.fit(); } catch { /* ignore */ }
        });
      });

      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (disposed || !xtermRef.current) return;
        try { xtermRef.current.options.theme = buildXtermTheme(); } catch { /* ignore */ }
      }));

      /** 重新计算并应用 rows. 容器自身没 fixed height, xterm rows × line-height
       *  撑出尺寸, 容器跟着；到 MAX_ROWS 后内部 scrollback 滚动。 */
      const applyRows = (rows: number) => {
        const next = Math.max(MIN_ROWS, Math.min(MAX_ROWS, rows));
        if (next === displayRowsRef.current) return;
        displayRowsRef.current = next;
        try { terminal.resize(terminal.cols, next); } catch { /* ignore */ }
      };

      /* prompt 风格 — local 模式跟 Terminal.app 一致 (绿 user@host, 蓝 cwd leaf, 紫 %);
       * cloud 模式 pod 是 Linux 容器, 用 root@neox-cloud / workspace # 让用户看清楚命令实际在 pod 里跑, 不是本机.
       * ANSI 配色: 32m 绿 user@host; 34m 蓝 cwd; 35m 紫 %; 31m 红 # (root). */
      const wsPath: string = runtime?.workspacePath || '';
      const osInfo: any = (typeof window !== 'undefined' && (window as any)?.neox?.osInfo) || null;
      const isCloudSession = isActiveSessionCloud();
      let userHost: string;
      let wsLeaf: string;
      let promptSymbol: string;
      let symbolColor: string;
      if (isCloudSession) {
        userHost = 'root@neox-cloud';
        /* pod 实际 cwd = /workspace, 不展示 sessionId 末段 (太长且无意义) */
        wsLeaf = '/workspace';
        promptSymbol = '#';
        symbolColor = '31';  /* 红, root 标识 */
      } else {
        wsLeaf = wsPath ? (wsPath.split('/').filter(Boolean).pop() || '/') : '';
        void osInfo;
        userHost = '';
        promptSymbol = '%';
        symbolColor = '35';  /* 紫, zsh 默认 */
      }
      const buildPrompt = (cmd: string, withNewline: boolean) => {
        const nl = withNewline ? '\r\n' : '';
        if (userHost && wsLeaf) {
          return `\x1b[1;32m${userHost}\x1b[0m \x1b[1;34m${wsLeaf}\x1b[0m \x1b[1;${symbolColor}m${promptSymbol}\x1b[0m ${cmd}${nl}`;
        }
        if (userHost) {
          return `\x1b[1;32m${userHost}\x1b[0m \x1b[1;${symbolColor}m${promptSymbol}\x1b[0m ${cmd}${nl}`;
        }
        if (wsLeaf) {
          return `\x1b[1;34m${wsLeaf}\x1b[0m \x1b[1;${symbolColor}m${promptSymbol}\x1b[0m ${cmd}${nl}`;
        }
        return `\x1b[1;32m$\x1b[0m ${cmd}${nl}`;
      };
      const promptPrefixLen = userHost
        ? (userHost.length + (wsLeaf ? wsLeaf.length + 4 : 3))
        : wsLeaf ? wsLeaf.length + 3 : 2;

      let initialLines = 0;
      let cleanCmd = '';
      if (command) {
        cleanCmd = stripCdPrefix(command, wsPath);
        terminal.write(buildPrompt(cleanCmd, true));
        /* xterm wraparoundMode 默认开, 长命令按 cols 自动 wrap. 估算 wrap 后行数. */
        const cols = terminal.cols || 80;
        initialLines += Math.max(1, Math.ceil((promptPrefixLen + cleanCmd.length) / cols));
      }

      /* 把"末尾空 prompt 行"字节快照存到 ref — 命令完成时由 streaming → false 的 effect
       * (或 mount 时已完成的命令直接) 写到 xterm 末尾.
       * 视觉就是真 terminal: 命令退出后 zsh 接管立刻给你一行 prompt 等下一条输入.
       * \r\n 前缀让它另起一行, 不带尾 \r\n 是为了让光标停在 prompt 末尾. */
      tailPromptRef.current = '';

      /* onLineFeed 必须在任何 replay write 之前注册 — replay 整段字节流时 xterm
       * 内部解析会触发多次 LineFeed, 注册晚了那部分换行不计入容器高度估算,
       * 用户切回卡片时看到的是 MIN_ROWS 4 行的小窗口配长输出. */
      terminal.onLineFeed(() => {
        if (suppressedLineFeedResizeRef.current > 0) {
          suppressedLineFeedResizeRef.current -= 1;
          return;
        }
        applyRows(displayRowsRef.current + 1);
      });

      /* 2) 接通字节流 (首选): ring buffer + live emit 一次性接通.
       *   subscribeTerminalChunk 内部会 sync 重放该 toolId 的历史 chunk (256KB 上限),
       *   然后挂 listener 接 useStreamHandler 后续 emit. mount 时机晚于第一波 chunk
       *   也不丢序列 — 这是修复"运行中卡片为空"的关键. ring buffer 走的是字节级原文,
       *   ANSI / \r / 多字节 UTF-8 整段透传, 不做 dedent.
       *
       *   bufferReplayed 标记是否真有历史可放. subscribe 同步阶段调过 fn 就为 true,
       *   sync 返回后 closure 已经 set, 接着步骤 3 决定要不要 fallback entry.output. */
      let bufferReplayed = false;
      if (toolId) {
        const { subscribeTerminalChunk } = await import('../terminalChunkBus');
        unsubscribeChunk = subscribeTerminalChunk(toolId, (chunk) => {
          bufferReplayed = true;
          enqueueXtermChunk(chunk);
        });
      }

      /* 3) Fallback 路径: 没 toolId (老 entry / 离线测试) 或 ring buffer 空
       *   (页面刷新后整个 bus 重置 / 老命令对应的 toolId 还没接到任何 chunk) 时,
       *   用 entry.output 兜底一次性 write. 经过 dedent 修正 LLM 端加的缩进.
       *   ring buffer 路径里这步跳过, 避免双写重复. */
      if (!bufferReplayed && output) {
        const cleaned = dedentShellOutput(output);
        if (streaming) {
          enqueueXtermChunk(cleaned);
        } else {
          terminal.write(cleaned);
        }
        initialLines += cleaned.split('\n').length;
      }

      lastWrittenLenRef.current = output?.length || 0;
      applyRows(initialLines + 1); // +1 给底部留点 buffer

      /* 历史 replay 完毕后强制滚到顶部 — xterm 默认 follow cursor 会停在最末行,
       * 用户首先看到的是输出尾部 (像 image#35 那样只见 "...test-300.txt" + exit 0),
       * 命令本身反而被滚到不可见区. 短命令场景这是反直觉的, 应该从 prompt 行读起.
       * 实时 chunk 模式 (streaming=true) 还想跟着尾部, 这里只针对 replay (无 streaming). */
      if (!streaming) {
        try {
          xtermRef.current?.scrollToTop?.();
        } catch { /* ignore */ }
      }

      /* mount 时如果命令已经完成 (历史 entry 重 mount / 切回 timeline), 立刻写空 prompt 行.
       * 否则交给下方的 streaming-watcher effect, 在 streaming false 时机点写. */
      if (!streaming) {
        writeTailPromptIfNeeded();
        applyRows(displayRowsRef.current + 1);
      }

      attachObservers(terminal, fitAddon);
    })();

    return () => {
      disposed = true;
      if (trimTimerRef.current !== null) {
        window.clearTimeout(trimTimerRef.current);
        trimTimerRef.current = null;
      }
      unsubscribeChunk?.();
      if (xtermWriteFrameRef.current !== null) {
        cancelAnimationFrame(xtermWriteFrameRef.current);
        xtermWriteFrameRef.current = null;
      }
      xtermLastWriteAtRef.current = null;
      xtermWriteCarryRef.current = 0;
      pendingXtermChunksRef.current = [];
      themeObserverRef.current?.disconnect();
      themeObserverRef.current = null;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      const term = xtermRef.current;
      const fit = fitAddonRef.current;
      if (parkOnCleanup && parkTerminal(toolId, term, fit)) {
        xtermRef.current = null;
        fitAddonRef.current = null;
        return;
      }
      try { term?.dispose(); } catch { /* ignore */ }
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
    // 整个 lifecycle 由组件 mount/unmount 控制. toolId 变化语义 = "换了一个 entry",
    // 上层用 key 重建即可, 不在 deps 里跟踪以避免 prop 抖动反复 dispose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 命令完成的瞬间 (streaming: true → false) 追加空 prompt 行 — 视觉等输入感.
   * 真 terminal 行为对齐: `python ...` 退出 → zsh 接管 → 立刻显示一行新 prompt.
   * dedup ref 保证只写一次; mount 时已完成的 entry 由 IIFE 内联调用兜住 (那里也走同一个
   * writeTailPromptIfNeeded, ref 互锁). */
  useEffect(() => {
    if (streaming) return;
    writeTailPromptIfNeeded();
    /* 不再为完成态强行 +1 行；否则“展开全部”/历史回放会被 fake tail prompt 撑高。 */
    try {
      const term = xtermRef.current;
      if (term) {
        const { min, max } = rowLimitRef.current;
        const rows = Math.max(min, Math.min(max, displayRowsRef.current));
        term.resize(term.cols, rows);
      }
    } catch { /* xterm 已 dispose */ }
    /* 等字节流写完、内容静止后再把多余空行收掉 (见 scheduleTrimRows 的注释) */
    scheduleTrimRows();
  }, [streaming, writeTailPromptIfNeeded, scheduleTrimRows]);

  useEffect(() => {
    if (toolId) return;
    if (!xtermRef.current) return;
    const next = output || '';
    const written = lastWrittenLenRef.current;
    if (next.length <= written) {
      // 缩短 (不该发生) / 不变 → 不动. 跨 entry 复用场景已经被 key 重建拦掉.
      return;
    }
    const delta = next.slice(written);
    enqueueXtermChunk(delta);
    lastWrittenLenRef.current = next.length;
  }, [enqueueXtermChunk, output, toolId]);

  /* PTY 双向接通 — pid 是 async 拿到的(shell_started → shell_output_stream 透传),
     xterm 实例也是 async 在 mount effect 里 init (字体 ready). 两者都 ready 才能 bind:
       1. 把 xterm onData (用户键入字节) 通过 IPC 转发到 helper daemon → PTY stdin
       2. 把 xterm onResize (容器/字号变化触发) cols/rows 同步到 PTY (less/vim/htop 才不错位)
     pid 变化或 unmount 时释放 disposable, 不让旧的 onData 继续往死 pid 写. */
  useEffect(() => {
    if (!pid) return;
    let cancelled = false;
    let dataDispose: any;
    let resizeDispose: any;

    const tryBind = (attempt: number) => {
      if (cancelled) return;
      const term = xtermRef.current;
      if (!term) {
        // xterm 还没 init 完(字体 load + 动态 import xterm), 退避重试. 5s 内 ~50 次.
        if (attempt < 50) setTimeout(() => tryBind(attempt + 1), 100);
        return;
      }
      const w: any = (typeof window !== 'undefined') ? window : null;
      const shellStdin: ((p: number, d: string) => any) | undefined = w?.neox?.shellStdin;
      const shellResize: ((p: number, c: number, r: number) => any) | undefined = w?.neox?.shellResize;
      try {
        if (typeof shellStdin === 'function') {
          dataDispose = term.onData((data: string) => {
            try { shellStdin(pid, data); } catch { /* daemon down → 静默丢弃, 不卡 UI */ }
          });
        }
        if (typeof shellResize === 'function') {
          /* xterm 内部 resize (fitAddon.fit / terminal.resize) 都会触发. 节流: 同 cols/rows
             不重复发 (xterm 在 cell 计算时偶尔会回弹一次相同值). */
          resizeDispose = term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
            const last = ptyBindingsRef.current.lastResize;
            if (last && last.cols === cols && last.rows === rows) return;
            ptyBindingsRef.current.lastResize = { cols, rows };
            try { shellResize(pid, cols, rows); } catch { /* 同上 */ }
          });
          /* 立刻同步一次当前尺寸: 拿到 pid 时 daemon PTY 默认 120×30, 真实 xterm 可能不一样 */
          try { shellResize(pid, term.cols, term.rows); } catch { /* ignore */ }
          ptyBindingsRef.current.lastResize = { cols: term.cols, rows: term.rows };
        }
      } catch { /* ignore */ }
      ptyBindingsRef.current.onDataDispose = dataDispose;
      ptyBindingsRef.current.onResizeDispose = resizeDispose;
    };
    tryBind(0);

    return () => {
      cancelled = true;
      try { dataDispose?.dispose?.(); } catch { /* ignore */ }
      try { resizeDispose?.dispose?.(); } catch { /* ignore */ }
      ptyBindingsRef.current.onDataDispose = undefined;
      ptyBindingsRef.current.onResizeDispose = undefined;
    };
  }, [pid]);

  /* 不再在命令完成时 scrollIntoView。Timeline 是唯一滚动 owner；
   * terminal 完成时主动平滑滚动会和用户手势/主 timeline 布局抢 scrollTop，造成抖动。 */
  const termMaxRows = streaming ? TERMINAL_RUNNING_MAX_ROWS : TERMINAL_DONE_MAX_ROWS;
  const termStyle = {
    '--atl-term-xterm-max-height': `${termMaxRows * TERMINAL_XTERM_FALLBACK_ROW_HEIGHT_PX + TERMINAL_XTERM_VERTICAL_GUARD_PX}px`,
  } as React.CSSProperties;
  return (
    <div className={`atl-term ${state}`} ref={termRootRef} style={termStyle}>
      {/* 命令在 xterm 第一行用 ANSI prompt 显示 (Windsurf 风格), 不再单独 head div.
       * 容器不固定 height —— xterm rows 动态(MIN_ROWS..MAX_ROWS)撑出自身高度. */}
      <div className="atl-term__xterm" ref={containerRef} />
      {((streaming && typeof pid === 'number' && pid > 0) || (!streaming && (backgrounded || typeof exitCode === 'number'))) && (
        <div className="atl-term__foot">
          {streaming ? null : backgrounded ? (
            <span className="atl-term__chip is-running">{isZh ? '已转后台' : 'In background'}</span>
          ) : exitCode === 0 ? (
            <span className="atl-term__chip is-ok">exit 0</span>
          ) : (
            <span className="atl-term__chip is-fail">exit {exitCode}</span>
          )}
          {/* 不写 cwd: 这里只拿得到窗口的工作区, 拿不到命令真实跑在哪 (cd 过 / 会话目录不同), 写错比不写糟 */}
          {!streaming && <span className="atl-term__sp" />}
          {!streaming && (command || output) && (
            <CopyIconButton
              className="atl-term__copy"
              label={isZh ? '复制' : 'Copy'}
              getText={() => [command ? `$ ${command}` : '', output ? stripAnsi(output).trimEnd() : ''].filter(Boolean).join('\n')}
            />
          )}
          {/* pid + 控制按钮 — 仅在 streaming(运行中) 且拿到 pid 时显示.
            * 长期服务 (npm dev / dev server / file watcher 等) 可能跑很久, 用户
            * 需要直接 kill / 暂停 / 恢复, 不用让 agent 再调 bash_kill */}
          {streaming && typeof pid === 'number' && pid > 0 && (
            <>
              <span className="atl-term__chip atl-term__chip--pid" title={`PID ${pid}`}>pid {pid}</span>
              <button
                type="button"
                className="atl-term__ctrl atl-term__ctrl--pause"
                title={isZh ? '暂停 (SIGTSTP)' : 'Pause (SIGTSTP)'}
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    await (window as any).neox?.pauseBackgroundTask?.(pid);
                    void import('../../../components/notifyEvents').then(m => m.dispatchHint(isZh ? `已暂停 PID ${pid}` : `Paused PID ${pid}`, 'info'));
                  } catch (err: any) {
                    void import('../../../components/notifyEvents').then(m => m.dispatchOpFailed({ op: isZh ? '暂停进程' : 'Pause process', message: err?.message || (isZh ? '失败' : 'Failed') }));
                  }
                }}
              >⏸</button>
              <button
                type="button"
                className="atl-term__ctrl atl-term__ctrl--resume"
                title={isZh ? '恢复 (SIGCONT)' : 'Resume (SIGCONT)'}
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    await (window as any).neox?.resumeBackgroundTask?.(pid);
                    void import('../../../components/notifyEvents').then(m => m.dispatchHint(isZh ? `已恢复 PID ${pid}` : `Resumed PID ${pid}`, 'info'));
                  } catch (err: any) {
                    void import('../../../components/notifyEvents').then(m => m.dispatchOpFailed({ op: isZh ? '恢复进程' : 'Resume process', message: err?.message || (isZh ? '失败' : 'Failed') }));
                  }
                }}
              >▶</button>
              <button
                type="button"
                className="atl-term__ctrl atl-term__ctrl--stop"
                title={isZh ? '停止 (SIGTERM, 2s 后 SIGKILL)' : 'Stop (SIGTERM, then SIGKILL after 2s)'}
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    await (window as any).neox?.killBackgroundTask?.(pid, false);
                    void import('../../../components/notifyEvents').then(m => m.dispatchHint(isZh ? `已发送 SIGTERM 给 PID ${pid}` : `Sent SIGTERM to PID ${pid}`, 'success'));
                  } catch (err: any) {
                    void import('../../../components/notifyEvents').then(m => m.dispatchOpFailed({ op: isZh ? '停止进程' : 'Stop process', message: err?.message || (isZh ? '失败' : 'Failed') }));
                  }
                }}
              >■</button>
            </>
          )}
        </div>
      )}
    </div>
  );
};
