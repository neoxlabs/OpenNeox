/**
 * Kitty Keyboard Protocol — 精确按键识别
 *
 * 启用 Kitty keyboard protocol 的 progressive enhancement：
 * - 检测终端是否支持 Kitty protocol（\x1b[?u query）
 * - 精确区分 Ctrl+I vs Tab, Ctrl+M vs Enter
 * - 支持修饰键组合的精确识别
 *
 * 参考: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
 */

// ==================== Types ====================

export interface KittyKeyEvent {
  /** Unicode codepoint of the key */
  codepoint: number;
  /** Key name (human-readable) */
  keyName: string;
  /** Modifier flags */
  modifiers: KittyModifiers;
  /** Event type */
  eventType: 'press' | 'repeat' | 'release';
  /** Associated text (if any) */
  text?: string;
}

export interface KittyModifiers {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  super: boolean;
  hyper: boolean;
  meta: boolean;
  capsLock: boolean;
  numLock: boolean;
}

// ==================== Detection ====================

let kittySupported: boolean | null = null;
let kittyEnabled = false;

/**
 * Query whether the terminal supports Kitty keyboard protocol.
 * Sends ESC[?u and waits for response.
 * Returns true if supported, false if not or timeout.
 */
export async function detectKittySupport(timeoutMs = 1000): Promise<boolean> {
  if (kittySupported !== null) return kittySupported;

  return new Promise<boolean>((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      kittySupported = false;
      resolve(false);
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      kittySupported = false;
      resolve(false);
    }, timeoutMs);

    const handler = (data: Buffer) => {
      const str = data.toString('utf-8');
      // Response format: ESC[?{flags}u
      if (str.includes('\x1b[?') && str.includes('u')) {
        cleanup();
        kittySupported = true;
        resolve(true);
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.off('data', handler);
    };

    process.stdin.on('data', handler);

    // Query terminal
    process.stdout.write('\x1b[?u');
  });
}

/**
 * Check if Kitty protocol is supported (cached result).
 * Must call detectKittySupport() first.
 */
export function isKittySupported(): boolean {
  return kittySupported === true;
}

// ==================== Enable/Disable ====================

/**
 * Enable Kitty keyboard protocol with progressive enhancement.
 *
 * Flags:
 * - 1: Disambiguate escape codes
 * - 2: Report event types (press/repeat/release)
 * - 4: Report alternate keys
 * - 8: Report all keys as escape codes
 * - 16: Report associated text
 *
 * We use flags 1|2|16 = 19 for a good balance.
 */
export function enableKittyProtocol(flags: number = 19): void {
  if (!kittySupported) return;
  process.stdout.write(`\x1b[>${flags}u`);
  kittyEnabled = true;
}

/**
 * Disable Kitty keyboard protocol (restore normal mode).
 */
export function disableKittyProtocol(): void {
  if (!kittyEnabled) return;
  process.stdout.write('\x1b[<u');
  kittyEnabled = false;
}

export function isKittyEnabled(): boolean {
  return kittyEnabled;
}

// ==================== Parsing ====================

/**
 * Parse a Kitty keyboard protocol CSI sequence.
 *
 * Format: CSI number ; modifiers [: event-type] [; text] u
 * or:     CSI number ; modifiers [: event-type] [; text] ~
 *
 * Returns null if the input is not a Kitty keyboard sequence.
 */
export function parseKittySequence(data: string): KittyKeyEvent | null {
  // Match: ESC [ number ; modifiers [:event] [; text] u
  const match = data.match(/\x1b\[(\d+)(?:;(\d+)(?::(\d+))?(?:;(.+))?)?u/);
  if (!match) return null;

  const codepoint = parseInt(match[1], 10);
  const modifierBits = match[2] ? parseInt(match[2], 10) - 1 : 0; // 1-indexed in protocol
  const eventType = match[3] ? parseEventType(parseInt(match[3], 10)) : 'press';
  const text = match[4];

  return {
    codepoint,
    keyName: codepointToKeyName(codepoint),
    modifiers: parseModifiers(modifierBits),
    eventType,
    text,
  };
}

// ==================== Helpers ====================

function parseModifiers(bits: number): KittyModifiers {
  return {
    shift: (bits & 1) !== 0,
    alt: (bits & 2) !== 0,
    ctrl: (bits & 4) !== 0,
    super: (bits & 8) !== 0,
    hyper: (bits & 16) !== 0,
    meta: (bits & 32) !== 0,
    capsLock: (bits & 64) !== 0,
    numLock: (bits & 128) !== 0,
  };
}

function parseEventType(type: number): 'press' | 'repeat' | 'release' {
  switch (type) {
    case 1: return 'press';
    case 2: return 'repeat';
    case 3: return 'release';
    default: return 'press';
  }
}

function codepointToKeyName(cp: number): string {
  // Special keys
  const SPECIAL_KEYS: Record<number, string> = {
    9: 'Tab',
    13: 'Enter',
    27: 'Escape',
    127: 'Backspace',
    57358: 'CapsLock',
    57359: 'ScrollLock',
    57360: 'NumLock',
    57361: 'PrintScreen',
    57362: 'Pause',
    57363: 'Menu',
    // Function keys
    57364: 'F1', 57365: 'F2', 57366: 'F3', 57367: 'F4',
    57368: 'F5', 57369: 'F6', 57370: 'F7', 57371: 'F8',
    57372: 'F9', 57373: 'F10', 57374: 'F11', 57375: 'F12',
    // Navigation
    57376: 'F13', 57377: 'F14', 57378: 'F15',
    57399: 'Insert', 57400: 'Delete',
    57401: 'Home', 57402: 'End',
    57403: 'PageUp', 57404: 'PageDown',
    57405: 'Left', 57406: 'Right', 57407: 'Up', 57408: 'Down',
  };

  if (SPECIAL_KEYS[cp]) return SPECIAL_KEYS[cp];

  // Regular character
  if (cp >= 32 && cp < 127) return String.fromCodePoint(cp);

  return `U+${cp.toString(16).padStart(4, '0')}`;
}

/**
 * Key discrimination — the main value of Kitty protocol.
 * With Kitty protocol, we can distinguish:
 * - Ctrl+I (codepoint 105 with ctrl modifier) vs Tab (codepoint 9)
 * - Ctrl+M (codepoint 109 with ctrl modifier) vs Enter (codepoint 13)
 * - Ctrl+[ (codepoint 91 with ctrl modifier) vs Escape (codepoint 27)
 */
export function isTabKey(event: KittyKeyEvent): boolean {
  return event.codepoint === 9 && !event.modifiers.ctrl;
}

export function isCtrlI(event: KittyKeyEvent): boolean {
  return event.codepoint === 105 && event.modifiers.ctrl;
}

export function isEnterKey(event: KittyKeyEvent): boolean {
  return event.codepoint === 13 && !event.modifiers.ctrl;
}

export function isCtrlM(event: KittyKeyEvent): boolean {
  return event.codepoint === 109 && event.modifiers.ctrl;
}

export function isEscapeKey(event: KittyKeyEvent): boolean {
  return event.codepoint === 27 && !event.modifiers.ctrl;
}
