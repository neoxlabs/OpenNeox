/**
 * InkTerminalBackend - Ink 的终端后端适配器
 *
 * 替换 Ink 默认的 log-update，使用我们的 TerminalAdapter + DiffRenderer
 * 提供：
 * - 跨平台 resize 支持
 * - Synchronized Update 防闪烁
 * - Diff 渲染优化
 * - Alternate Screen 支持
 */

import type { Writable } from 'stream';
import { TerminalAdapter, getTerminalAdapter, type TerminalCapabilities } from './TerminalAdapter.js';
import { DiffRenderer, type RenderStats } from './DiffRenderer.js';

// ============================================================================
// Types
// ============================================================================

export interface InkBackendOptions {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  /** 是否启用 diff 渲染 */
  diffRendering?: boolean;
  /** 是否启用 synchronized update */
  syncUpdate?: boolean;
  /** 是否显示光标 */
  showCursor?: boolean;
  /** 调试模式 */
  debug?: boolean;
}

export interface InkLogUpdate {
  (str: string): void;
  clear: () => void;
  done: () => void;
  sync: (str: string) => void;
}

// ============================================================================
// InkTerminalBackend
// ============================================================================

export class InkTerminalBackend {
  private terminal: TerminalAdapter;
  private diffRenderer: DiffRenderer | null = null;
  private options: InkBackendOptions;

  private previousOutput = '';
  private previousLineCount = 0;
  private hasHiddenCursor = false;

  constructor(options: InkBackendOptions) {
    this.options = options;
    this.terminal = getTerminalAdapter({
      stdout: options.stdout,
      stdin: options.stdin,
    });

    if (options.diffRendering !== false) {
      this.diffRenderer = new DiffRenderer(this.terminal);
    }
  }

  /**
   * 获取终端能力
   */
  get capabilities(): TerminalCapabilities {
    return this.terminal.capabilities;
  }

  /**
   * 获取终端尺寸
   */
  get size() {
    return this.terminal.size;
  }

  /**
   * 监听 resize 事件
   */
  onResize(callback: (size: { columns: number; rows: number }) => void): () => void {
    this.terminal.on('resize', callback);
    return () => this.terminal.off('resize', callback);
  }

  /**
   * 创建兼容 Ink 的 LogUpdate 接口
   */
  createLogUpdate(): InkLogUpdate {
    const render = (str: string) => {
      // 隐藏光标
      if (!this.options.showCursor && !this.hasHiddenCursor) {
        this.terminal.hideCursor();
        this.hasHiddenCursor = true;
      }

      const output = str + '\n';

      // 内容相同，跳过
      if (output === this.previousOutput) {
        return;
      }

      // 使用 diff 渲染或标准渲染
      if (this.diffRenderer && this.options.diffRendering !== false) {
        this.renderWithDiff(output);
      } else {
        this.renderStandard(output);
      }

      this.previousOutput = output;
      this.previousLineCount = output.split('\n').length;
    };

    render.clear = () => {
      this.clear();
    };

    render.done = () => {
      this.done();
    };

    render.sync = (str: string) => {
      // 同步状态但不渲染（用于外部清除后同步）
      const output = str + '\n';
      this.previousOutput = output;
      this.previousLineCount = output.split('\n').length;
      if (this.diffRenderer) {
        this.diffRenderer.clear();
      }
    };

    return render;
  }

  /**
   * 使用 diff 渲染
   */
  private renderWithDiff(output: string): void {
    if (!this.diffRenderer) return;

    // 如果是首次渲染或内容完全不同，使用全量渲染
    if (this.previousOutput === '' || this.previousOutput === '\n') {
      this.diffRenderer.renderFull(output);
    } else {
      this.diffRenderer.render(output);
    }

    if (this.options.debug) {
      const stats = this.diffRenderer.lastStats;
      if (stats && stats.changedLines < stats.totalLines) {
        process.stderr.write(
          `[INK_DIFF] Changed ${stats.changedLines}/${stats.totalLines} lines, ` +
          `${stats.bytesWritten} bytes, ${stats.renderTime.toFixed(1)}ms\n`
        );
      }
    }
  }

  /**
   * 标准渲染（清除后重绘）
   */
  private renderStandard(output: string): void {
    const useSyncUpdate = this.options.syncUpdate !== false &&
      this.terminal.capabilities.synchronizedUpdate;

    if (useSyncUpdate) {
      this.terminal.beginSyncUpdate();
    }

    try {
      // 清除之前的输出
      if (this.previousLineCount > 0) {
        this.terminal.clearLines(this.previousLineCount);
      }

      // 写入新输出
      this.terminal.write(output);
    } finally {
      if (useSyncUpdate) {
        this.terminal.endSyncUpdate();
      }
    }
  }

  /**
   * 清除输出
   */
  clear(): void {
    if (this.previousLineCount > 0) {
      this.terminal.clearLines(this.previousLineCount);
    }
    this.previousOutput = '';
    this.previousLineCount = 0;
    if (this.diffRenderer) {
      this.diffRenderer.clear();
    }
  }

  /**
   * 完成渲染（显示光标）
   */
  done(): void {
    this.previousOutput = '';
    this.previousLineCount = 0;

    if (!this.options.showCursor && this.hasHiddenCursor) {
      this.terminal.showCursor();
      this.hasHiddenCursor = false;
    }

    if (this.diffRenderer) {
      this.diffRenderer.clear();
    }
  }

  /**
   * 进入备用屏幕
   */
  enterAltScreen(): void {
    this.terminal.enterAltScreen();
  }

  /**
   * 离开备用屏幕
   */
  leaveAltScreen(): void {
    this.terminal.leaveAltScreen();
  }

  /**
   * 是否在备用屏幕中
   */
  get inAltScreen(): boolean {
    return this.terminal.inAltScreen;
  }

  /**
   * 销毁
   */
  destroy(): void {
    this.done();
    this.terminal.reset();
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * 创建 Ink 兼容的 log-update
 * 可直接替换 Ink 的 log-update 模块
 */
export function createInkLogUpdate(
  stream: Writable,
  options: { showCursor?: boolean; incremental?: boolean } = {}
): InkLogUpdate {
  const backend = new InkTerminalBackend({
    stdout: stream as NodeJS.WriteStream,
    stdin: process.stdin as NodeJS.ReadStream,
    showCursor: options.showCursor,
    diffRendering: options.incremental,
  });

  return backend.createLogUpdate();
}

// ============================================================================
// Ink Integration Hook
// ============================================================================

/**
 * React Hook: 获取终端适配器
 * 用于在 Ink 组件中访问终端能力
 */
export function useTerminalAdapter(): TerminalAdapter {
  return getTerminalAdapter();
}

/**
 * React Hook: 监听终端 resize
 * 比 Ink 内置的 useStdout 更可靠（支持 Windows/WSL 轮询）
 */
export function useTerminalResize(
  callback: (size: { columns: number; rows: number }) => void
): void {
  const terminal = getTerminalAdapter();

  // 使用 React 的 useEffect 需要在组件中调用
  // 这里提供一个简单的订阅接口
  terminal.on('resize', callback);
}
