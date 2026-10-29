/**
 * Terminal Panel - xterm.js 终端组件
 * 提供完整的终端模拟器功能
 */

import { useI18n } from '../../../hooks/useI18n';
import { copyToClipboard } from '../../../utils/copyToClipboard';
import React, { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import Icons from '../../../components/Icons';

export type TerminalTheme = 'dark' | 'light';

interface TerminalPanelProps {
  sessionId?: string;
  cwd?: string;
  onSessionCreated?: (sessionId: string) => void;
  onSessionDestroyed?: (sessionId: string) => void;
  height?: number | string;
  className?: string;
  /** xterm 配色方案: dark (默认 IDEA 风) / light (跟设计图对齐, 白底) */
  theme?: TerminalTheme;
  /** 用户在退出 overlay 点"关闭 Tab" 时上抛给 TerminalManager 真删 tab —
   *  没传就只显示"重启", 避免出现按了不响应的死按钮. */
  onCloseTab?: () => void;
  /** 是否当前 active tab — false 时 hidden 不渲染, true 时立刻 fit.
   *  让多 tab 都常驻挂载, 切换只切 display, 避免重建 xterm/PTY 的"重新加载感". */
  active?: boolean;
}

/* xterm theme — 用户报"终端右侧白条" 真因: 之前 light theme background hardcoded '#FFFFFF',
 * xterm.js 把它当 inline style 写在 .xterm-scrollable-element 上, 跟周围 cream 主题的
 * --neox-bg-canvas 不一致 → 多出一条白色 vertical strip.
 * 改用 readCssVar 在创建主题时动态读取当前主题的 canvas / fg 颜色, 暖阳/晨光/墨夜全跟随. */
function readCssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function parseColorLuminance(color: string): number | null {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (hex) return parseInt(hex[1], 16) * 0.299 + parseInt(hex[2], 16) * 0.587 + parseInt(hex[3], 16) * 0.114;
  const rgb = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (rgb) return parseInt(rgb[1]) * 0.299 + parseInt(rgb[2]) * 0.587 + parseInt(rgb[3]) * 0.114;
  return null;
}

function resolveRealBgColor(): string {
  if (typeof document === 'undefined') return '#FFFFFF';
  const root = document.documentElement;
  const cssVar = getComputedStyle(root).getPropertyValue('--neox-bg-canvas').trim();
  if (cssVar && cssVar !== 'transparent' && cssVar !== 'initial' && cssVar !== 'inherit') {
    if (parseColorLuminance(cssVar) !== null) return cssVar;
  }
  const cardVar = getComputedStyle(root).getPropertyValue('--neox-bg-card').trim();
  if (cardVar && cardVar !== 'transparent' && parseColorLuminance(cardVar) !== null) return cardVar;
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  if (bodyBg && parseColorLuminance(bodyBg) !== null) return bodyBg;
  const preset = root.getAttribute('data-theme-preset');
  if (preset === 'moye') return '#1e1f22';
  return '#FFFFFF';
}

function isCanvasDark(): boolean {
  const lum = parseColorLuminance(resolveRealBgColor());
  return lum !== null ? lum < 128 : false;
}

function buildXtermTheme(_mode: 'dark' | 'light') {
  const bg = resolveRealBgColor();
  const isDark = isCanvasDark();
  const fg = readCssVar('--neox-fg-primary', isDark ? '#bcbec4' : '#141824');

  if (isDark) {
    return {
      background: bg,
      foreground: fg,
      cursor: readCssVar('--neox-fg-accent', '#c9a227'),
      cursorAccent: bg,
      selectionBackground: 'rgba(255,255,255,0.10)',
      black: '#1e1f22',
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
  }
  return {
    background: bg,
    foreground: fg,
    cursor: readCssVar('--neox-primary-500', '#6E56FF'),
    cursorAccent: bg,
    selectionBackground: 'rgba(0,0,0,0.08)',
    black: '#141824',
    red: '#D63A3A',
    green: '#1F8C4D',
    yellow: '#B27800',
    blue: '#2563EB',
    magenta: '#7C3AED',
    cyan: '#0E7490',
    white: '#3A3F4D',
    brightBlack: '#6B7080',
    brightRed: '#E04545',
    brightGreen: '#28A75F',
    brightYellow: '#C28800',
    brightBlue: '#3B7BFA',
    brightMagenta: '#9755F0',
    brightCyan: '#1A8DA8',
    brightWhite: '#141824',
  };
}

const MIN_FIT_COLS = 20;
function fitAndSync(fit: FitAddon, term: Terminal, sessionId: string | null): boolean {
  const dims = fit.proposeDimensions();
  if (!dims || !Number.isFinite(dims.cols) || dims.cols < MIN_FIT_COLS || dims.rows < 2) return false;
  fit.fit();
  if (sessionId) window.neox?.terminalResize?.(sessionId, term.cols, term.rows);
  return true;
}

/* 复制 / 粘贴快捷键。mac 上 ⌘C/⌘V 走应用菜单的 Edit 角色, 本来就好用;
 * Windows / Linux 上 Ctrl+C / Ctrl+V 会被 xterm 当成 ^C / ^V 发给 shell, 于是内置终端既不能复制也不能粘贴。
 * 规矩照 Windows Terminal / VS Code: 有选区时 Ctrl+C 复制 (没选区仍是中断), Ctrl+Shift+C 总是复制,
 * Ctrl+V / Ctrl+Shift+V 交给浏览器原生粘贴 (xterm 自己会收 paste 事件并按 bracketed paste 写进去)。 */
function attachClipboardKeys(term: Terminal): void {
  if (navigator.platform.toLowerCase().includes('mac')) return;
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return true;
    const key = e.key.toLowerCase();
    if (key === 'c' && (e.shiftKey || term.hasSelection())) {
      const sel = term.getSelection();
      if (sel) void copyToClipboard(sel);
      term.clearSelection();
      e.preventDefault();
      return false;
    }
    /* 返回 false 且不 preventDefault: xterm 不发 ^V, 浏览器照常触发 paste */
    if (key === 'v') return false;
    return true;
  });
}

export interface TerminalHandle {
  copySelection: () => boolean;
  selectAll: () => void;
  hasSelection: () => boolean;
}

const TerminalPanel = forwardRef<TerminalHandle, TerminalPanelProps>(({
  sessionId: initialSessionId,
  cwd,
  onSessionCreated,
  onSessionDestroyed,
  height = 300,
  className = '',
  theme = 'dark',
  onCloseTab,
  active = true,
}, ref) => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  /* 暴露给工具栏的复制/全选 (xterm 内部选区, 非 DOM 选区) */
  useImperativeHandle(ref, () => ({
    copySelection: () => {
      const t = xtermRef.current;
      const sel = t?.getSelection() ?? '';
      if (!sel) return false;
      void copyToClipboard(sel);
      return true;
    },
    selectAll: () => { xtermRef.current?.selectAll(); },
    hasSelection: () => !!xtermRef.current?.hasSelection(),
  }), []);
  const sessionIdRef = useRef<string | null>(initialSessionId || null);
  const unsubscribeDataRef = useRef<(() => void) | null>(null);
  const unsubscribeExitRef = useRef<(() => void) | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId || null);
  const [isConnected, setIsConnected] = useState(false);
  /* 退出态 — shell exit 后渲染 overlay 给用户「重启/关闭 Tab」出路.
   * 用户报"exit 后没闭环 反人类", [Process exited] 红字孤悬, 没操作入口.  */
  const [processExited, setProcessExited] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);

  // 同步 sessionId 到 ref
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    term.options.theme = buildXtermTheme(theme);
    term.options.cursorStyle = theme === 'light' ? 'bar' : 'block';
  }, [theme]);

  useEffect(() => {
    const onPack = () => requestAnimationFrame(() => {
      const term = xtermRef.current;
      if (term) term.options.theme = buildXtermTheme(theme);
    });
    window.addEventListener('neox:theme-pack-applied', onPack);
    return () => window.removeEventListener('neox:theme-pack-applied', onPack);
  }, [theme]);

  // 初始化终端
  useEffect(() => {
    if (!terminalRef.current) return;

    /* 先等所有 in-flight font 加载完成再 new Terminal — xterm canvas renderer 在 init
     * 时测 glyph 尺寸并缓存. 如果此刻字体还在下载, canvas 用 fallback 字体测,
     * 后续即使字体加载完, ❯ 等 Nerd Font 字符还按 fallback 画 → 出现 "%c" placeholder.
     *
     * 改用 document.fonts.ready (等所有 @font-face 的 load 完成) 而不是 fonts.load(单字体),
     * 因为 MesloLGS NF / JetBrains Nerd Font / FiraCode 三个 fallback 都需要等. */
    let disposed = false;
    const fontReady: Promise<unknown> = (document as any).fonts?.ready
      ? (document as any).fonts.ready.catch(() => undefined)
      : Promise.resolve();

    void (async () => {
      try { await fontReady; } catch { /* ignore */ }
      if (disposed || !terminalRef.current) return;

      // 创建 xterm 实例
      const terminal = new Terminal({
        cursorBlink: true,
        cursorStyle: theme === 'light' ? 'bar' : 'block',
        fontSize: 12.5,
        fontFamily: '"MesloLGS NF", "JetBrainsMono Nerd Font", "FiraCode Nerd Font Mono", "SF Mono", "Menlo", "Consolas", monospace',
        theme: buildXtermTheme(theme),
        allowProposedApi: true,

        scrollback: 10000,

        /* macOptionIsMeta: 默认 false —— 于是在 macOS 上按 Option+B / Option+F
         *   (终端里按词左右移动的标准键) 得到的是 `∫` 和 `ƒ` 这种字符。
         *   非 mac 上保持 false: 那里 Option 就是 Alt, 本来就当 Meta 用。 */
        macOptionIsMeta: navigator.platform.toLowerCase().includes('mac'),

        /* 右键选中整个词 —— macOS 终端的一贯行为 (双击选词, 右键也选词再弹菜单)。 */
        rightClickSelectsWord: true,

        /* drawBoldTextInBrightColors: 默认 **true**, 会把粗体自动换成"亮色版本"。
         *   很多 CLI 用 bold 只是想加粗 (比如 git 的文件名、npm 的包名), 并没打算换颜色,
         *   于是屏幕上出来的颜色跟程序的本意对不上。关掉 = 忠实渲染。 */
        drawBoldTextInBrightColors: false,

        /* 滚轮一次 3 行 —— 默认 1 行, 翻几千行的构建日志会翻到手酸。
         *   3 是 VS Code / iTerm 的常用值, 不至于快到看不清。 */
        scrollSensitivity: 3,
      });

      // 添加插件
      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);

      // 挂载到 DOM
      terminal.open(terminalRef.current);

      attachClipboardKeys(terminal);

      xtermRef.current = terminal;
      fitAddonRef.current = fitAddon;

      setTimeout(() => {
        try {
          fitAndSync(fitAddon, terminal, null);
          createSession();
        } catch (error) {
          console.error('[Terminal] Failed to fit terminal:', error);
          createSession();
        }
      }, 0);

      // 监听用户输入
      terminal.onData((data) => {
        if (sessionIdRef.current) {
          window.neox?.terminalWrite?.(sessionIdRef.current, data);
        }
      });
    })();

    // 监听 window resize + 容器自身 resize.
    //   window resize 只 fire 整窗大小变, 但 IDE bottom panel 拖高度/侧栏拖宽度 是容器大小变
    //   window 不动, 没有事件. 用户报 "ls output 只用 2 列没充分利用宽度" 真因 — fit 没重跑,
    //   xterm cols 是 init 时的旧值, 远小于容器实际宽. ResizeObserver 监听容器自己, 每次变都 fit + 通知 pty.
    const handleResize = () => {
      if (!fitAddonRef.current || !xtermRef.current || !terminalRef.current) return;
      /* 非 active (display:none) 时容器 0×0, fit 会把 PTY cols 设成 0 然后下次 active 时
       * shell 已经按 0 列输出过提示, 排版乱掉. 直接守卫: 容器无尺寸时跳过. */
      if (terminalRef.current.clientWidth === 0 || terminalRef.current.clientHeight === 0) return;
      try {
        fitAndSync(fitAddonRef.current, xtermRef.current, sessionIdRef.current);
      } catch (error) {
        console.error('[Terminal] Failed to resize terminal:', error);
      }
    };
    window.addEventListener('resize', handleResize);
    /* container 级 resize (panel 拖高 / sidebar 拖宽 / split 等) — RAF coalescing 防止抖动期间狂调 */
    let rafId: number | null = null;
    const ro: ResizeObserver | null = (typeof ResizeObserver !== 'undefined' && terminalRef.current)
      ? new ResizeObserver(() => {
          if (rafId !== null) cancelAnimationFrame(rafId);
          rafId = requestAnimationFrame(() => {
            rafId = null;
            handleResize();
          });
        })
      : null;
    if (ro && terminalRef.current) ro.observe(terminalRef.current);

    return () => {
      disposed = true;
      window.removeEventListener('resize', handleResize);
      if (rafId !== null) cancelAnimationFrame(rafId);
      ro?.disconnect();
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      unsubscribeDataRef.current?.();
      unsubscribeExitRef.current?.();
      if (sessionIdRef.current) {
        window.neox?.terminalDestroy?.(sessionIdRef.current);
      }
    };
  }, []);

  // 创建终端会话
  const createSession = async () => {
    try {
      // 清理旧的事件订阅
      unsubscribeDataRef.current?.();
      unsubscribeExitRef.current?.();

      const cols = xtermRef.current?.cols;
      const rows = xtermRef.current?.rows;
      const result = await window.neox?.terminalCreate?.({ cwd, cols, rows });
      if (result && result.sessionId) {
        const id = result.sessionId;
        sessionIdRef.current = id;
        setSessionId(id);
        setIsConnected(true);
        onSessionCreated?.(id);
        if (result.windowsPty && xtermRef.current) xtermRef.current.options.windowsPty = result.windowsPty;

        /* PTY 出生后 next-frame 再 fit + resize 一次 — 字体加载有时 ready 但 glyph
         * metrics 还没刷, 首帧后 charWidth 才稳; 这一步把 xterm/PTY 都对齐到最终 cols. */
        requestAnimationFrame(() => {
          try {
            if (fitAddonRef.current && xtermRef.current) {
              fitAndSync(fitAddonRef.current, xtermRef.current, sessionIdRef.current);
            }
          } catch { /* ignore */ }
        });

        // 订阅终端输出 — 首条 data 把前导换行 strip 掉, 避免 shell rc / conda init / starship
        // 等 prompt 实现习惯先输出 \n 让 prompt 跟上行错开, 在 xterm 里就成了首行空白.
        let firstChunk = true;
        unsubscribeDataRef.current = window.neox?.onTerminalData?.((event) => {
          if (event.sessionId === id && xtermRef.current) {
            let data = event.data;
            if (firstChunk) {
              firstChunk = false;
              data = data.replace(/^(?:\r?\n)+/, '');  // 砍掉前导 \n / \r\n
            }
            xtermRef.current.write(data);
          }
        }) || null;

        // 订阅终端退出 — 红字标记 + 拉起 overlay 给"重启/关闭" 出路
        unsubscribeExitRef.current = window.neox?.onTerminalExit?.((event) => {
          if (event.sessionId === id) {
            const code = (event as { exitCode?: number }).exitCode;
            setIsConnected(false);
            setProcessExited(true);
            setExitCode(typeof code === 'number' ? code : null);
            xtermRef.current?.write(
              `\r\n\x1b[31m[Process exited${typeof code === 'number' ? ` · code ${code}` : ''}]\x1b[0m\r\n`,
            );
            onSessionDestroyed?.(id);
          }
        }) || null;
      }
    } catch (error) {
      console.error('[TerminalPanel] Failed to create session:', error);
      xtermRef.current?.write('\x1b[31mFailed to create terminal session\x1b[0m\r\n');
    }
  };

  // 重新连接 — overlay 的"重启" 按钮 + 工具栏刷新都走这条
  const handleReconnect = () => {
    if (sessionIdRef.current) {
      window.neox?.terminalDestroy?.(sessionIdRef.current);
      sessionIdRef.current = null;
    }
    setProcessExited(false);
    setExitCode(null);
    xtermRef.current?.clear();
    createSession();
  };

  // 清屏
  const handleClear = () => {
    xtermRef.current?.clear();
  };

  // 适应大小
  useEffect(() => {
    const timer = setTimeout(() => {
      if (fitAddonRef.current && xtermRef.current) {
        try {
          fitAndSync(fitAddonRef.current, xtermRef.current, sessionIdRef.current);
        } catch (error) {
          console.error('[Terminal] Failed to fit terminal on height change:', error);
        }
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [height]);

  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => {
      if (!fitAddonRef.current || !xtermRef.current || !terminalRef.current) return;
      if (terminalRef.current.clientWidth === 0) return;
      try {
        fitAndSync(fitAddonRef.current, xtermRef.current, sessionIdRef.current);
        xtermRef.current.focus();
      } catch { /* ignore */ }
    }, 0);
    return () => clearTimeout(t);
  }, [active]);

  return (
    <div
      className={`terminal-panel ${className}`}
      style={{
        height,
        display: active ? 'flex' : 'none',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* header 已移到 TerminalManager tabbar，这里只保留终端内容 */}
      <div
        ref={terminalRef}
        className="terminal-container"
        style={{
          flex: 1,
          overflow: 'hidden',
          minHeight: 0,
        }}
      />
      {/* exit overlay — shell 退出后, 在终端底部叠一条 action bar 给用户出路:
       *   ↻ 重启 shell  ·  ✕ 关闭 Tab. 不挡输出, 用户能滚回去看 exit 前的日志.
       *   onCloseTab 没传时只渲染重启, 避免出现按了不响应的死按钮. */}
      {processExited && (
        <div className="terminal-exit-bar" role="alert">
          <span className="terminal-exit-bar__msg">
            {zh ? 'Shell 已退出' : 'Shell exited'}{exitCode !== null ? ` · code ${exitCode}` : ''}
          </span>
          <button
            type="button"
            className="terminal-exit-bar__btn terminal-exit-bar__btn--primary"
            onClick={handleReconnect}
            autoFocus
          >{zh ? '↻ 重启' : '↻ Restart'}</button>
          {onCloseTab && (
            <button
              type="button"
              className="terminal-exit-bar__btn"
              onClick={onCloseTab}
            >{zh ? '✕ 关闭 Tab' : '✕ Close tab'}</button>
          )}
        </div>
      )}
    </div>
  );
});
TerminalPanel.displayName = 'TerminalPanel';

export default TerminalPanel;
