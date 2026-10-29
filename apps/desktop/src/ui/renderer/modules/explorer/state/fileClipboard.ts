/**
 * fileClipboard - Project View 剪贴板状态(模块单例)
 *
 * 设计:
 * - 不进 React state(剪贴板变化不影响渲染,除非 cut 状态显示半透明)
 * - module-scope class,跨组件共享
 * - 支持 subscribe → 让 UI 在 cut 状态变化时自动更新文件透明度
 *
 * 跟 IDEA Project View Clipboard 行为一致:
 *   - cut(paths)        → 文件标记为已剪切,paste 后从源位置消失
 *   - copy(paths)       → 文件标记为已复制,paste 不影响源
 *   - get()             → 当前剪贴板状态
 *   - clear()           → 清空(paste 后 cut 状态自动清,copy 保留)
 *   - isCut(path)       → 该文件是否在 cut 队列里(用于显示 0.5 透明度)
 */

export type ClipboardOperation = 'cut' | 'copy';

export interface ClipboardState {
  operation: ClipboardOperation;
  paths: string[];
}

type ClipboardListener = (state: ClipboardState | null) => void;

const STORAGE_KEY = 'neox-file-clipboard';

class FileClipboard {
  private state: ClipboardState | null = null;
  private listeners = new Set<ClipboardListener>();

  constructor() {
    /* 跨重启持久化 — 关 App 前 cut/copy 的内容下次还能 paste (之前模块单例丢失) */
    try {
      const raw = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.operation === 'cut' || parsed.operation === 'copy') && Array.isArray(parsed.paths)) {
          this.state = { operation: parsed.operation, paths: parsed.paths };
        }
      }
    } catch { /* ignore */ }
  }

  private persist(): void {
    try {
      if (typeof window === 'undefined') return;
      if (this.state) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch { /* quota / unavailable */ }
  }

  cut(paths: string[]): void {
    if (paths.length === 0) return;
    this.state = { operation: 'cut', paths: [...paths] };
    this.persist();
    this.notify();
  }

  copy(paths: string[]): void {
    if (paths.length === 0) return;
    this.state = { operation: 'copy', paths: [...paths] };
    this.persist();
    this.notify();
  }

  get(): ClipboardState | null {
    return this.state;
  }

  hasContent(): boolean {
    return this.state !== null && this.state.paths.length > 0;
  }

  clear(): void {
    this.state = null;
    this.persist();
    this.notify();
  }

  /**
   * paste 后调用: 如果是 cut,则清空剪贴板(防止再次 paste)
   * copy 保留,可以多次粘贴
   */
  consumeCut(): void {
    if (this.state?.operation === 'cut') {
      this.clear();
    }
  }

  isCut(path: string): boolean {
    return this.state?.operation === 'cut' && this.state.paths.includes(path);
  }

  subscribe(listener: ClipboardListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

export const fileClipboard = new FileClipboard();
