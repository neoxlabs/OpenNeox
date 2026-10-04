/**
 * DiffRenderer - 高级差分渲染器
 *
 * 核心特性：
 * - 双缓冲对比 + 智能行级 diff
 * - CJK 宽字符正确处理
 * - 自适应终端尺寸（resize 时智能重排）
 * - 滚动区域优化
 * - 虚拟滚动支持（大内容）
 * - 渲染统计和性能监控
 *
 * 参考 Codex CLI 的 custom_terminal.rs 实现
 */

import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { ANSI, type TerminalAdapter, type TerminalSize } from './TerminalAdapter.js';

// ============================================================================
// Types
// ============================================================================

export interface Cell {
  /** 字符内容（可能包含 ANSI 序列） */
  char: string;
  /** 显示宽度（CJK = 2, 普通 = 1） */
  width: number;
  /** 是否是宽字符的占位符（宽字符第二列） */
  placeholder: boolean;
}

export interface DiffCommand {
  type: 'move' | 'write' | 'erase-eol' | 'erase-lines' | 'scroll';
  row?: number;
  col?: number;
  content?: string;
  count?: number;
}

export interface RenderStats {
  /** 总行数 */
  totalLines: number;
  /** 变化的行数 */
  changedLines: number;
  /** 跳过的行数（未变化） */
  skippedLines: number;
  /** 输出的字节数 */
  bytesWritten: number;
  /** 渲染耗时 (ms) */
  renderTime: number;
  /** 是否使用了滚动优化 */
  usedScrollOptimization: boolean;
}

export interface AdaptiveLayoutOptions {
  /** 最小宽度 */
  minWidth?: number;
  /** 最大宽度 */
  maxWidth?: number;
  /** 是否启用自动换行 */
  wordWrap?: boolean;
  /** 是否启用滚动优化 */
  scrollOptimization?: boolean;
  /** 虚拟滚动阈值（超过此行数启用虚拟滚动） */
  virtualScrollThreshold?: number;
}

// ============================================================================
// Buffer Management
// ============================================================================

export class ScreenBuffer {
  private lines: string[] = [];
  private _width: number;
  private _height: number;
  private _dirty: Set<number> = new Set(); // 脏行标记

  constructor(width: number, height: number) {
    this._width = width;
    this._height = height;
    this.clear();
  }

  get width(): number {
    return this._width;
  }

  get height(): number {
    return this._height;
  }

  get lineCount(): number {
    return this.lines.filter(l => l !== '').length;
  }

  get dirtyLines(): number[] {
    return Array.from(this._dirty).sort((a, b) => a - b);
  }

  /**
   * 清空缓冲区
   */
  clear(): void {
    this.lines = new Array(this._height).fill('');
    this._dirty.clear();
  }

  /**
   * 标记所有行为脏
   */
  markAllDirty(): void {
    for (let i = 0; i < this._height; i++) {
      this._dirty.add(i);
    }
  }

  /**
   * 清除脏标记
   */
  clearDirty(): void {
    this._dirty.clear();
  }

  /**
   * 调整缓冲区大小
   */
  resize(width: number, height: number): void {
    const oldWidth = this._width;
    const oldHeight = this._height;

    this._width = width;
    this._height = height;

    // 调整行数
    if (this.lines.length < height) {
      this.lines.push(...new Array(height - this.lines.length).fill(''));
    } else if (this.lines.length > height) {
      this.lines.length = height;
    }

    // 宽度变化时，标记所有行为脏（需要重新换行）
    if (width !== oldWidth) {
      this.markAllDirty();
    }
  }

  /**
   * 设置某一行的内容
   */
  setLine(row: number, content: string): void {
    if (row >= 0 && row < this._height) {
      if (this.lines[row] !== content) {
        this.lines[row] = content;
        this._dirty.add(row);
      }
    }
  }

  /**
   * 获取某一行的内容
   */
  getLine(row: number): string {
    return this.lines[row] ?? '';
  }

  /**
   * 获取所有行
   */
  getLines(): string[] {
    return [...this.lines];
  }

  /**
   * 从字符串设置整个缓冲区
   */
  setFromString(content: string): void {
    const lines = content.split('\n');
    for (let i = 0; i < this._height; i++) {
      const newLine = lines[i] ?? '';
      if (this.lines[i] !== newLine) {
        this.lines[i] = newLine;
        this._dirty.add(i);
      }
    }
  }

  /**
   * 滚动缓冲区内容
   * @param delta 正数向上滚动，负数向下滚动
   */
  scroll(delta: number): void {
    if (delta === 0) return;

    if (delta > 0) {
      // 向上滚动：删除顶部行，底部添加空行
      this.lines.splice(0, delta);
      this.lines.push(...new Array(delta).fill(''));
    } else {
      // 向下滚动：删除底部行，顶部添加空行
      this.lines.splice(delta);
      this.lines.unshift(...new Array(-delta).fill(''));
    }

    this.markAllDirty();
  }

  /**
   * 克隆缓冲区
   */
  clone(): ScreenBuffer {
    const buffer = new ScreenBuffer(this._width, this._height);
    buffer.lines = [...this.lines];
    buffer._dirty = new Set(this._dirty);
    return buffer;
  }
}

// ============================================================================
// Diff Algorithm - 增强版
// ============================================================================

/**
 * 计算两行之间的差异起始位置
 * 返回需要更新的起始列，如果完全相同返回 -1
 */
function findLineDiffStart(oldLine: string, newLine: string): number {
  // 完全相同（包括 ANSI 序列）
  if (oldLine === newLine) return -1;

  const oldStripped = stripAnsi(oldLine);
  const newStripped = stripAnsi(newLine);

  // 找到第一个不同的字符位置
  const minLen = Math.min(oldStripped.length, newStripped.length);
  for (let i = 0; i < minLen; i++) {
    if (oldStripped[i] !== newStripped[i]) {
      return i;
    }
  }

  // 长度不同
  return minLen;
}

/**
 * 计算两行之间的差异结束位置（从末尾开始）
 * 用于优化只有中间部分变化的情况
 */
function findLineDiffEnd(oldLine: string, newLine: string): number {
  const oldStripped = stripAnsi(oldLine);
  const newStripped = stripAnsi(newLine);

  const oldLen = oldStripped.length;
  const newLen = newStripped.length;
  const minLen = Math.min(oldLen, newLen);

  for (let i = 0; i < minLen; i++) {
    if (oldStripped[oldLen - 1 - i] !== newStripped[newLen - 1 - i]) {
      return i;
    }
  }

  return minLen;
}

/**
 * 检测是否是滚动操作
 * 返回滚动的行数（正数向上，负数向下），0 表示不是滚动
 */
function detectScroll(oldLines: string[], newLines: string[]): number {
  const oldLen = oldLines.filter(l => l !== '').length;
  const newLen = newLines.filter(l => l !== '').length;

  // 行数差异太大，不是简单滚动
  if (Math.abs(oldLen - newLen) > 5) return 0;

  // 检测向上滚动（新内容在底部）
  for (let delta = 1; delta <= Math.min(5, oldLen); delta++) {
    let match = true;
    for (let i = 0; i < oldLen - delta && i < newLen; i++) {
      if (oldLines[i + delta] !== newLines[i]) {
        match = false;
        break;
      }
    }
    if (match) return delta;
  }

  // 检测向下滚动（新内容在顶部）
  for (let delta = 1; delta <= Math.min(5, oldLen); delta++) {
    let match = true;
    for (let i = delta; i < oldLen && i < newLen; i++) {
      if (oldLines[i - delta] !== newLines[i]) {
        match = false;
        break;
      }
    }
    if (match) return -delta;
  }

  return 0;
}

/**
 * 计算可视宽度（考虑 CJK 字符）
 */
function getVisualWidth(str: string): number {
  return stringWidth(stripAnsi(str));
}

/**
 * 按可视宽度截取字符串
 */
function sliceByWidth(str: string, start: number, end?: number): string {
  let result = '';
  let currentWidth = 0;
  let inAnsi = false;
  let ansiBuffer = '';

  for (let i = 0; i < str.length; i++) {
    const char = str[i]!;

    // 处理 ANSI 序列
    if (char === '\x1b') {
      inAnsi = true;
      ansiBuffer = char;
      continue;
    }

    if (inAnsi) {
      ansiBuffer += char;
      if (char === 'm') {
        inAnsi = false;
        // 如果在范围内，保留 ANSI 序列
        if (currentWidth >= start && (end === undefined || currentWidth < end)) {
          result += ansiBuffer;
        }
        ansiBuffer = '';
      }
      continue;
    }

    const charWidth = stringWidth(char);
    const nextWidth = currentWidth + charWidth;

    if (currentWidth >= start && (end === undefined || currentWidth < end)) {
      result += char;
    }

    currentWidth = nextWidth;

    if (end !== undefined && currentWidth >= end) {
      break;
    }
  }

  return result;
}

/**
 * 自动换行处理
 */
function wrapLine(line: string, width: number): string[] {
  if (width <= 0) return [line];

  const visualWidth = getVisualWidth(line);
  if (visualWidth <= width) return [line];

  const result: string[] = [];
  let currentLine = '';
  let currentWidth = 0;
  let inAnsi = false;
  let ansiBuffer = '';

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;

    if (char === '\x1b') {
      inAnsi = true;
      ansiBuffer = char;
      continue;
    }

    if (inAnsi) {
      ansiBuffer += char;
      if (char === 'm') {
        inAnsi = false;
        currentLine += ansiBuffer;
        ansiBuffer = '';
      }
      continue;
    }

    const charWidth = stringWidth(char);

    if (currentWidth + charWidth > width) {
      result.push(currentLine);
      currentLine = char;
      currentWidth = charWidth;
    } else {
      currentLine += char;
      currentWidth += charWidth;
    }
  }

  if (currentLine) {
    result.push(currentLine);
  }

  return result;
}

// ============================================================================
// DiffRenderer Class - 增强版
// ============================================================================

export class DiffRenderer {
  private terminal: TerminalAdapter;
  private prevBuffer: ScreenBuffer;
  private currBuffer: ScreenBuffer;
  private _lastStats: RenderStats | null = null;
  private options: AdaptiveLayoutOptions;

  // 自适应布局状态
  private _lastSize: TerminalSize;
  private _resizeCallback?: () => void;

  constructor(terminal: TerminalAdapter, options: AdaptiveLayoutOptions = {}) {
    this.terminal = terminal;
    this.options = {
      minWidth: 40,
      maxWidth: 200,
      wordWrap: true,
      scrollOptimization: true,
      virtualScrollThreshold: 1000,
      ...options,
    };

    const { columns, rows } = terminal.size;
    this._lastSize = { columns, rows };
    this.prevBuffer = new ScreenBuffer(columns, rows);
    this.currBuffer = new ScreenBuffer(columns, rows);

    // 监听 resize 事件
    terminal.on('resize', this.handleResize.bind(this));
  }

  get lastStats(): RenderStats | null {
    return this._lastStats;
  }

  get size(): TerminalSize {
    return this._lastSize;
  }

  /**
   * 设置 resize 回调
   */
  onResize(callback: () => void): void {
    this._resizeCallback = callback;
  }

  /**
   * 处理终端尺寸变化
   */
  private handleResize(newSize: TerminalSize): void {
    const oldSize = this._lastSize;
    this._lastSize = newSize;

    // 调整缓冲区
    this.resize(newSize.columns, newSize.rows);

    // 通知外部
    this._resizeCallback?.();

    if (process.env.NEOX_INK_DEBUG === '1') {
      process.stderr.write(
        `[DiffRenderer] Resize: ${oldSize.columns}x${oldSize.rows} → ${newSize.columns}x${newSize.rows}\n`
      );
    }
  }

  /**
   * 调整缓冲区大小
   */
  resize(width: number, height: number): void {
    // 应用宽度限制
    const effectiveWidth = Math.max(
      this.options.minWidth ?? 40,
      Math.min(width, this.options.maxWidth ?? 200)
    );

    this.prevBuffer.resize(effectiveWidth, height);
    this.currBuffer.resize(effectiveWidth, height);
  }

  /**
   * 清空缓冲区
   */
  clear(): void {
    this.prevBuffer.clear();
    this.currBuffer.clear();
  }

  /**
   * 渲染新内容（智能差分更新）
   */
  render(content: string): RenderStats {
    const startTime = performance.now();

    // 更新当前缓冲区
    this.currBuffer.setFromString(content);

    // 检测滚动优化
    let usedScrollOptimization = false;
    if (this.options.scrollOptimization) {
      const scrollDelta = detectScroll(
        this.prevBuffer.getLines(),
        this.currBuffer.getLines()
      );

      if (scrollDelta !== 0) {
        usedScrollOptimization = true;
        this.renderWithScroll(scrollDelta);
      }
    }

    // 计算差异并生成命令
    const commands = usedScrollOptimization ? [] : this.computeDiff();

    // 执行渲染
    const bytesWritten = usedScrollOptimization ? 0 : this.executeCommands(commands);

    // 统计
    const changedLines = commands.filter(c => c.type === 'write').length;
    const totalLines = this.currBuffer.lineCount;

    // 交换缓冲区
    const temp = this.prevBuffer;
    this.prevBuffer = this.currBuffer;
    this.currBuffer = temp;
    this.currBuffer.clearDirty();

    const stats: RenderStats = {
      totalLines,
      changedLines,
      skippedLines: totalLines - changedLines,
      bytesWritten,
      renderTime: performance.now() - startTime,
      usedScrollOptimization,
    };

    this._lastStats = stats;
    return stats;
  }

  /**
   * 使用滚动优化渲染
   */
  private renderWithScroll(delta: number): void {
    this.terminal.syncUpdate(() => {
      if (delta > 0) {
        // 向上滚动
        this.terminal.write(ANSI.scrollUp(delta));
        // 更新底部新行
        const lines = this.currBuffer.getLines();
        const startRow = lines.length - delta;
        this.terminal.moveCursor(0, startRow);
        for (let i = startRow; i < lines.length; i++) {
          this.terminal.write(ANSI.ERASE_LINE + lines[i]! + '\n');
        }
      } else {
        // 向下滚动
        this.terminal.write(ANSI.scrollDown(-delta));
        // 更新顶部新行
        this.terminal.moveCursor(0, 0);
        const lines = this.currBuffer.getLines();
        for (let i = 0; i < -delta; i++) {
          this.terminal.write(ANSI.ERASE_LINE + lines[i]! + '\n');
        }
      }
    });
  }

  /**
   * 强制全量渲染（不做 diff）
   */
  renderFull(content: string): RenderStats {
    const startTime = performance.now();

    this.currBuffer.setFromString(content);

    // 使用同步更新防闪烁
    this.terminal.syncUpdate(() => {
      this.terminal.moveCursor(0, 0);
      this.terminal.write(content);
      this.terminal.clearScreenDown();
    });

    // 交换缓冲区
    const temp = this.prevBuffer;
    this.prevBuffer = this.currBuffer;
    this.currBuffer = temp;

    const stats: RenderStats = {
      totalLines: this.currBuffer.lineCount,
      changedLines: this.currBuffer.lineCount,
      skippedLines: 0,
      bytesWritten: Buffer.byteLength(content),
      renderTime: performance.now() - startTime,
      usedScrollOptimization: false,
    };

    this._lastStats = stats;
    return stats;
  }

  /**
   * 计算两个缓冲区之间的差异
   */
  private computeDiff(): DiffCommand[] {
    const commands: DiffCommand[] = [];
    const height = this.currBuffer.height;

    let lastRow = -1;

    for (let row = 0; row < height; row++) {
      const oldLine = this.prevBuffer.getLine(row);
      const newLine = this.currBuffer.getLine(row);

      // 完全相同，跳过
      if (oldLine === newLine) continue;

      const diffStart = findLineDiffStart(oldLine, newLine);
      if (diffStart === -1) continue;

      // 需要移动光标
      if (row !== lastRow + 1 || diffStart > 0) {
        commands.push({
          type: 'move',
          row,
          col: diffStart,
        });
      }

      // 获取需要写入的内容
      const newContent = sliceByWidth(newLine, diffStart);
      const oldWidth = getVisualWidth(oldLine);
      const newWidth = getVisualWidth(newLine);

      commands.push({
        type: 'write',
        content: newContent,
      });

      // 如果新行比旧行短，需要清除剩余部分
      if (newWidth < oldWidth) {
        commands.push({ type: 'erase-eol' });
      }

      lastRow = row;
    }

    // 如果新内容行数少于旧内容，清除多余行
    const newLineCount = this.currBuffer.lineCount;
    const oldLineCount = this.prevBuffer.lineCount;

    if (newLineCount < oldLineCount) {
      commands.push({
        type: 'move',
        row: newLineCount,
        col: 0,
      });
      commands.push({
        type: 'erase-lines',
        count: oldLineCount - newLineCount,
      });
    }

    return commands;
  }

  /**
   * 执行渲染命令
   */
  private executeCommands(commands: DiffCommand[]): number {
    if (commands.length === 0) return 0;

    let output = '';

    // 使用同步更新包裹所有输出
    this.terminal.beginSyncUpdate();
    try {
      for (const cmd of commands) {
        switch (cmd.type) {
          case 'move':
            output += ANSI.cursorTo(cmd.col ?? 0, cmd.row);
            break;
          case 'write':
            output += cmd.content ?? '';
            break;
          case 'erase-eol':
            output += ANSI.ERASE_LINE_END;
            break;
          case 'erase-lines':
            for (let i = 0; i < (cmd.count ?? 0); i++) {
              output += ANSI.ERASE_LINE + '\n';
            }
            break;
          case 'scroll':
            if ((cmd.count ?? 0) > 0) {
              output += ANSI.scrollUp(cmd.count!);
            } else {
              output += ANSI.scrollDown(-(cmd.count ?? 0));
            }
            break;
        }
      }

      this.terminal.write(output);
    } finally {
      this.terminal.endSyncUpdate();
    }

    return Buffer.byteLength(output);
  }
}

// ============================================================================
// Incremental Line Renderer (for append-only scenarios)
// ============================================================================

/**
 * 增量行渲染器
 * 适用于日志/聊天等只追加内容的场景
 */
export class IncrementalRenderer {
  private terminal: TerminalAdapter;
  private renderedLineCount = 0;
  private bottomReserved = 0;
  private _scrollbackBuffer: string[] = [];
  private _maxScrollback = 10000;

  constructor(terminal: TerminalAdapter, bottomReserved = 0) {
    this.terminal = terminal;
    this.bottomReserved = bottomReserved;
  }

  /**
   * 设置底部保留行数
   */
  setBottomReserved(lines: number): void {
    this.bottomReserved = lines;
  }

  /**
   * 设置最大滚动缓冲区大小
   */
  setMaxScrollback(lines: number): void {
    this._maxScrollback = lines;
  }

  /**
   * 追加新行
   */
  appendLines(lines: string[]): void {
    if (lines.length === 0) return;

    // 添加到滚动缓冲区
    this._scrollbackBuffer.push(...lines);
    if (this._scrollbackBuffer.length > this._maxScrollback) {
      this._scrollbackBuffer.splice(0, this._scrollbackBuffer.length - this._maxScrollback);
    }

    this.terminal.syncUpdate(() => {
      // 如果有底部保留区域，先清除它
      if (this.bottomReserved > 0) {
        this.terminal.saveCursor();
        this.terminal.moveCursor(0, this.terminal.rows - this.bottomReserved);
        this.terminal.clearScreenDown();
        this.terminal.restoreCursor();
      }

      // 输出新行
      for (const line of lines) {
        this.terminal.writeLine(line);
        this.renderedLineCount++;
      }
    });
  }

  /**
   * 更新底部区域（状态栏/输入框）
   */
  updateBottom(content: string): void {
    if (this.bottomReserved === 0) return;

    this.terminal.syncUpdate(() => {
      this.terminal.saveCursor();

      const bottomStart = this.terminal.rows - this.bottomReserved;
      this.terminal.moveCursor(0, bottomStart);

      this.terminal.clearScreenDown();
      this.terminal.write(content);

      this.terminal.restoreCursor();
    });
  }

  /**
   * 获取滚动缓冲区内容
   */
  getScrollback(): string[] {
    return [...this._scrollbackBuffer];
  }

  /**
   * 重置
   */
  reset(): void {
    this.renderedLineCount = 0;
    this._scrollbackBuffer = [];
  }
}

// ============================================================================
// Virtual Scroll Renderer (for very large content)
// ============================================================================

/**
 * 虚拟滚动渲染器
 * 适用于超大内容（如日志文件）
 */
export class VirtualScrollRenderer {
  private terminal: TerminalAdapter;
  private _allLines: string[] = [];
  private _viewportStart = 0;
  private _viewportHeight: number;

  constructor(terminal: TerminalAdapter) {
    this.terminal = terminal;
    this._viewportHeight = terminal.rows - 1; // 留一行给状态栏

    terminal.on('resize', (size: TerminalSize) => {
      this._viewportHeight = size.rows - 1;
      this.render();
    });
  }

  /**
   * 设置全部内容
   */
  setContent(lines: string[]): void {
    this._allLines = lines;
    this._viewportStart = Math.max(0, lines.length - this._viewportHeight);
    this.render();
  }

  /**
   * 追加内容
   */
  appendLines(lines: string[]): void {
    const wasAtBottom = this._viewportStart >= this._allLines.length - this._viewportHeight;
    this._allLines.push(...lines);

    // 如果之前在底部，保持在底部
    if (wasAtBottom) {
      this._viewportStart = Math.max(0, this._allLines.length - this._viewportHeight);
    }

    this.render();
  }

  /**
   * 滚动
   */
  scroll(delta: number): void {
    const maxStart = Math.max(0, this._allLines.length - this._viewportHeight);
    this._viewportStart = Math.max(0, Math.min(maxStart, this._viewportStart + delta));
    this.render();
  }

  /**
   * 滚动到顶部
   */
  scrollToTop(): void {
    this._viewportStart = 0;
    this.render();
  }

  /**
   * 滚动到底部
   */
  scrollToBottom(): void {
    this._viewportStart = Math.max(0, this._allLines.length - this._viewportHeight);
    this.render();
  }

  /**
   * 渲染当前视口
   */
  private render(): void {
    const visibleLines = this._allLines.slice(
      this._viewportStart,
      this._viewportStart + this._viewportHeight
    );

    this.terminal.syncUpdate(() => {
      this.terminal.moveCursor(0, 0);

      for (let i = 0; i < this._viewportHeight; i++) {
        this.terminal.write(ANSI.ERASE_LINE);
        if (visibleLines[i]) {
          this.terminal.write(visibleLines[i]);
        }
        this.terminal.write('\n');
      }

      // 状态栏
      const total = this._allLines.length;
      const current = this._viewportStart + this._viewportHeight;
      const percent = total > 0 ? Math.round((current / total) * 100) : 100;
      this.terminal.write(ANSI.ERASE_LINE);
      this.terminal.write(`\x1b[7m Lines ${this._viewportStart + 1}-${current} of ${total} (${percent}%) \x1b[0m`);
    });
  }

  /**
   * 获取当前视口信息
   */
  getViewportInfo(): { start: number; end: number; total: number } {
    return {
      start: this._viewportStart,
      end: Math.min(this._viewportStart + this._viewportHeight, this._allLines.length),
      total: this._allLines.length,
    };
  }
}
