/**
 * TerminalAdapter - 跨平台终端兼容层
 *
 * 解决的问题：
 * 1. Win/WSL/macOS/Linux 的 resize 事件不一致
 * 2. 不同终端对 ANSI 序列支持不同
 * 3. Synchronized Update 防闪烁
 * 4. Alternate Screen 支持
 * 5. Diff 渲染优化
 */

import { EventEmitter } from 'events';
import type { Writable } from 'stream';

// ============================================================================
// Types
// ============================================================================

export interface TerminalSize {
  columns: number;
  rows: number;
}

export interface TerminalCapabilities {
  /** 支持 256 色 */
  color256: boolean;
  /** 支持 true color (24-bit) */
  trueColor: boolean;
  /** 支持 Synchronized Update (DEC 2026) */
  synchronizedUpdate: boolean;
  /** 支持 Alternate Screen */
  alternateScreen: boolean;
  /** 支持 bracketed paste */
  bracketedPaste: boolean;
  /** 支持鼠标事件 */
  mouse: boolean;
  /** 支持 Unicode */
  unicode: boolean;
  /** 终端类型 */
  terminalType: TerminalType;
  /** 是否在 CI 环境 */
  isCI: boolean;
  /** 是否是 TTY */
  isTTY: boolean;
}

export type TerminalType =
  | 'iterm'
  | 'vscode'
  | 'windows-terminal'
  | 'conpty'
  | 'mintty'
  | 'xterm'
  | 'gnome-terminal'
  | 'konsole'
  | 'alacritty'
  | 'kitty'
  | 'wezterm'
  | 'hyper'
  | 'terminal-app'  // macOS Terminal.app
  | 'wsl'
  | 'unknown';

export type Platform = 'darwin' | 'linux' | 'win32' | 'wsl';

export interface TerminalAdapterOptions {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  /** 强制禁用某些特性 */
  forceDisable?: {
    synchronizedUpdate?: boolean;
    alternateScreen?: boolean;
    color?: boolean;
  };
  /** resize 轮询间隔 (ms)，0 禁用轮询 */
  resizePollInterval?: number;
}

// ============================================================================
// ANSI Escape Sequences
// ============================================================================

export const ANSI = {
  // Cursor
  CURSOR_HIDE: '\x1b[?25l',
  CURSOR_SHOW: '\x1b[?25h',
  CURSOR_SAVE: '\x1b[s',
  CURSOR_RESTORE: '\x1b[u',
  CURSOR_HOME: '\x1b[H',
  cursorTo: (x: number, y?: number) =>
    y !== undefined ? `\x1b[${y + 1};${x + 1}H` : `\x1b[${x + 1}G`,
  cursorMove: (dx: number, dy: number) => {
    let seq = '';
    if (dy < 0) seq += `\x1b[${-dy}A`;
    if (dy > 0) seq += `\x1b[${dy}B`;
    if (dx > 0) seq += `\x1b[${dx}C`;
    if (dx < 0) seq += `\x1b[${-dx}D`;
    return seq;
  },
  cursorUp: (n = 1) => `\x1b[${n}A`,
  cursorDown: (n = 1) => `\x1b[${n}B`,
  cursorForward: (n = 1) => `\x1b[${n}C`,
  cursorBack: (n = 1) => `\x1b[${n}D`,

  // Erase
  ERASE_LINE: '\x1b[2K',
  ERASE_LINE_END: '\x1b[K',
  ERASE_LINE_START: '\x1b[1K',
  ERASE_SCREEN: '\x1b[2J',
  ERASE_SCREEN_DOWN: '\x1b[J',
  ERASE_SCREEN_UP: '\x1b[1J',

  /**
   * 清除 n 行（从当前光标位置向上）
   *
   * 🔥 关键：这个函数假设光标在输出区域的最后一行末尾
   * 清除后光标回到输出区域的第一行开头
   */
  eraseLines: (n: number) => {
    if (n <= 0) return '';

    // 简单直接的方案：
    // 1. 上移到顶部
    // 2. 清除从当前位置到屏幕底部的所有内容
    // 3. 回到行首
    let seq = '';
    if (n > 1) {
      seq += `\x1b[${n - 1}A`; // 上移 n-1 行
    }
    seq += '\r';              // 回到行首
    seq += '\x1b[J';          // 清除从光标到屏幕底部
    return seq;
  },

  // Scroll
  scrollUp: (n = 1) => `\x1b[${n}S`,
  scrollDown: (n = 1) => `\x1b[${n}T`,

  // Alternate Screen
  ALT_SCREEN_ENTER: '\x1b[?1049h',
  ALT_SCREEN_LEAVE: '\x1b[?1049l',

  // Alternate Scroll (让滚轮在 alt screen 中工作)
  ALT_SCROLL_ENABLE: '\x1b[?1007h',
  ALT_SCROLL_DISABLE: '\x1b[?1007l',

  // Synchronized Update (DEC 2026) - 防闪烁
  SYNC_START: '\x1b[?2026h',
  SYNC_END: '\x1b[?2026l',

  // Bracketed Paste
  BRACKETED_PASTE_ENABLE: '\x1b[?2004h',
  BRACKETED_PASTE_DISABLE: '\x1b[?2004l',

  // Mouse
  MOUSE_ENABLE: '\x1b[?1000h\x1b[?1002h\x1b[?1015h\x1b[?1006h',
  MOUSE_DISABLE: '\x1b[?1006l\x1b[?1015l\x1b[?1002l\x1b[?1000l',

  // Query terminal size (DSR - Device Status Report)
  QUERY_SIZE: '\x1b[18t',
  QUERY_CURSOR_POS: '\x1b[6n',

  // Reset
  RESET: '\x1bc',
  SOFT_RESET: '\x1b[!p',
} as const;

// ============================================================================
// Terminal Detection
// ============================================================================

function detectPlatform(): Platform {
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'darwin') return 'darwin';

  // Check for WSL
  if (process.platform === 'linux') {
    const isWSL = !!(
      process.env.WSL_DISTRO_NAME ||
      process.env.WSLENV ||
      process.env.WSL_INTEROP
    );
    if (isWSL) return 'wsl';
  }

  return 'linux';
}

function detectTerminalTypeFromEnv(env: NodeJS.ProcessEnv): TerminalType {
  const term = env.TERM || '';
  const termProgram = env.TERM_PROGRAM || '';
  const wtSession = env.WT_SESSION;
  const conEmuANSI = env.ConEmuANSI;

  // Windows Terminal
  if (wtSession) return 'windows-terminal';

  // VSCode integrated terminal
  if (termProgram === 'vscode' || env.VSCODE_INJECTION) return 'vscode';

  // iTerm2
  if (termProgram === 'iTerm.app' || env.ITERM_SESSION_ID) return 'iterm';

  // Hyper
  if (termProgram === 'Hyper') return 'hyper';

  // Apple Terminal
  if (termProgram === 'Apple_Terminal') return 'terminal-app';

  // Alacritty
  if (env.ALACRITTY_WINDOW_ID || term === 'alacritty') return 'alacritty';

  // Kitty
  if (env.KITTY_WINDOW_ID || term === 'xterm-kitty') return 'kitty';

  // WezTerm
  if (env.WEZTERM_PANE) return 'wezterm';

  // Konsole
  if (env.KONSOLE_VERSION) return 'konsole';

  // GNOME Terminal
  if (env.GNOME_TERMINAL_SCREEN || env.VTE_VERSION) return 'gnome-terminal';

  // Mintty (Git Bash, Cygwin)
  if (env.MSYSTEM || term === 'cygwin') return 'mintty';

  // ConPTY (Windows 10+)
  if (conEmuANSI === 'ON' || process.platform === 'win32') return 'conpty';

  // WSL
  if (detectPlatform() === 'wsl') return 'wsl';

  // Generic xterm
  if (term.includes('xterm') || term.includes('256color')) return 'xterm';

  return 'unknown';
}

function detectTerminalType(): TerminalType {
  return detectTerminalTypeFromEnv(process.env);
}

/**
 * Whether this runtime likely needs aggressive IME/input compatibility guards.
 * Heuristic: third-party terminal + SSH remote session.
 */
export function shouldEnableAggressiveInputCompat(env: NodeJS.ProcessEnv = process.env): boolean {
  const terminalType = detectTerminalTypeFromEnv(env);
  const isSshSession = Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);

  const isLikelyThirdParty = terminalType !== 'terminal-app';

  return isSshSession && isLikelyThirdParty;
}

function detectCapabilities(
  stdout: NodeJS.WriteStream,
  terminalType: TerminalType,
  platform: Platform,
): TerminalCapabilities {
  const env = process.env;
  const isTTY = stdout.isTTY ?? false;
  const isCI = !!(env.CI || env.CONTINUOUS_INTEGRATION || env.GITHUB_ACTIONS);

  // 基础能力检测
  const colorTerm = env.COLORTERM || '';
  const term = env.TERM || '';

  // True color 支持
  const trueColor = !!(
    colorTerm === 'truecolor' ||
    colorTerm === '24bit' ||
    term.includes('truecolor') ||
    term.includes('24bit') ||
    ['iterm', 'vscode', 'windows-terminal', 'alacritty', 'kitty', 'wezterm', 'hyper'].includes(terminalType)
  );

  // 256 色支持
  const color256 = trueColor || !!(
    term.includes('256color') ||
    colorTerm ||
    ['xterm', 'gnome-terminal', 'konsole', 'mintty', 'conpty'].includes(terminalType)
  );

  // Synchronized Update 支持 (DEC 2026)
  // 大多数现代终端都支持，但 Windows 原生 cmd 不支持
  const synchronizedUpdate = isTTY && !isCI && ![
    'terminal-app',  // macOS Terminal.app 不支持
    'mintty',        // 旧版 mintty 不支持
  ].includes(terminalType);

  // Alternate Screen 支持
  const alternateScreen = isTTY && !isCI;

  // Bracketed Paste 支持
  const bracketedPaste = isTTY && !isCI && terminalType !== 'unknown';

  // Unicode 支持
  const unicode = !!(
    env.LANG?.includes('UTF-8') ||
    env.LC_ALL?.includes('UTF-8') ||
    platform === 'darwin' ||
    ['iterm', 'vscode', 'windows-terminal', 'alacritty', 'kitty', 'wezterm'].includes(terminalType)
  );

  return {
    color256,
    trueColor,
    synchronizedUpdate,
    alternateScreen,
    bracketedPaste,
    mouse: isTTY && !isCI,
    unicode,
    terminalType,
    isCI,
    isTTY,
  };
}

// ============================================================================
// TerminalAdapter Class
// ============================================================================

export class TerminalAdapter extends EventEmitter {
  private stdout: NodeJS.WriteStream;
  private stdin: NodeJS.ReadStream;
  private options: TerminalAdapterOptions;

  public readonly platform: Platform;
  public readonly terminalType: TerminalType;
  public readonly capabilities: TerminalCapabilities;

  private _size: TerminalSize;
  private _inAltScreen = false;
  private _inSyncUpdate = false;
  private _resizePollTimer: NodeJS.Timeout | null = null;
  private _destroyed = false;

  constructor(options: TerminalAdapterOptions) {
    super();
    this.stdout = options.stdout;
    this.stdin = options.stdin;
    this.options = options;

    this.platform = detectPlatform();
    this.terminalType = detectTerminalType();
    this.capabilities = detectCapabilities(this.stdout, this.terminalType, this.platform);

    // 应用强制禁用选项
    if (options.forceDisable?.synchronizedUpdate) {
      this.capabilities.synchronizedUpdate = false;
    }
    if (options.forceDisable?.alternateScreen) {
      this.capabilities.alternateScreen = false;
    }
    if (options.forceDisable?.color) {
      this.capabilities.color256 = false;
      this.capabilities.trueColor = false;
    }

    // 初始化尺寸
    this._size = this.querySize();

    // 设置 resize 监听
    this.setupResizeListener();
  }

  // --------------------------------------------------------------------------
  // Size Management
  // --------------------------------------------------------------------------

  get size(): TerminalSize {
    return { ...this._size };
  }

  get columns(): number {
    return this._size.columns;
  }

  get rows(): number {
    return this._size.rows;
  }

  /**
   * 查询终端尺寸
   * 优先使用 stdout.columns/rows，fallback 到默认值
   */
  querySize(): TerminalSize {
    return {
      columns: this.stdout.columns || 80,
      rows: this.stdout.rows || 24,
    };
  }

  /**
   * 设置 resize 监听
   * - Unix: 监听 SIGWINCH + stdout resize 事件
   * - Windows/WSL: 轮询检测（因为信号不可靠）
   */
  private setupResizeListener(): void {
    // 方法 1: stdout resize 事件（最可靠）
    const handleResize = () => {
      const newSize = this.querySize();
      if (newSize.columns !== this._size.columns || newSize.rows !== this._size.rows) {
        const oldSize = this._size;
        this._size = newSize;
        this.emit('resize', newSize, oldSize);
      }
    };

    this.stdout.on('resize', handleResize);

    // 方法 2: SIGWINCH 信号（Unix only）
    if (process.platform !== 'win32') {
      process.on('SIGWINCH', handleResize);
    }

    // 方法 3: 轮询（Windows/WSL 必须，其他平台可选）
    const pollInterval = this.options.resizePollInterval ??
      (this.platform === 'win32' || this.platform === 'wsl' ? 500 : 0);

    if (pollInterval > 0) {
      this._resizePollTimer = setInterval(handleResize, pollInterval);
      this._resizePollTimer.unref(); // 🔥 不阻止进程退出
    }
  }

  // --------------------------------------------------------------------------
  // Output Methods
  // --------------------------------------------------------------------------

  /**
   * 写入原始数据
   */
  write(data: string): void {
    if (!this._destroyed) {
      this.stdout.write(data);
    }
  }

  /**
   * 写入一行（自动换行）
   */
  writeLine(data: string): void {
    this.write(data + '\n');
  }

  /**
   * 清除屏幕
   */
  clearScreen(): void {
    this.write(ANSI.ERASE_SCREEN + ANSI.CURSOR_HOME);
  }

  /**
   * 清除从光标到屏幕底部
   */
  clearScreenDown(): void {
    this.write(ANSI.ERASE_SCREEN_DOWN);
  }

  /**
   * 清除当前行
   */
  clearLine(): void {
    this.write(ANSI.ERASE_LINE + '\r');
  }

  /**
   * 清除 n 行（从当前位置向上）
   */
  clearLines(n: number): void {
    if (n <= 0) return;
    this.write(ANSI.eraseLines(n));
  }

  /**
   * 移动光标
   */
  moveCursor(x: number, y?: number): void {
    this.write(ANSI.cursorTo(x, y));
  }

  /**
   * 相对移动光标
   */
  moveCursorBy(dx: number, dy: number): void {
    this.write(ANSI.cursorMove(dx, dy));
  }

  /**
   * 隐藏光标
   */
  hideCursor(): void {
    this.write(ANSI.CURSOR_HIDE);
  }

  /**
   * 显示光标
   */
  showCursor(): void {
    this.write(ANSI.CURSOR_SHOW);
  }

  /**
   * 保存光标位置
   */
  saveCursor(): void {
    this.write(ANSI.CURSOR_SAVE);
  }

  /**
   * 恢复光标位置
   */
  restoreCursor(): void {
    this.write(ANSI.CURSOR_RESTORE);
  }

  // --------------------------------------------------------------------------
  // Synchronized Update (防闪烁)
  // --------------------------------------------------------------------------

  /**
   * 开始同步更新
   * 终端会缓冲所有输出，直到 endSyncUpdate() 被调用
   */
  beginSyncUpdate(): void {
    if (this.capabilities.synchronizedUpdate && !this._inSyncUpdate) {
      this.write(ANSI.SYNC_START);
      this._inSyncUpdate = true;
    }
  }

  /**
   * 结束同步更新
   * 终端会一次性渲染所有缓冲的输出
   */
  endSyncUpdate(): void {
    if (this._inSyncUpdate) {
      this.write(ANSI.SYNC_END);
      this._inSyncUpdate = false;
    }
  }

  /**
   * 在同步更新块中执行操作
   * 确保所有输出作为一帧渲染，避免闪烁
   */
  syncUpdate(fn: () => void): void {
    this.beginSyncUpdate();
    try {
      fn();
    } finally {
      this.endSyncUpdate();
    }
  }

  /**
   * 异步版本的 syncUpdate
   */
  async syncUpdateAsync(fn: () => Promise<void>): Promise<void> {
    this.beginSyncUpdate();
    try {
      await fn();
    } finally {
      this.endSyncUpdate();
    }
  }

  // --------------------------------------------------------------------------
  // Alternate Screen
  // --------------------------------------------------------------------------

  get inAltScreen(): boolean {
    return this._inAltScreen;
  }

  /**
   * 进入备用屏幕
   * 保存当前屏幕内容，切换到空白屏幕
   */
  enterAltScreen(): void {
    if (this.capabilities.alternateScreen && !this._inAltScreen) {
      this.write(ANSI.ALT_SCREEN_ENTER);
      this.write(ANSI.ALT_SCROLL_ENABLE);
      this._inAltScreen = true;
      this.emit('altscreen', true);
    }
  }

  /**
   * 离开备用屏幕
   * 恢复之前保存的屏幕内容
   */
  leaveAltScreen(): void {
    if (this._inAltScreen) {
      this.write(ANSI.ALT_SCROLL_DISABLE);
      this.write(ANSI.ALT_SCREEN_LEAVE);
      this._inAltScreen = false;
      this.emit('altscreen', false);
    }
  }

  /**
   * 在备用屏幕中执行操作
   */
  withAltScreen<T>(fn: () => T): T {
    const wasInAltScreen = this._inAltScreen;
    if (!wasInAltScreen) {
      this.enterAltScreen();
    }
    try {
      return fn();
    } finally {
      if (!wasInAltScreen) {
        this.leaveAltScreen();
      }
    }
  }

  /**
   * 异步版本
   */
  async withAltScreenAsync<T>(fn: () => Promise<T>): Promise<T> {
    const wasInAltScreen = this._inAltScreen;
    if (!wasInAltScreen) {
      this.enterAltScreen();
    }
    try {
      return await fn();
    } finally {
      if (!wasInAltScreen) {
        this.leaveAltScreen();
      }
    }
  }

  // --------------------------------------------------------------------------
  // Bracketed Paste
  // --------------------------------------------------------------------------

  enableBracketedPaste(): void {
    if (this.capabilities.bracketedPaste) {
      this.write(ANSI.BRACKETED_PASTE_ENABLE);
    }
  }

  disableBracketedPaste(): void {
    if (this.capabilities.bracketedPaste) {
      this.write(ANSI.BRACKETED_PASTE_DISABLE);
    }
  }

  // --------------------------------------------------------------------------
  // Mouse
  // --------------------------------------------------------------------------

  enableMouse(): void {
    if (this.capabilities.mouse) {
      this.write(ANSI.MOUSE_ENABLE);
    }
  }

  disableMouse(): void {
    if (this.capabilities.mouse) {
      this.write(ANSI.MOUSE_DISABLE);
    }
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  /**
   * 重置终端状态
   */
  reset(): void {
    if (this._inSyncUpdate) {
      this.endSyncUpdate();
    }
    if (this._inAltScreen) {
      this.leaveAltScreen();
    }
    this.showCursor();
    this.disableBracketedPaste();
    this.disableMouse();
  }

  /**
   * 销毁适配器
   */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;

    // 清理定时器
    if (this._resizePollTimer) {
      clearInterval(this._resizePollTimer);
      this._resizePollTimer = null;
    }

    // 重置终端状态
    this.reset();

    // 移除事件监听
    this.removeAllListeners();
  }
}

// ============================================================================
// Singleton Factory
// ============================================================================

let defaultAdapter: TerminalAdapter | null = null;

export function getTerminalAdapter(options?: Partial<TerminalAdapterOptions>): TerminalAdapter {
  if (!defaultAdapter) {
    defaultAdapter = new TerminalAdapter({
      stdout: process.stdout as NodeJS.WriteStream,
      stdin: process.stdin as NodeJS.ReadStream,
      ...options,
    });
  }
  return defaultAdapter;
}

export function resetTerminalAdapter(): void {
  if (defaultAdapter) {
    defaultAdapter.destroy();
    defaultAdapter = null;
  }
}
