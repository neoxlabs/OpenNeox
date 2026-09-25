/**
 * log-update.ts - 自研终端渲染层
 *
 * 完全替换第三方依赖 (ansi-escapes, cli-cursor)
 * 使用自研 TerminalAdapter + DiffRenderer
 *
 * 特性：
 * - 跨平台 ANSI 序列支持
 * - 智能差分渲染（只更新变化的行）
 * - CJK 宽字符正确处理
 * - Synchronized Update 防闪烁
 * - 自适应终端尺寸
 */

import { type Writable } from 'node:stream';
import {
  getTerminalAdapter,
  ANSI,
  type TerminalAdapter,
} from './terminal/index.js';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';

// ============================================================================
// Types
// ============================================================================

export type LogUpdate = {
  clear: () => void;
  done: () => void;
  sync: (str: string) => void;
  (str: string): void;
};

export type LogUpdateOptions = {
  showCursor?: boolean;
  incremental?: boolean;
};

// ============================================================================
// 自研标准渲染器
// ============================================================================

const createStandard = (
  stream: Writable,
  { showCursor = false }: LogUpdateOptions = {},
): LogUpdate => {
  const terminal = getTerminalAdapter({
    stdout: stream as NodeJS.WriteStream,
    stdin: process.stdin as NodeJS.ReadStream,
  });

  let previousLineCount = 0;
  let previousOutput = '';
  let hasHiddenCursor = false;

  const render = (str: string) => {
    // 隐藏光标
    if (!showCursor && !hasHiddenCursor) {
      terminal.hideCursor();
      hasHiddenCursor = true;
    }

    const output = str + '\n';
    if (output === previousOutput) {
      return;
    }

    // 使用 Synchronized Update 防闪烁
    const useSyncUpdate = terminal.capabilities.synchronizedUpdate;

    if (useSyncUpdate) {
      terminal.beginSyncUpdate();
    }

    try {
      // 清除之前的输出
      if (previousLineCount > 0) {
        terminal.write(ANSI.eraseLines(previousLineCount));
      }

      // 写入新输出
      terminal.write(output);
    } finally {
      if (useSyncUpdate) {
        terminal.endSyncUpdate();
      }
    }

    previousOutput = output;
    previousLineCount = output.split('\n').length;
  };

  render.clear = () => {
    if (previousLineCount > 0) {
      terminal.write(ANSI.eraseLines(previousLineCount));
    }
    previousOutput = '';
    previousLineCount = 0;
  };

  render.done = () => {
    previousOutput = '';
    previousLineCount = 0;

    if (!showCursor && hasHiddenCursor) {
      terminal.showCursor();
      hasHiddenCursor = false;
    }
  };

  render.sync = (str: string) => {
    const output = str + '\n';
    previousOutput = output;
    previousLineCount = output.split('\n').length;
  };

  return render;
};

// ============================================================================
// 自研增量差分渲染器 (智能只更新变化的行)
// ============================================================================

const createIncremental = (
  stream: Writable,
  { showCursor = false }: LogUpdateOptions = {},
): LogUpdate => {
  const terminal = getTerminalAdapter({
    stdout: stream as NodeJS.WriteStream,
    stdin: process.stdin as NodeJS.ReadStream,
  });

  let previousLines: string[] = [];
  let previousOutput = '';
  let hasHiddenCursor = false;

  /**
   * 计算字符串的可视宽度（正确处理 CJK 字符）
   */
  const getVisualWidth = (str: string): number => {
    return stringWidth(stripAnsi(str));
  };

  /**
   * 智能行级差分渲染
   */
  const render = (str: string) => {
    if (!showCursor && !hasHiddenCursor) {
      terminal.hideCursor();
      hasHiddenCursor = true;
    }

    const output = str + '\n';
    if (output === previousOutput) {
      return;
    }

    const previousCount = previousLines.length;
    const nextLines = output.split('\n');
    const nextCount = nextLines.length;
    const visibleCount = nextCount - 1;

    // 首次渲染或空内容，直接全量输出
    if (output === '\n' || previousOutput.length === 0) {
      const useSyncUpdate = terminal.capabilities.synchronizedUpdate;
      if (useSyncUpdate) terminal.beginSyncUpdate();

      try {
        if (previousCount > 0) {
          terminal.write(ANSI.eraseLines(previousCount));
        }
        terminal.write(output);
      } finally {
        if (useSyncUpdate) terminal.endSyncUpdate();
      }

      previousOutput = output;
      previousLines = nextLines;
      return;
    }

    // 🔥 智能差分渲染
    const buffer: string[] = [];
    const useSyncUpdate = terminal.capabilities.synchronizedUpdate;

    if (useSyncUpdate) {
      buffer.push(ANSI.SYNC_START);
    }

    // 处理行数变化
    if (nextCount < previousCount) {
      // 新内容行数更少，需要清除多余行
      buffer.push(ANSI.eraseLines(previousCount - nextCount + 1));
      buffer.push(ANSI.cursorUp(visibleCount));
    } else {
      // 移动到输出区域顶部
      if (previousCount > 1) {
        buffer.push(ANSI.cursorUp(previousCount - 1));
      }
    }

    // 逐行对比，只更新变化的行
    for (let i = 0; i < visibleCount; i++) {
      const prevLine = previousLines[i] ?? '';
      const nextLine = nextLines[i] ?? '';

      if (nextLine === prevLine) {
        // 行内容相同，跳过（只移动光标）
        buffer.push(ANSI.cursorDown(1) + '\r');
        continue;
      }

      // 行内容不同，更新这一行
      buffer.push('\r'); // 回到行首
      buffer.push(nextLine);

      // 如果新行比旧行短，清除剩余部分
      const prevWidth = getVisualWidth(prevLine);
      const nextWidth = getVisualWidth(nextLine);
      if (nextWidth < prevWidth) {
        buffer.push(ANSI.ERASE_LINE_END);
      }

      buffer.push('\n');
    }

    if (useSyncUpdate) {
      buffer.push(ANSI.SYNC_END);
    }

    terminal.write(buffer.join(''));

    previousOutput = output;
    previousLines = nextLines;
  };

  render.clear = () => {
    if (previousLines.length > 0) {
      terminal.write(ANSI.eraseLines(previousLines.length));
    }
    previousOutput = '';
    previousLines = [];
  };

  render.done = () => {
    previousOutput = '';
    previousLines = [];

    if (!showCursor && hasHiddenCursor) {
      terminal.showCursor();
      hasHiddenCursor = false;
    }
  };

  render.sync = (str: string) => {
    const output = str + '\n';
    previousOutput = output;
    previousLines = output.split('\n');
  };

  return render;
};

// ============================================================================
// Factory
// ============================================================================

const create = (
  stream: Writable,
  { showCursor = false, incremental = false }: LogUpdateOptions = {},
): LogUpdate => {
  if (incremental) {
    return createIncremental(stream, { showCursor });
  }
  return createStandard(stream, { showCursor });
};

const logUpdate = { create };
export default logUpdate;
