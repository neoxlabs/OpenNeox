
import { EventEmitter } from 'node:events';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import wrapAnsi from 'wrap-ansi';
import { cliLogger } from '@neoxlabs/core/platform/cliLogger.js';
import {
  TerminalAdapter,
  getTerminalAdapter,
  ANSI,
  shouldEnableAggressiveInputCompat,
  type TerminalSize,
} from './TerminalAdapter.js';

const AGGRESSIVE_INPUT_COMPAT = shouldEnableAggressiveInputCompat();
const INK_RENDER_DEBUG = process.env.INK_RENDER_DEBUG === '1' || process.env.CLI_DEBUG === '1';
const INK_RENDER_LOG_SAMPLE = Math.max(1, Number.parseInt(process.env.INK_RENDER_LOG_SAMPLE ?? '1', 10) || 1);

// ============================================================================
// Types
// ============================================================================

export interface FullScreenOptions {
  /** 是否使用 Alternate Screen（推荐开启） */
  alternateScreen?: boolean;
  /** 是否隐藏光标 */
  hideCursor?: boolean;
  /** 是否启用鼠标支持 */
  mouse?: boolean;
  /** 底部固定区域高度（如输入框） */
  bottomFixed?: number;
  /** 顶部固定区域高度（如标题栏） */
  topFixed?: number;
}

export interface RenderFrame {
  /** 帧内容（按行） */
  lines: string[];
  /** 光标位置（可选） */
  cursor?: { x: number; y: number };
}

export interface FrameStats {
  /** 总行数 */
  totalLines: number;
  /** 实际更新的行数 */
  updatedLines: number;
  /** 跳过的行数（未变化） */
  skippedLines: number;
  /** 渲染耗时 (ms) */
  renderTime: number;
  /** 是否是全量重绘 */
  fullRedraw: boolean;
}

// ============================================================================
// Cell-based Buffer（字符级缓冲区）
// ============================================================================

interface Cell {
  char: string;
  width: number;  // 显示宽度（CJK=2, 普通=1）
  style: string;  // ANSI 样式前缀
}

class CellBuffer {
  private cells: Cell[][] = [];
  private _width: number;
  private _height: number;

  constructor(width: number, height: number) {
    this._width = width;
    this._height = height;
    this.clear();
  }

  get width() { return this._width; }
  get height() { return this._height; }

  clear() {
    this.cells = [];
    for (let y = 0; y < this._height; y++) {
      const row: Cell[] = [];
      for (let x = 0; x < this._width; x++) {
        row.push({ char: ' ', width: 1, style: '' });
      }
      this.cells.push(row);
    }
  }

  resize(width: number, height: number) {
    this._width = width;
    this._height = height;
    this.clear();
  }

  getCell(x: number, y: number): Cell | null {
    if (y < 0 || y >= this._height || x < 0 || x >= this._width) {
      return null;
    }
    return this.cells[y]![x]!;
  }

  setCell(x: number, y: number, cell: Cell) {
    if (y < 0 || y >= this._height || x < 0 || x >= this._width) {
      return;
    }
    this.cells[y]![x] = cell;
  }

  /**
   * 从字符串行设置缓冲区内容
   */
  setFromLines(lines: string[]) {
    this.clear();

    for (let y = 0; y < Math.min(lines.length, this._height); y++) {
      const line = lines[y] || '';
      let x = 0;
      let currentStyle = '';

      // 解析 ANSI 序列和字符
      let i = 0;
      while (i < line.length && x < this._width) {
        // 检测 ANSI 转义序列 (ESC [)
        if (line[i] === '\x1b') {
          // CSI sequence: ESC [ <params> <final byte>
          if (line[i + 1] === '[') {
            let j = i + 2;
            // 参数字节范围: 0x30-0x3F (数字、分号、问号等)
            while (j < line.length && line.charCodeAt(j) >= 0x30 && line.charCodeAt(j) <= 0x3F) {
              j++;
            }
            // 中间字节范围: 0x20-0x2F (空格、!、" 等)
            while (j < line.length && line.charCodeAt(j) >= 0x20 && line.charCodeAt(j) <= 0x2F) {
              j++;
            }
            // 最终字节范围: 0x40-0x7E (字母等)
            if (j < line.length && line.charCodeAt(j) >= 0x40 && line.charCodeAt(j) <= 0x7E) {
              const finalByte = line[j]!;
              if (finalByte === 'm') {
                // SGR 序列 → 更新样式
                currentStyle = line.slice(i, j + 1);
              }
              // 非 SGR 的 CSI 序列（光标移动、擦除等）→ 跳过，不污染 style
              i = j + 1;
              continue;
            }
            // 不完整的 CSI 序列 → 跳过 ESC [
            i = j > i + 2 ? j : i + 2;
            continue;
          }
          // OSC sequence: ESC ] ... BEL/ST
          if (line[i + 1] === ']') {
            let j = i + 2;
            while (j < line.length) {
              if (line[j] === '\x07') { j++; break; }  // BEL terminator
              if (line[j] === '\x1b' && j + 1 < line.length && line[j + 1] === '\\') { j += 2; break; }  // ST terminator
              j++;
            }
            i = j;
            continue;
          }
          // SS3 sequence: ESC O <char> or other 2-byte ESC sequences
          if (i + 1 < line.length) {
            i += 2;
            continue;
          }
          // Lone ESC at end of line
          i++;
          continue;
        }

        const char = line[i]!;
        const charWidth = stringWidth(char);

        if (x + charWidth <= this._width) {
          this.setCell(x, y, { char, width: charWidth, style: currentStyle });

          // 宽字符占两列，第二列设为占位符
          if (charWidth === 2 && x + 1 < this._width) {
            this.setCell(x + 1, y, { char: '', width: 0, style: '' });
          }

          x += charWidth;
        }

        i++;
      }
    }
  }

  /**
   * 比较两个缓冲区，返回差异行
   */
  diff(other: CellBuffer): number[] {
    const changedRows: number[] = [];

    for (let y = 0; y < this._height; y++) {
      let isDifferent = false;

      for (let x = 0; x < this._width; x++) {
        const a = this.getCell(x, y);
        const b = other.getCell(x, y);

        if (!a || !b || a.char !== b.char || a.style !== b.style) {
          isDifferent = true;
          break;
        }
      }

      if (isDifferent) {
        changedRows.push(y);
      }
    }

    return changedRows;
  }

  /**
   * 渲染指定行为字符串
   */
  renderLine(y: number): string {
    if (y < 0 || y >= this._height) return '';

    let result = '';
    let lastStyle = '';

    for (let x = 0; x < this._width; x++) {
      const cell = this.cells[y]![x]!;

      // 跳过宽字符占位符
      if (cell.width === 0) continue;

      // 样式变化时输出新样式
      if (cell.style !== lastStyle) {
        if (lastStyle) result += '\x1b[0m'; // 重置
        result += cell.style;
        lastStyle = cell.style;
      }

      result += cell.char;
    }

    // 重置样式
    if (lastStyle) result += '\x1b[0m';

    return result.trimEnd();
  }

  /**
   * 克隆缓冲区
   */
  clone(): CellBuffer {
    const buffer = new CellBuffer(this._width, this._height);
    for (let y = 0; y < this._height; y++) {
      for (let x = 0; x < this._width; x++) {
        const cell = this.cells[y]![x]!;
        buffer.setCell(x, y, { ...cell });
      }
    }
    return buffer;
  }
}

// ============================================================================
// FullScreenRenderer
// ============================================================================

export class FullScreenRenderer extends EventEmitter {
  private terminal: TerminalAdapter;
  private options: Required<FullScreenOptions>;

  // 双缓冲
  private frontBuffer: CellBuffer;
  private backBuffer: CellBuffer;

  // 状态
  private _isActive = false;
  private _lastStats: FrameStats | null = null;
  private _frameCount = 0;
  private _forceFullRedraw = false;

  constructor(options: FullScreenOptions = {}) {
    super();

    this.options = {
      alternateScreen: true,
      hideCursor: true,
      mouse: false,
      bottomFixed: 0,
      topFixed: 0,
      ...options,
    };

    this.terminal = getTerminalAdapter();
    const { columns, rows } = this.terminal.size;

    this.frontBuffer = new CellBuffer(columns, rows);
    this.backBuffer = new CellBuffer(columns, rows);

    // 监听 resize
    this.terminal.on('resize', this.handleResize.bind(this));
  }

  get isActive() { return this._isActive; }
  get size(): TerminalSize { return this.terminal.size; }
  get lastStats() { return this._lastStats; }
  get frameCount() { return this._frameCount; }

  /**
   * 启动全屏模式
   */
  start() {
    if (this._isActive) return;

    this._isActive = true;

    // 进入 Alternate Screen
    if (this.options.alternateScreen) {
      this.terminal.enterAltScreen();
    }

    // 隐藏光标
    if (this.options.hideCursor) {
      this.terminal.hideCursor();
    }

    // 启用鼠标
    if (this.options.mouse) {
      this.terminal.write('\x1b[?1000h'); // 启用鼠标点击报告
      this.terminal.write('\x1b[?1006h'); // 启用 SGR 鼠标模式
    }

    // 清屏
    this.terminal.clearScreen();
    this.terminal.moveCursor(0, 0);

    // 标记需要全量重绘
    this._forceFullRedraw = true;

    this.emit('start');
  }

  /**
   * 停止全屏模式
   */
  stop() {
    if (!this._isActive) return;

    this._isActive = false;

    // 禁用鼠标
    if (this.options.mouse) {
      this.terminal.write('\x1b[?1000l');
      this.terminal.write('\x1b[?1006l');
    }

    // 显示光标
    if (this.options.hideCursor) {
      this.terminal.showCursor();
    }

    // 离开 Alternate Screen
    if (this.options.alternateScreen) {
      this.terminal.leaveAltScreen();
    }

    this.emit('stop');
  }

  /**
   * 处理终端 resize
   */
  private handleResize(newSize: TerminalSize) {
    const { columns, rows } = newSize;

    // 调整缓冲区大小
    this.frontBuffer.resize(columns, rows);
    this.backBuffer.resize(columns, rows);

    // 标记需要全量重绘
    this._forceFullRedraw = true;

    this.emit('resize', newSize);

    // 如果正在运行，立即触发重绘
    if (this._isActive) {
      this.emit('needsRedraw');
    }
  }

  /**
   * 渲染一帧
   *
   * @param frame 帧内容
   * @returns 渲染统计
   */
  render(frame: RenderFrame): FrameStats {
    const startTime = performance.now();

    if (!this._isActive) {
      return {
        totalLines: 0,
        updatedLines: 0,
        skippedLines: 0,
        renderTime: 0,
        fullRedraw: false,
      };
    }

    const { columns, rows } = this.terminal.size;

    // 更新 back buffer
    this.backBuffer.setFromLines(frame.lines);

    // 决定是全量重绘还是差分更新
    const doFullRedraw = this._forceFullRedraw || this._frameCount === 0;
    this._forceFullRedraw = false;

    let updatedLines = 0;
    let skippedLines = 0;

    // 开始同步更新（防闪烁）
    this.terminal.beginSyncUpdate();
    try {
      if (doFullRedraw) {
        // 全量重绘：从 (0,0) 开始逐行输出
        this.terminal.moveCursor(0, 0);

        for (let y = 0; y < rows; y++) {
          const line = this.backBuffer.renderLine(y);
          this.terminal.write(line);
          this.terminal.write(ANSI.ERASE_LINE_END); // 清除行尾
          if (y < rows - 1) {
            this.terminal.write('\n');
          }
          updatedLines++;
        }
      } else {
        // 差分更新：只更新变化的行
        const changedRows = this.backBuffer.diff(this.frontBuffer);

        for (const y of changedRows) {
          this.terminal.moveCursor(0, y);
          const line = this.backBuffer.renderLine(y);
          this.terminal.write(line);
          this.terminal.write(ANSI.ERASE_LINE_END);
          updatedLines++;
        }

        skippedLines = rows - changedRows.length;
      }

      // 处理光标位置
      if (frame.cursor) {
        this.terminal.moveCursor(frame.cursor.x, frame.cursor.y);
      }
    } finally {
      // 结束同步更新
      this.terminal.endSyncUpdate();
    }

    // 交换缓冲区
    const temp = this.frontBuffer;
    this.frontBuffer = this.backBuffer;
    this.backBuffer = temp;

    this._frameCount++;

    const stats: FrameStats = {
      totalLines: rows,
      updatedLines,
      skippedLines,
      renderTime: performance.now() - startTime,
      fullRedraw: doFullRedraw,
    };

    this._lastStats = stats;
    return stats;
  }

  /**
   * 强制下一帧全量重绘
   */
  forceRedraw() {
    this._forceFullRedraw = true;
  }

  /**
   * 清屏
   */
  clear() {
    if (!this._isActive) return;

    this.terminal.clearScreen();
    this.terminal.moveCursor(0, 0);
    this.frontBuffer.clear();
    this.backBuffer.clear();
    this._forceFullRedraw = true;
  }
}

// ============================================================================
// 简化的全屏渲染器（Alternate Screen 模式，用于 Ink）
// ============================================================================

export class AltScreenRenderer extends EventEmitter {
  private terminal: TerminalAdapter;
  private _lastVisibleLines: string[] = [];  // 上一帧可见区域的行
  private _allLines: string[] = [];          // 所有内容行
  private _isActive = false;
  private _forceFullRedraw = false;
  private _scrollOffset = 0;                 // 滚动偏移（从顶部开始）
  private _autoScroll = true;                // 自动滚动到底部
  private _contentHeight = 0;                // 内容总高度
  private readonly boundHandleResize: (newSize: TerminalSize) => void;

  constructor() {
    super();
    this.terminal = getTerminalAdapter();
    this.boundHandleResize = this.handleResize.bind(this);
  }

  get isActive() { return this._isActive; }
  get size(): TerminalSize { return this.terminal.size; }
  get scrollOffset() { return this._scrollOffset; }
  get contentHeight() { return this._contentHeight; }
  get isAutoScroll() { return this._autoScroll; }

  get isResizeLocked(): boolean { return false; }
  get lastVisualLines(): number { return this._lastVisibleLines.length; }

  /**
   * 启动全屏模式
   */
  start() {
    if (this._isActive) return;
    this._isActive = true;

    // 进入 Alternate Screen
    this.terminal.enterAltScreen();
    this.terminal.hideCursor();
    this.terminal.clearScreen();
    this.terminal.moveCursor(0, 0);

    this.terminal.write('\x1b[?1000h'); // 启用鼠标点击报告
    this.terminal.write('\x1b[?1002h'); // 启用鼠标移动报告
    this.terminal.write('\x1b[?1006h'); // 启用 SGR 鼠标模式（支持滚轮）

    // 监听 resize（使用缓存的 bound handler）
    this.terminal.on('resize', this.boundHandleResize);

    this._forceFullRedraw = true;
    this.emit('start');
  }

  /**
   * 停止全屏模式
   */
  stop() {
    if (!this._isActive) return;
    this._isActive = false;

    // 禁用鼠标
    this.terminal.write('\x1b[?1006l');
    this.terminal.write('\x1b[?1002l');
    this.terminal.write('\x1b[?1000l');

    this.terminal.showCursor();
    this.terminal.leaveAltScreen();
    this.terminal.off('resize', this.boundHandleResize);

    this.emit('stop');
  }

  /**
   * 处理 resize
   */
  private handleResize(newSize: TerminalSize) {
    if (process.env.NEOX_INK_DEBUG === '1') {
      process.stderr.write(
        `[AltScreenRenderer.handleResize] ${newSize.columns}x${newSize.rows}\n`
      );
    }

    // 标记需要全量重绘
    this._forceFullRedraw = true;
    this._lastVisibleLines = [];

    // 重新计算滚动位置
    if (this._autoScroll) {
      this._scrollOffset = Math.max(0, this._contentHeight - newSize.rows);
    } else {
      // 确保滚动位置有效
      const maxOffset = Math.max(0, this._contentHeight - newSize.rows);
      this._scrollOffset = Math.min(this._scrollOffset, maxOffset);
    }

    this.emit('resize', newSize);
    this.emit('resizeUnlock');
  }

  // =========================================================================
  // =========================================================================

  /**
   * 向上滚动
   */
  scrollUp(lines = 3) {
    if (this._scrollOffset <= 0) return false;

    this._scrollOffset = Math.max(0, this._scrollOffset - lines);
    this._autoScroll = false;
    this._forceFullRedraw = true;
    this.emit('scroll', this._scrollOffset);
    return true;
  }

  /**
   * 向下滚动
   */
  scrollDown(lines = 3) {
    const { rows } = this.terminal.size;
    const maxOffset = Math.max(0, this._contentHeight - rows);

    if (this._scrollOffset >= maxOffset) return false;

    this._scrollOffset = Math.min(maxOffset, this._scrollOffset + lines);

    // 如果滚动到底部，恢复自动滚动
    if (this._scrollOffset >= maxOffset) {
      this._autoScroll = true;
    }

    this._forceFullRedraw = true;
    this.emit('scroll', this._scrollOffset);
    return true;
  }

  /**
   * 向上翻页
   */
  pageUp() {
    const { rows } = this.terminal.size;
    return this.scrollUp(rows - 2);
  }

  /**
   * 向下翻页
   */
  pageDown() {
    const { rows } = this.terminal.size;
    return this.scrollDown(rows - 2);
  }

  /**
   * 滚动到顶部
   */
  scrollToTop() {
    if (this._scrollOffset === 0) return false;

    this._scrollOffset = 0;
    this._autoScroll = false;
    this._forceFullRedraw = true;
    this.emit('scroll', this._scrollOffset);
    return true;
  }

  /**
   * 滚动到底部
   */
  scrollToBottom() {
    const { rows } = this.terminal.size;
    const maxOffset = Math.max(0, this._contentHeight - rows);

    if (this._scrollOffset === maxOffset && this._autoScroll) return false;

    this._scrollOffset = maxOffset;
    this._autoScroll = true;
    this._forceFullRedraw = true;
    this.emit('scroll', this._scrollOffset);
    return true;
  }

  /**
   * 检查是否可以滚动
   */
  canScroll(): { up: boolean; down: boolean } {
    const { rows } = this.terminal.size;
    const maxOffset = Math.max(0, this._contentHeight - rows);
    return {
      up: this._scrollOffset > 0,
      down: this._scrollOffset < maxOffset,
    };
  }

  // =========================================================================
  // =========================================================================

  /**
   * 差分渲染 - 只更新变化的行
   */
  render(content: string) {
    if (!this._isActive) return;

    const allLines = content.split('\n');
    this._allLines = allLines;
    this._contentHeight = allLines.length;

    const { rows } = this.terminal.size;

    // 如果自动滚动，始终显示最新内容
    if (this._autoScroll) {
      this._scrollOffset = Math.max(0, allLines.length - rows);
    }

    // 计算可见区域的行
    const visibleLines: string[] = [];
    for (let i = 0; i < rows; i++) {
      const lineIndex = this._scrollOffset + i;
      visibleLines.push(allLines[lineIndex] || '');
    }

    const oldLines = this._lastVisibleLines;

    // 开始同步更新（防闪烁）
    this.terminal.beginSyncUpdate();
    try {
      if (this._forceFullRedraw) {
        // 全量重绘
        this.terminal.clearScreen();
        this.terminal.moveCursor(0, 0);

        for (let i = 0; i < visibleLines.length; i++) {
          this.terminal.write(visibleLines[i]!);
          if (i < visibleLines.length - 1) {
            this.terminal.write('\n');
          }
        }

        this._forceFullRedraw = false;
      } else {
        // 差分渲染：只更新变化的行
        for (let i = 0; i < visibleLines.length; i++) {
          const oldLine = oldLines[i] || '';
          const newLine = visibleLines[i] || '';

          if (oldLine !== newLine) {
            this.terminal.moveCursor(0, i);
            this.terminal.write('\x1b[2K');
            this.terminal.write(newLine);
          }
        }
      }
    } finally {
      // 结束同步更新
      this.terminal.endSyncUpdate();
    }

    // 保存当前帧
    this._lastVisibleLines = visibleLines;
  }

  /**
   * 清除输出
   */
  clear() {
    if (!this._isActive) return;
    this.terminal.clearScreen();
    this.terminal.moveCursor(0, 0);
    this._lastVisibleLines = [];
    this._allLines = [];
    this._scrollOffset = 0;
    this._contentHeight = 0;
    this._autoScroll = true;
  }

  /**
   * 强制下次全量重绘
   */
  forceRedraw() {
    this._forceFullRedraw = true;
  }

  /**
   * 完成渲染
   */
  done() {
    this.stop();
  }

  /**
   * 重置状态
   */
  resetState() {
    this._lastVisibleLines = [];
    this._allLines = [];
    this._scrollOffset = 0;
    this._contentHeight = 0;
    this._autoScroll = true;
    this._forceFullRedraw = true;
  }
}

export function createAltScreenRenderer(): AltScreenRenderer {
  return new AltScreenRenderer();
}

// ============================================================================
// 简化的非全屏渲染器（用于不使用 Alternate Screen 的场景）
// ============================================================================

export class InlineRenderer extends EventEmitter {
  private terminal: TerminalAdapter;
  private static readonly INVERSE_SGR_REGEX = /\x1b\[(?:\d+;)*7(?:;\d+)*m/g;
  private readonly _incremental: boolean;
  private _lastOutput = '';
  private _lastVisualLines = 0;
  private _lastVisualLineContent: string[] = [];
  private _lastCursorLine = 0;
  private _lastWidth = 0;
  private _resizePending = false;
  private _resizeLock = false;
  private _resizeLockTimer: NodeJS.Timeout | null = null;
  private _renderDebugCounter = 0;

  private shouldLogRenderDebug(): boolean {
    if (!INK_RENDER_DEBUG) {
      return false;
    }

    this._renderDebugCounter += 1;
    return this._renderDebugCounter % INK_RENDER_LOG_SAMPLE === 0;
  }

  constructor(options: { incremental?: boolean } = {}) {
    super();
    this.terminal = getTerminalAdapter();
    this._incremental = options.incremental !== false;
    this._lastWidth = this.terminal.size.columns;
  }

  get isResizeLocked(): boolean {
    return this._resizeLock;
  }

  get size(): TerminalSize {
    return this.terminal.size;
  }

  get lastVisualLines(): number {
    return this._lastVisualLines;
  }

  get lastWidth(): number {
    return this._lastWidth;
  }

  /**
   * 计算字符串的视觉行数（考虑换行）
   */
  calculateVisualLines(content: string, width: number): number {
    return this.toVisualLines(content, width).length;
  }

  /**
   * 将内容按终端宽度展开为视觉行（保留 ANSI 样式）
   */
  private toVisualLines(content: string, width: number): string[] {
    if (!content) return [];

    const wrapped = wrapAnsi(content, Math.max(1, width), {
      hard: true,
      trim: false,
    });

    if (wrapped === '') {
      return [];
    }

    return wrapped.split('\n');
  }

  private findCursorHint(lines: string[], width: number): { lineIndex: number; column: number } | null {
    for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex--) {
      const line = lines[lineIndex] ?? '';
      InlineRenderer.INVERSE_SGR_REGEX.lastIndex = 0;

      let matchedAt = -1;
      let match: RegExpExecArray | null;
      while ((match = InlineRenderer.INVERSE_SGR_REGEX.exec(line)) !== null) {
        matchedAt = match.index;
      }

      if (matchedAt >= 0) {
        const prefix = line.slice(0, matchedAt);
        const rawColumn = stringWidth(stripAnsi(prefix));
        const maxSafeMove = Math.max(0, width - 1);
        const column = AGGRESSIVE_INPUT_COMPAT
          ? Math.min(rawColumn, maxSafeMove)
          : rawColumn;
        return { lineIndex, column };
      }
    }

    return null;
  }

  private buildCursorMoveSequence(targetLineIndex: number, targetColumn: number, totalLines: number): string {
    if (totalLines <= 0) return '';

    const currentLineIndex = totalLines - 1;
    const moveUp = Math.max(0, currentLineIndex - targetLineIndex);

    let seq = '';
    if (moveUp > 0) {
      seq += `\x1b[${moveUp}A`;
    }

    seq += '\r';
    if (targetColumn > 0) {
      seq += `\x1b[${targetColumn}C`;
    }

    return seq;
  }

  private alignCursorToBottom(totalLines: number): string {
    if (totalLines <= 0) return '';

    const clampedLine = Math.max(0, Math.min(this._lastCursorLine, totalLines - 1));
    const bottomLine = totalLines - 1;
    const moveDelta = bottomLine - clampedLine;

    if (moveDelta > 0) return `\x1b[${moveDelta}B`;
    if (moveDelta < 0) return `\x1b[${-moveDelta}A`;
    return '';
  }

  /**
   * 核心清除逻辑：逐行清除
   *
   * 从当前位置向上逐行清除，不依赖光标的绝对位置。
   */
  private eraseOutput(visualLines: number) {
    if (visualLines <= 0) return;

    let clear = '';
    for (let i = 0; i < visualLines; i++) {
      // 清除当前行
      clear += '\x1b[2K';
      // 如果不是最后一行，上移一行
      if (i < visualLines - 1) {
        clear += '\x1b[1A';
      }
    }
    // 回到行首
    clear += '\r';

    this.terminal.write(clear);
  }

  handleResize(newWidth: number): number {
    const oldWidth = this._lastWidth;
    const oldOutput = this._lastOutput;

    // 计算旧内容在新宽度下的视觉行数
    const newVisualLines = this.calculateVisualLines(oldOutput, newWidth);

    if (process.env.NEOX_INK_DEBUG === '1') {
      process.stderr.write(
        `[InlineRenderer.handleResize] width: ${oldWidth}→${newWidth}, ` +
        `lastLines=${this._lastVisualLines}, newLines=${newVisualLines}\n`
      );
    }

    this._resizeLock = true;
    if (this._resizeLockTimer) {
      clearTimeout(this._resizeLockTimer);
    }
    this._resizeLockTimer = setTimeout(() => {
      if (this._resizeLock) {
        this._resizeLock = false;
        this._resizeLockTimer = null;
        this.emit('resizeUnlock');
      }
    }, 300);

    // 使用新宽度计算的行数，因为终端已重排
    this._lastVisualLines = newVisualLines;
    this._lastWidth = newWidth;
    this._resizePending = true;

    return newVisualLines;
  }

  /**
   * 渲染内容
   */
  render(content: string) {
    const width = this.terminal.size.columns;
    const traceRender = this.shouldLogRenderDebug();

    if (traceRender) {
      cliLogger.debug('INK_RENDER',
        `render: width=${width}, lastWidth=${this._lastWidth}, ` +
        `lastLines=${this._lastVisualLines}, resizePending=${this._resizePending}, ` +
        `incremental=${this._incremental}, content=${content.length} chars, ` +
        `contentLines=${content.split('\n').length}, endsWithNL=${content.endsWith('\n')}`
      );
    }

    const newVisualContent = this.toVisualLines(content, width);
    const newVisualLines = newVisualContent.length;
    const cursorHint = this.findCursorHint(newVisualContent, width);

    if (traceRender) {
      cliLogger.debug('INK_RENDER', `newVisualLines=${newVisualLines}, cursorHint=${JSON.stringify(cursorHint)}`);
    }

    // 首次渲染 / resize 后：全量重绘
    if (!this._incremental || this._lastVisualLines === 0 || this._resizePending || this._lastWidth !== width) {
      if (traceRender) {
        cliLogger.debug('INK_RENDER',
          `FULL_REDRAW: lastVisualLines=${this._lastVisualLines}, newVisualLines=${newVisualLines}, ` +
          `lastCursorLine=${this._lastCursorLine}`
        );
      }

      if (process.platform === 'win32') {
        if (this._lastVisualLines > 0) {
          const moveToBottom = this.alignCursorToBottom(this._lastVisualLines);
          if (moveToBottom) this.terminal.write(moveToBottom);
          this.eraseOutput(this._lastVisualLines);
        }

        let prevLineWasFullWidth = false;
        for (let i = 0; i < newVisualLines; i++) {
          const line = (newVisualContent[i] ?? '').trimEnd();
          if (i > 0 && !prevLineWasFullWidth) {
            this.terminal.write('\n');
          }
          this.terminal.write(line);
          const lineWidth = stringWidth(stripAnsi(line));
          prevLineWasFullWidth = lineWidth >= width;
        }
        this.terminal.write('\x1b[J');
      } else {
        // Unix/Mac 路径：原有逻辑
        if (this._lastVisualLines > 0) {
          const moveToBottom = this.alignCursorToBottom(this._lastVisualLines);
          if (moveToBottom) {
            this.terminal.write(moveToBottom);
          }
          this.eraseOutput(this._lastVisualLines);
        }
        this.terminal.write(newVisualContent.join('\n'));
        //   与上面 Windows 路径 '\x1b[J' 对齐。eraseOutput 只清向上的固定行数,
        //   清不到 reflow 多出来的下方行 → 这里补一刀。
        this.terminal.write('\x1b[J');
      }

      if (cursorHint && newVisualLines > 0) {
        this.terminal.write(this.buildCursorMoveSequence(cursorHint.lineIndex, cursorHint.column, newVisualLines));
      }
    } else {
      const oldLines = this._lastVisualLineContent;
      const oldCount = oldLines.length;
      const maxLines = Math.max(oldCount, newVisualLines);

      let patch = '';

      // 回到动态区域顶部
      if (oldCount > 0) {
        const clampedCursorLine = Math.max(0, Math.min(this._lastCursorLine, oldCount - 1));
        if (clampedCursorLine > 0) {
          patch += `\x1b[${clampedCursorLine}A`;
        }
        patch += '\r';
      }

      // 逐行差分更新
      for (let i = 0; i < maxLines; i++) {
        if (i > 0) {
          patch += '\n';
        }

        patch += '\r';

        const oldLine = oldLines[i] ?? '';
        const nextLine = newVisualContent[i] ?? '';

        if (oldLine !== nextLine) {
          patch += '\x1b[2K';
          patch += nextLine;
        }
      }

      // 把光标放回新动态区域底部（与后续更新保持一致）
      if (newVisualLines > 0) {
        if (cursorHint) {
          patch += this.buildCursorMoveSequence(cursorHint.lineIndex, cursorHint.column, maxLines);
        } else {
          const moveUp = maxLines - newVisualLines;
          if (moveUp > 0) {
            patch += `\x1b[${moveUp}A`;
          }

          patch += '\r';

          const lastLine = newVisualContent[newVisualLines - 1] ?? '';
          if (AGGRESSIVE_INPUT_COMPAT) {
            const sanitizedLastLine = stripAnsi(lastLine).replace(/[\u0000-\u001F\u007F]/g, '');
            const visualWidth = stringWidth(sanitizedLastLine);
            const maxSafeMove = Math.max(0, width - 1);
            const lastWidth = Math.min(visualWidth, maxSafeMove);
            if (lastWidth > 0) {
              patch += `\x1b[${lastWidth}C`;
            }
          } else {
            const lastWidth = stringWidth(stripAnsi(lastLine));
            if (lastWidth > 0) {
              patch += `\x1b[${lastWidth}C`;
            }
          }
        }
      }

      this.terminal.beginSyncUpdate();
      try {
        this.terminal.write(patch);
      } finally {
        this.terminal.endSyncUpdate();
      }
    }

    // 更新状态
    this._lastOutput = content;
    this._lastVisualLines = newVisualLines;
    this._lastVisualLineContent = newVisualContent;
    this._lastCursorLine = newVisualLines > 0
      ? (cursorHint ? Math.max(0, Math.min(cursorHint.lineIndex, newVisualLines - 1)) : newVisualLines - 1)
      : 0;
    this._lastWidth = width;
    this._resizePending = false;

    if (this._resizeLock) {
      this._resizeLock = false;
      if (this._resizeLockTimer) {
        clearTimeout(this._resizeLockTimer);
        this._resizeLockTimer = null;
      }
      this.emit('resizeUnlock');
    }
  }

  /**
   * 清除输出
   */
  clear() {
    const moveToBottom = this.alignCursorToBottom(this._lastVisualLines);
    if (moveToBottom) {
      this.terminal.write(moveToBottom);
    }
    this.eraseOutput(this._lastVisualLines);
    this._lastOutput = '';
    this._lastVisualLines = 0;
    this._lastVisualLineContent = [];
    this._lastCursorLine = 0;
  }

  resetState() {
    this._lastOutput = '';
    this._lastVisualLines = 0;
    this._lastVisualLineContent = [];
    this._lastCursorLine = 0;
    this._lastWidth = this.terminal.size.columns;
    this._resizePending = false;
  }

  /**
   * 完成渲染（退出时调用：清除所有动态输出，显示光标）
   */
  done() {
    // 先把光标移到动态区域底部，再向上清除所有行
    if (this._lastVisualLines > 0) {
      const moveToBottom = this.alignCursorToBottom(this._lastVisualLines);
      if (moveToBottom) {
        this.terminal.write(moveToBottom);
      }
      this.eraseOutput(this._lastVisualLines);
    }

    this.terminal.showCursor();
    this._lastOutput = '';
    this._lastVisualLines = 0;
    this._lastVisualLineContent = [];
    this._lastCursorLine = 0;
  }

  /**
   * Truncate an ANSI string to a target visual width.
   * Preserves ANSI escape sequences while removing visible characters from the end.
   */
  private truncateToWidth(line: string, targetWidth: number): string {
    let currentWidth = 0;
    let result = '';
    let i = 0;

    while (i < line.length) {
      // Pass through all ANSI escape sequences without counting width
      if (line[i] === '\x1b') {
        // CSI sequence: ESC [ <params> <final byte 0x40-0x7E>
        if (line[i + 1] === '[') {
          let j = i + 2;
          // Parameter bytes (0x30-0x3F) + Intermediate bytes (0x20-0x2F)
          while (j < line.length && line.charCodeAt(j) >= 0x20 && line.charCodeAt(j) <= 0x3F) {
            j++;
          }
          // Final byte (0x40-0x7E)
          if (j < line.length && line.charCodeAt(j) >= 0x40 && line.charCodeAt(j) <= 0x7E) {
            result += line.slice(i, j + 1);
            i = j + 1;
            continue;
          }
          // Incomplete CSI — skip ESC [
          result += line.slice(i, j);
          i = j;
          continue;
        }
        // OSC sequence: ESC ] ... BEL/ST
        if (line[i + 1] === ']') {
          let j = i + 2;
          while (j < line.length) {
            if (line[j] === '\x07') { j++; break; }
            if (line[j] === '\x1b' && j + 1 < line.length && line[j + 1] === '\\') { j += 2; break; }
            j++;
          }
          result += line.slice(i, j);
          i = j;
          continue;
        }
        // Other 2-byte ESC sequences
        if (i + 1 < line.length) {
          result += line.slice(i, i + 2);
          i += 2;
          continue;
        }
        // Lone ESC at end
        result += line[i];
        i++;
        continue;
      }

      const char = line[i]!;
      const charWidth = stringWidth(char);

      if (currentWidth + charWidth > targetWidth) {
        break;
      }

      result += char;
      currentWidth += charWidth;
      i++;
    }

    // Append reset if we had any styles
    if (result.includes('\x1b[')) {
      result += '\x1b[0m';
    }

    return result;
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createFullScreenRenderer(options?: FullScreenOptions): FullScreenRenderer {
  return new FullScreenRenderer(options);
}

export function createInlineRenderer(options: { incremental?: boolean } = {}): InlineRenderer {
  return new InlineRenderer(options);
}
