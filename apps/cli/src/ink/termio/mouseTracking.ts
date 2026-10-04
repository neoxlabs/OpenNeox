/**
 * Mouse Tracking — SGR Extended Mouse Mode
 *
 * 支持：
 * - SGR mouse mode (mode 1006) — 支持大终端坐标
 * - 文本选择：鼠标拖拽选中
 * - 双击选词、三击选行
 * - 滚轮滚动 timeline
 */

// ==================== Types ====================

export type MouseButton = 'left' | 'middle' | 'right' | 'scroll_up' | 'scroll_down' | 'none';
export type MouseEventType = 'press' | 'release' | 'move' | 'scroll';

export interface MouseEvent {
  button: MouseButton;
  type: MouseEventType;
  x: number;
  y: number;
  modifiers: {
    shift: boolean;
    alt: boolean;
    ctrl: boolean;
  };
}

export type MouseEventHandler = (event: MouseEvent) => void;

// ==================== Selection ====================

export interface TextSelection {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

// ==================== Mouse Mode Control ====================

export type MouseModeLevel = 'off' | 'button' | 'any_event' | 'sgr';

/**
 * Enable SGR extended mouse mode.
 * Levels:
 * - button: Track button press/release only (mode 1000)
 * - any_event: Track all mouse events including motion (mode 1003)
 * - sgr: Enable SGR format for large coordinates (mode 1006)
 */
export function enableMouseMode(level: MouseModeLevel = 'sgr'): void {
  switch (level) {
    case 'button':
      process.stdout.write('\x1b[?1000h');
      break;
    case 'any_event':
      process.stdout.write('\x1b[?1000h');
      process.stdout.write('\x1b[?1003h');
      break;
    case 'sgr':
      process.stdout.write('\x1b[?1000h');
      process.stdout.write('\x1b[?1006h');
      break;
    case 'off':
      disableMouseMode();
      break;
  }
}

export function disableMouseMode(): void {
  process.stdout.write('\x1b[?1006l');
  process.stdout.write('\x1b[?1003l');
  process.stdout.write('\x1b[?1000l');
}

// ==================== Parser ====================

/**
 * Parse SGR mouse sequence.
 * Format: ESC [ < button ; x ; y [Mm]
 * M = press, m = release
 */
export function parseSGRMouseEvent(data: string): MouseEvent | null {
  const match = data.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (!match) return null;

  const rawButton = parseInt(match[1], 10);
  const x = parseInt(match[2], 10);
  const y = parseInt(match[3], 10);
  const isRelease = match[4] === 'm';

  // Decode button and modifiers
  const baseButton = rawButton & 3;
  const shift = (rawButton & 4) !== 0;
  const alt = (rawButton & 8) !== 0;
  const ctrl = (rawButton & 16) !== 0;
  const isMotion = (rawButton & 32) !== 0;
  const isScroll = (rawButton & 64) !== 0;

  let button: MouseButton;
  let type: MouseEventType;

  if (isScroll) {
    button = (rawButton & 1) ? 'scroll_down' : 'scroll_up';
    type = 'scroll';
  } else if (isMotion) {
    button = baseButton === 0 ? 'left' : baseButton === 1 ? 'middle' : baseButton === 2 ? 'right' : 'none';
    type = 'move';
  } else {
    button = baseButton === 0 ? 'left' : baseButton === 1 ? 'middle' : baseButton === 2 ? 'right' : 'none';
    type = isRelease ? 'release' : 'press';
  }

  return {
    button,
    type,
    x,
    y,
    modifiers: { shift, alt, ctrl },
  };
}

// ==================== Click Detection ====================

export interface ClickDetectorConfig {
  /** Max time between clicks for double/triple click (ms) */
  multiClickWindowMs: number;
  /** Max pixel distance between clicks for multi-click */
  multiClickDistance: number;
}

const DEFAULT_CLICK_CONFIG: ClickDetectorConfig = {
  multiClickWindowMs: 400,
  multiClickDistance: 2,
};

export class ClickDetector {
  private config: ClickDetectorConfig;
  private lastClickTime = 0;
  private lastClickX = -1;
  private lastClickY = -1;
  private clickCount = 0;

  constructor(config?: Partial<ClickDetectorConfig>) {
    this.config = { ...DEFAULT_CLICK_CONFIG, ...config };
  }

  /**
   * Process a mouse press event and return click count.
   * 1 = single click, 2 = double click, 3 = triple click
   */
  processPress(x: number, y: number): number {
    const now = Date.now();
    const timeDiff = now - this.lastClickTime;
    const xDiff = Math.abs(x - this.lastClickX);
    const yDiff = Math.abs(y - this.lastClickY);

    if (
      timeDiff < this.config.multiClickWindowMs &&
      xDiff <= this.config.multiClickDistance &&
      yDiff <= this.config.multiClickDistance
    ) {
      // Multi-click
      this.clickCount = Math.min(this.clickCount + 1, 3);
    } else {
      // New click
      this.clickCount = 1;
    }

    this.lastClickTime = now;
    this.lastClickX = x;
    this.lastClickY = y;

    return this.clickCount;
  }

  reset(): void {
    this.clickCount = 0;
  }
}

// ==================== Mouse Tracker ====================

/**
 * High-level mouse tracking manager.
 * Handles raw stdin data, parses events, and dispatches to handlers.
 */
export class MouseTracker {
  private handler: MouseEventHandler | null = null;
  private stdinHandler: ((data: Buffer) => void) | null = null;
  private clickDetector = new ClickDetector();
  private active = false;
  private selection: TextSelection | null = null;
  private selecting = false;

  /** Start tracking mouse events */
  start(level: MouseModeLevel = 'sgr', handler?: MouseEventHandler): void {
    if (this.active) return;

    enableMouseMode(level);
    this.handler = handler || null;
    this.active = true;

    this.stdinHandler = (data: Buffer) => {
      const str = data.toString('utf-8');
      const event = parseSGRMouseEvent(str);
      if (event) {
        this.handleEvent(event);
      }
    };

    if (process.stdin.isTTY) {
      process.stdin.on('data', this.stdinHandler);
    }
  }

  /** Stop tracking mouse events */
  stop(): void {
    if (!this.active) return;

    disableMouseMode();
    this.active = false;

    if (this.stdinHandler && process.stdin.isTTY) {
      process.stdin.off('data', this.stdinHandler);
    }
    this.stdinHandler = null;
  }

  /** Set the event handler */
  setHandler(handler: MouseEventHandler): void {
    this.handler = handler;
  }

  /** Get current text selection */
  getSelection(): TextSelection | null {
    return this.selection;
  }

  isActive(): boolean {
    return this.active;
  }

  private handleEvent(event: MouseEvent): void {
    // Track selection
    if (event.button === 'left' && event.type === 'press') {
      const clickCount = this.clickDetector.processPress(event.x, event.y);

      if (clickCount === 2) {
        // Double click — word selection (handled by caller)
      } else if (clickCount === 3) {
        // Triple click — line selection (handled by caller)
      } else {
        // Start selection
        this.selecting = true;
        this.selection = {
          startX: event.x,
          startY: event.y,
          endX: event.x,
          endY: event.y,
        };
      }
    } else if (event.type === 'move' && this.selecting && this.selection) {
      // Extend selection
      this.selection.endX = event.x;
      this.selection.endY = event.y;
    } else if (event.button === 'left' && event.type === 'release') {
      this.selecting = false;
    }

    // Dispatch to handler
    this.handler?.(event);
  }
}

// ==================== Singleton ====================

let globalTracker: MouseTracker | null = null;

export function getGlobalMouseTracker(): MouseTracker {
  if (!globalTracker) {
    globalTracker = new MouseTracker();
  }
  return globalTracker;
}
