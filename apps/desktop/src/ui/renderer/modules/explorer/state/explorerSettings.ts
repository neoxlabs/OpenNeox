
export type SortBy = 'name' | 'type' | 'time-asc' | 'time-desc';

export interface ExplorerSettings {
  showHiddenFiles: boolean;
  showExcludedFiles: boolean;
  sortBy: SortBy;
  foldersFirst: boolean;
  compactMiddleDirs: boolean;
  /** 单击即打开文件 / 展开文件夹 (VSCode 风格)。false = 单击只选中, 双击才打开 (IDEA 老行为) */
  openOnSingleClick: boolean;
}

const defaultSettings: ExplorerSettings = {
  /* 隐藏 dotfiles (.git/.DS_Store/.idea 等) — 跟主流 IDE 默认一致.
   * 用户想看可在 sidebar 头部 ⋯ 菜单切换. */
  showHiddenFiles: false,
  /* node_modules / dist / build / .next 等也默认隐藏, 给 sidebar 留一个干净视图 */
  showExcludedFiles: false,
  sortBy: 'name',
  foldersFirst: true,
  compactMiddleDirs: false,
  openOnSingleClick: true,
};

type Listener = (settings: ExplorerSettings) => void;

class ExplorerSettingsStore {
  private state: ExplorerSettings = { ...defaultSettings };
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private listeners = new Set<Listener>();

  constructor() {
    // 异步从 SQLite 加载,完成后通知订阅者
    this.loadFromBackend();
  }

  private async loadFromBackend(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      try {
        const result = await (window as any).neox?.getExplorerSettings?.();
        if (result?.success && result.settings) {
          this.state = { ...defaultSettings, ...result.settings };
        }
      } catch (e) {
        console.warn('[explorerSettings] failed to load from backend, using defaults:', e);
      } finally {
        this.loaded = true;
        this.notify();
      }
    })();
    return this.loadPromise;
  }

  /** 同步获取当前 state(可能还没从后端加载完) */
  get(): ExplorerSettings {
    return this.state;
  }

  /** 是否已经从 SQLite 加载完成 */
  isLoaded(): boolean {
    return this.loaded;
  }

  /** 等待加载完成 */
  async waitLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) await this.loadPromise;
  }

  /** 设置单个字段 */
  set<K extends keyof ExplorerSettings>(key: K, value: ExplorerSettings[K]): void {
    this.state = { ...this.state, [key]: value };
    this.notify();
    this.persistToBackend();
  }

  /** 切换布尔字段 */
  toggle<K extends keyof ExplorerSettings>(key: K): void {
    if (typeof this.state[key] === 'boolean') {
      this.set(key, !this.state[key] as ExplorerSettings[K]);
    }
  }

  /** 重置到默认值 */
  reset(): void {
    this.state = { ...defaultSettings };
    this.notify();
    this.persistToBackend();
  }

  private async persistToBackend(): Promise<void> {
    try {
      await (window as any).neox?.setExplorerSettings?.(this.state);
    } catch (e) {
      console.error('[explorerSettings] failed to persist to backend:', e);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

export const explorerSettings = new ExplorerSettingsStore();

/** React hook 包装 */
import { useEffect, useState } from 'react';

export function useExplorerSettings(): ExplorerSettings {
  const [state, setState] = useState<ExplorerSettings>(() => explorerSettings.get());
  useEffect(() => {
    return explorerSettings.subscribe(setState);
  }, []);
  return state;
}
