/**
 * EditorService —— 编辑器标签页 / 文档状态的单一权威。
 *
 * 设计目标
 * --------
 * 1. **行为对齐 useEditorTabs**：本类逐字保留 React Hook 版本的全部公开行为，
 *    包括关闭/激活的优先级、脏标记、保存/批量保存的细节。
 *    这是 step 2 的硬约束 —— 后续 React 层接入时不允许引入任何行为漂移。
 * 2. **同步 mutation**：状态修改立即生效（不像 React 那样异步批处理）。
 *    这让 useEditorTabs 里的 `pendingFileTabsRef` 防重复 workaround 完全不再
 *    需要 —— 同步调用第二次时，第一次的 tab 已经在状态里了。
 * 3. **依赖端口**：FileSystemPort 注入，service 不知道 `window.neox` 的存在；
 *    单测可以注入 InMemoryFileSystem，跑在 node 环境无障碍。
 * 4. **双订阅通道**：
 *      - subscribe(() => void) — 给 useSyncExternalStore 用的"有变化"信号
 *      - MessageBus（可选） — 类型化的语义事件，给跨组件协调用
 *
 * 状态不变式
 * ---------
 * - tabs 中元素 id 唯一
 * - tabs 中元素 path 唯一（同一文件不会被打开两次）
 * - activeTabId 要么是 null，要么对应 tabs 中存在的某个 id
 * - tabs 为空 ⇒ activeTabId === null
 * - isDirty === (content !== originalContent)
 *
 * 这些不变式由本类的所有 mutation 路径保证；测试有专门的 invariant 用例。
 */

import type { MessageBus, Unsubscribe } from '../bus/MessageBus.js';
import type { VfsService } from '../vfs/VfsService.js';
import { FILES_TOPIC } from '../vfs/types.js';
import type { FileChangeEvent } from '../vfs/types.js';
import { EDITOR_TOPIC } from './types.js';
import type { EditorEvents, EditorState, EditorTab } from './types.js';
import { HUGE_FILE_BYTES } from '@neoxlabs/platform/shared/largeFile/thresholds.js';

export interface EditorServiceOptions {
  /** VirtualFileSystem —— 编辑器通过这一层做所有读写，事件也从这里来 */
  vfs: VfsService;
  /**
   * MessageBus。**必填** —— EditorService 需要订阅 FILES_TOPIC 来感知
   * 外部改动（agent 写文件 / 文件 watcher / 等等），并继续把自己的语义
   * 事件发布到 EDITOR_TOPIC。
   */
  bus: MessageBus;
  /**
   * id 生成器。默认基于 Date.now + 随机后缀。
   * 测试可以注入一个确定性 generator 让断言变简单。
   */
  idGenerator?: () => string;
}

const defaultIdGenerator = (): string =>
  `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const basename = (filePath: string): string => {
  const segs = filePath.split('/');
  return segs[segs.length - 1] || filePath;
};

export class EditorService {
  private readonly vfs: VfsService;
  private readonly bus: MessageBus;
  private readonly idGenerator: () => string;
  private readonly listeners = new Set<() => void>();
  private readonly vfsUnsubscribe: Unsubscribe;

  // 内部状态：使用可变的工作副本 + 在 mutate 末尾发布"不可变快照"
  private tabs: EditorTab[] = [];
  private activeTabId: string | null = null;
  private selectedFilePath: string | null = null;

  /** 已关闭 tab 的栈 —— 用于 Cmd+Shift+T "Reopen Closed Tab" */
  private closedTabsStack: Array<{ path: string; content: string }> = [];
  private static readonly MAX_CLOSED_STACK = 30;

  /**
   * 性能优化：path → tab 的反向索引，让 onChanged 事件能 O(1) 找到要刷新的 tab。
   * 由 commit() 在每次状态变更时同步重建，跟 snapshot 一起更新。
   */
  private pathIndex: Map<string, EditorTab> = new Map();

  /**
   * 缓存的不可变快照。每次 mutation 重建一次，listeners 调 getState() 拿这个。
   * 这样 React useSyncExternalStore 的 getSnapshot 引用稳定，不会无谓 re-render。
   */
  private snapshot: EditorState = { tabs: [], activeTabId: null, selectedFilePath: null };

  /**
   * 标记"我自己刚发起了一次 read"的路径集合 —— 异步 reload 期间防止
   * 同一个路径的事件触发重叠的 reload 任务。
   *
   * 注意：跟 source='editor' 不一样。source 防的是"自己 save 触发自己 reload"，
   * 这个集合防的是"外部高频改动期间，多个 onChanged 事件同时在跑同一个文件
   * 的 reload"。
   */
  private reloadingPaths: Set<string> = new Set();

  // ============================================================================
  // Auto-save
  // ============================================================================
  /**
   * 每个 tab 的 pending auto-save timer. updateContent 时重置, 时间到就 save.
   *
   * 默认开启 (1s debounce). 透明 —— 用户不用感知, 但 agent 正在流式写的 tab
   * (tab.streaming === true) 会被跳过.
   */
  private autoSaveEnabled = true;
  private autoSaveDelayMs = 1000;
  private autoSaveTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(options: EditorServiceOptions) {
    this.vfs = options.vfs;
    this.bus = options.bus;
    this.idGenerator = options.idGenerator ?? defaultIdGenerator;

    // 订阅 VFS 的文件变更事件 —— 任何外部对文件的修改都会走到这里
    this.vfsUnsubscribe = this.bus.subscribe(FILES_TOPIC, {
      onChanged: (event) => this.onVfsChanged(event),
      onDeleted: (event) => this.onVfsDeleted(event),
    });
  }

  // ---- Auto-save 配置 API ------------------------------------------------

  setAutoSave(options: { enabled?: boolean; delayMs?: number }): void {
    if (typeof options.enabled === 'boolean') this.autoSaveEnabled = options.enabled;
    if (typeof options.delayMs === 'number' && options.delayMs >= 0) {
      this.autoSaveDelayMs = options.delayMs;
    }
    if (!this.autoSaveEnabled) {
      for (const t of this.autoSaveTimers.values()) clearTimeout(t);
      this.autoSaveTimers.clear();
    }
  }

  getAutoSaveConfig(): { enabled: boolean; delayMs: number } {
    return { enabled: this.autoSaveEnabled, delayMs: this.autoSaveDelayMs };
  }

  /** 一个 tab 是否可 auto-save: 有 path, 不是 diff tab, 不是大文件, 不是流式写入. */
  private isAutoSavable(tab: EditorTab): boolean {
    if (!this.autoSaveEnabled) return false;
    if (!tab.path || tab.path.startsWith('diff://')) return false;
    if (tab.largeFile) return false;
    if (tab.diffMode) return false;
    if (tab.streaming) return false;
    if (tab.conflict) return false; // 有冲突, 等用户决定后再存
    if (!tab.isDirty) return false;
    return true;
  }

  private scheduleAutoSave(tabId: string): void {
    if (this.autoSaveDelayMs === 0) {
      // 直接同步 save (测试场景可能用)
      void this.save(tabId);
      return;
    }
    const prev = this.autoSaveTimers.get(tabId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.autoSaveTimers.delete(tabId);
      const current = this.getTab(tabId);
      if (!current || !this.isAutoSavable(current)) return;
      void this.save(tabId);
    }, this.autoSaveDelayMs);
    this.autoSaveTimers.set(tabId, timer);
  }

  private cancelAutoSave(tabId: string): void {
    const t = this.autoSaveTimers.get(tabId);
    if (t) {
      clearTimeout(t);
      this.autoSaveTimers.delete(tabId);
    }
  }

  /**
   * 释放本 service 的资源（取消 VFS 订阅、清空 listeners）。
   * WorkspacePlatformProvider 在 dispose 时会调这里。
   */
  dispose(): void {
    for (const t of this.autoSaveTimers.values()) clearTimeout(t);
    this.autoSaveTimers.clear();
    this.vfsUnsubscribe();
    this.listeners.clear();
  }

  // ============================================================================
  // 订阅 & 状态查询
  // ============================================================================

  /** 拿当前状态的不可变快照 */
  getState(): EditorState {
    return this.snapshot;
  }

  /**
   * 订阅"状态有变化"信号。返回取消订阅函数。
   * 给 React useSyncExternalStore 用，listener 不接收任何参数 —— 调用方应该
   * 自己再 getState() 拿最新快照。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ===== 派生查询（纯函数，不发布事件） =====

  getTab(tabId: string): EditorTab | undefined {
    return this.tabs.find((t) => t.id === tabId);
  }

  getTabByPath(filePath: string): EditorTab | undefined {
    return this.tabs.find((t) => t.path === filePath);
  }

  getActiveTab(): EditorTab | undefined {
    if (!this.activeTabId) return undefined;
    return this.getTab(this.activeTabId);
  }

  // ============================================================================
  // 打开 / 流式打开
  // ============================================================================

  /**
   * 通过文件系统读文件并打开标签。
   * 对应 useEditorTabs.handleSelectFile。
   *
   * - 设置 selectedFilePath（即使打开失败也设）
   * - 已存在的 tab → 激活它，返回它
   * - 不存在 → 读文件，成功就创建并激活；失败发 onError 事件，返回 null
   */
  async openFile(
    filePath: string,
    opts?: { line?: number; column?: number },
  ): Promise<EditorTab | null> {
    this.setSelectedFilePathInternal(filePath);

    const existing = this.getTabByPath(filePath);
    if (existing) {
      this.setActiveTabIdInternal(existing.id);
      this.commit();
      /* Wave 11: tab 已开 → 重新激活后立刻 reveal. opts 没 line 时不发, 老 caller 行为不变. */
      if (opts?.line && opts.line > 0) {
        this.bus.publisher(EDITOR_TOPIC).onRevealRequested({
          tabId: existing.id,
          line: opts.line,
          column: opts.column,
        });
      }
      return existing;
    }

    // 二进制媒体文件 (图片/视频/音频/PDF/Office/字体) 跳过 utf-8 读取 —— 它们
    // 会被 MediaViewer 通过 IPC 单独以 data URL 方式加载, 避免把 10MB 的
    // PNG 读成一个 10MB 的错乱字符串堆在 tab.content 里.
    const BINARY_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|mp4|webm|mov|mkv|m4v|ogv|mp3|wav|ogg|flac|aac|m4a|opus|pdf|docx?|docm|rtf|odt|pptx?|pptm|ppsx?|ppsm|potx?|potm|odp|key|woff2?|ttf|otf|eot)$/i;
    const isBinary = BINARY_EXT_RE.test(filePath);

    // 大文件闸门 —— stat 先行, 超阈值不走 readFile 全量, 改用分页 viewer.
    // 对应 IntelliJ FileSizeLimit.isTooLargeForContentLoading.
    let largeFileMeta: { size: number } | undefined;
    if (!isBinary) {
      try {
        const st = await this.vfs.stat(filePath);
        if (st.success && st.isFile !== false && typeof st.size === 'number' && st.size > HUGE_FILE_BYTES) {
          largeFileMeta = { size: st.size };
        }
      } catch { /* stat 不支持或失败, 回退到读全文 */ }
    }

    let content = '';
    if (!isBinary && !largeFileMeta) {
      const result = await this.vfs.readFile(filePath);
      if (!result.success) {
        // selectedFilePath 已经被设了；只需要 commit + 发错误
        this.commit();
        this.bus.publisher(EDITOR_TOPIC).onError({
          kind: 'open',
          path: filePath,
          error: result.error,
        });
        return null;
      }
      content = result.content ?? '';
    }
    const newTab: EditorTab = {
      id: this.idGenerator(),
      path: filePath,
      name: basename(filePath),
      content,
      originalContent: content,
      isDirty: false,
      ...(largeFileMeta ? { largeFile: largeFileMeta } : {}),
    };
    this.tabs = [...this.tabs, newTab];
    this.activeTabId = newTab.id;
    this.commit();
    this.bus.publisher(EDITOR_TOPIC).onTabOpened(newTab);
    this.bus.publisher(EDITOR_TOPIC).onTabActivated(newTab);
    /* Wave 11: 新 tab 也 reveal — Monaco mount 后 EditorTabs state 把 prop 传过去 */
    if (opts?.line && opts.line > 0) {
      this.bus.publisher(EDITOR_TOPIC).onRevealRequested({
        tabId: newTab.id,
        line: opts.line,
        column: opts.column,
      });
    }
    return newTab;
  }

  /**
   * 打开一个 diff tab（Git 差异查看 / 历史对比）。
   * 不读磁盘，直接把 original + modified 内容放进 tab。
   */
  openDiffTab(options: {
    title: string;
    originalContent: string;
    modifiedContent: string;
    originalLabel?: string;
    modifiedLabel?: string;
    language?: string;
  }): EditorTab {
    const newTab: EditorTab = {
      id: this.idGenerator(),
      path: `diff://${options.title}`,
      name: options.title,
      content: options.modifiedContent,
      originalContent: options.originalContent,
      isDirty: false,
      language: options.language,
      diffMode: {
        originalContent: options.originalContent,
        modifiedContent: options.modifiedContent,
        originalLabel: options.originalLabel,
        modifiedLabel: options.modifiedLabel,
      },
    };
    this.tabs = [...this.tabs, newTab];
    this.activeTabId = newTab.id;
    this.commit();
    this.bus.publisher(EDITOR_TOPIC).onTabOpened(newTab);
    this.bus.publisher(EDITOR_TOPIC).onTabActivated(newTab);
    return newTab;
  }

  openOrUpdateStreamingFile(
    filePath: string,
    content: string,
    isComplete: boolean,
    options?: { updateOnly?: boolean },
  ): EditorTab | null {
    const existing = this.getTabByPath(filePath);

    if (existing) {
      this.setSelectedFilePathInternal(filePath);
      const updated: EditorTab = {
        ...existing,
        content,
        originalContent: isComplete ? content : existing.originalContent,
        isDirty: isComplete ? false : content !== existing.originalContent,
        streaming: !isComplete,
      };
      this.replaceTab(updated);
      this.setActiveTabIdInternal(updated.id);
      this.commit();
      this.bus.publisher(EDITOR_TOPIC).onTabContentChanged(updated);
      // 流式开始 → 取消可能已挂在这个 tab 上的 auto-save timer;
      // 流式完成 (isComplete) → 清理 streaming 后, 如果 still dirty 才调度 (正常不会)
      if (!isComplete) this.cancelAutoSave(updated.id);
      return updated;
    }

    // 没有已开的 tab + updateOnly → 不自动创建, 让用户自己点卡片决定要不要看
    if (options?.updateOnly) {
      return null;
    }

    this.setSelectedFilePathInternal(filePath);
    // 新 tab：流式中 originalContent 留空（跟 hook 版一致），完成时同步为 content
    const newTab: EditorTab = {
      id: this.idGenerator(),
      path: filePath,
      name: basename(filePath),
      content,
      originalContent: isComplete ? content : '',
      isDirty: !isComplete,
      streaming: !isComplete,
    };
    this.tabs = [...this.tabs, newTab];
    this.activeTabId = newTab.id;
    this.commit();
    this.bus.publisher(EDITOR_TOPIC).onTabOpened(newTab);
    this.bus.publisher(EDITOR_TOPIC).onTabActivated(newTab);
    return newTab;
  }

  // ============================================================================
  // 选中 / 关闭
  // ============================================================================

  /** 对应 useEditorTabs.handleEditorTabSelect */
  selectTab(tabId: string): void {
    const tab = this.getTab(tabId);
    if (!tab) return;
    this.activeTabId = tabId;
    this.selectedFilePath = tab.path;
    this.commit();
    this.bus.publisher(EDITOR_TOPIC).onTabActivated(tab);
  }

  /**
   * 对应 useEditorTabs.handleEditorTabClose。
   *
   * 行为细节（跟 hook 版严格一致）：
   * - 如果关掉的是当前活动 tab 且仍有剩余 → 切到剩余的最后一个（不是下一个！）
   * - 如果关空 → activeTabId = null，selectedFilePath = null
   */
  closeTab(tabId: string): void {
    const target = this.getTab(tabId);
    if (!target) return;
    this.cancelAutoSave(tabId);

    // 压入 closed stack 以支持 Reopen
    this.closedTabsStack.push({ path: target.path, content: target.content });
    if (this.closedTabsStack.length > EditorService.MAX_CLOSED_STACK) {
      this.closedTabsStack.shift();
    }

    const filtered = this.tabs.filter((t) => t.id !== tabId);
    const wasActive = this.activeTabId === tabId;

    this.tabs = filtered;
    if (filtered.length === 0) {
      this.activeTabId = null;
      this.selectedFilePath = null;
    } else if (wasActive) {
      const next = filtered[filtered.length - 1];
      this.activeTabId = next.id;
      this.selectedFilePath = next.path;
    }
    this.commit();
    this.bus.publisher(EDITOR_TOPIC).onTabClosed({ tabId, path: target.path });
    if (filtered.length === 0) {
      this.bus.publisher(EDITOR_TOPIC).onAllTabsClosed();
    }
  }

  /** 对应 useEditorTabs.handleCloseOthers —— 尊重 pinned tab */
  closeOthers(tabId: string): void {
    const target = this.getTab(tabId);
    if (!target) return;
    const closedTabs = this.tabs.filter((t) => t.id !== tabId && !t.pinned);
    const kept = this.tabs.filter((t) => t.id === tabId || t.pinned);
    this.tabs = kept;
    this.activeTabId = tabId;
    this.selectedFilePath = target.path;
    this.commit();
    for (const closed of closedTabs) {
      this.closedTabsStack.push({ path: closed.path, content: closed.content });
      this.bus.publisher(EDITOR_TOPIC).onTabClosed({ tabId: closed.id, path: closed.path });
    }
  }

  /** 对应 useEditorTabs.handleCloseAll —— 尊重 pinned tab */
  closeAll(): void {
    if (this.tabs.length === 0) return;
    const pinnedTabs = this.tabs.filter((t) => t.pinned);
    const closedTabs = this.tabs.filter((t) => !t.pinned);
    this.tabs = pinnedTabs;
    if (pinnedTabs.length > 0) {
      const last = pinnedTabs[pinnedTabs.length - 1];
      this.activeTabId = last.id;
      this.selectedFilePath = last.path;
    } else {
      this.activeTabId = null;
      this.selectedFilePath = null;
    }
    this.commit();
    for (const closed of closedTabs) {
      this.closedTabsStack.push({ path: closed.path, content: closed.content });
      this.bus.publisher(EDITOR_TOPIC).onTabClosed({ tabId: closed.id, path: closed.path });
    }
    if (this.tabs.length === 0) {
      this.bus.publisher(EDITOR_TOPIC).onAllTabsClosed();
    }
  }

  /**
   * 对应 useEditorTabs.handleCloseSaved。
   *
   * 关闭所有非脏 tab；如果当前活动 tab 被关掉了，切到剩余脏 tab 中的第一个；
   * 如果一个脏 tab 都没有，全清。
   */
  closeSaved(): void {
    const unsaved = this.tabs.filter((t) => t.isDirty);
    const closed = this.tabs.filter((t) => !t.isDirty);
    if (closed.length === 0) return;

    this.tabs = unsaved;
    if (unsaved.length === 0) {
      this.activeTabId = null;
      this.selectedFilePath = null;
    } else {
      const currentStillAlive = unsaved.some((t) => t.id === this.activeTabId);
      if (!currentStillAlive) {
        this.activeTabId = unsaved[0].id;
        this.selectedFilePath = unsaved[0].path;
      }
    }
    this.commit();
    for (const c of closed) {
      this.bus.publisher(EDITOR_TOPIC).onTabClosed({ tabId: c.id, path: c.path });
    }
    if (unsaved.length === 0) {
      this.bus.publisher(EDITOR_TOPIC).onAllTabsClosed();
    }
  }

  /**
   * 对应 useEditorTabs.handleCloseToRight。
   *
   * 注：原 hook 版**不更新 activeTabId** —— 如果 active 在被关掉的右侧，
   * 这是个潜在 bug，但 step 2 严格保留行为，不在这里修。后续在专门的"行为
   * 修正"PR 里处理。
   */
  closeToRight(tabId: string): void {
    const index = this.tabs.findIndex((t) => t.id === tabId);
    if (index < 0) return;
    const closed = this.tabs.slice(index + 1);
    if (closed.length === 0) return;
    this.tabs = this.tabs.slice(0, index + 1);
    this.commit();
    for (const c of closed) {
      this.bus.publisher(EDITOR_TOPIC).onTabClosed({ tabId: c.id, path: c.path });
    }
  }

  // ============================================================================
  // 内容 / 保存
  // ============================================================================

  /**
   * 对应 useEditorTabs.handleEditorContentChange。
   *
   * isDirty 的判定严格按 content !== originalContent —— 用户改回原样会自动变 clean。
   */
  updateContent(tabId: string, content: string): void {
    const tab = this.getTab(tabId);
    if (!tab) return;
    if (tab.content === content) return; // 真的没变 → 不发事件，不 re-render
    const updated: EditorTab = {
      ...tab,
      content,
      isDirty: content !== tab.originalContent,
    };
    this.replaceTab(updated);
    this.commit();
    this.bus.publisher(EDITOR_TOPIC).onTabContentChanged(updated);
    // Auto-save: 只在用户编辑路径触发 (updateContent 就是用户路径).
    // 流式 tab / 大文件 / 冲突 tab 在 isAutoSavable 里已屏蔽.
    if (this.isAutoSavable(updated)) {
      this.scheduleAutoSave(tabId);
    } else {
      this.cancelAutoSave(tabId);
    }
  }

  /**
   * 对应 useEditorTabs.handleEditorSave。
   * 写磁盘成功 → 把 originalContent 同步为 content，isDirty 置 false。
   * 失败 → 状态不变，发 onError 事件，返回 false。
   */
  async save(tabId: string): Promise<boolean> {
    const tab = this.getTab(tabId);
    if (!tab) return false;

    if (tab.path && !tab.path.startsWith('diff://') && !tab.largeFile) {
      const disk = await this.vfs.readFile(tab.path);
      if (disk.success) {
        const diskContent = disk.content ?? '';
        if (diskContent !== tab.originalContent && diskContent !== tab.content) {
          const conflicted: EditorTab = { ...tab, conflict: { diskContent, detectedAt: Date.now() } };
          this.replaceTab(conflicted);
          this.commit();
          this.bus.publisher(EDITOR_TOPIC).onExternalConflict(conflicted);
          this.bus.publisher(EDITOR_TOPIC).onTabContentChanged(conflicted);
          return false;
        }
      }
    }

    // 避免"自己 save 触发自己 reload"的循环
    const result = await this.vfs.writeFile(tab.path, tab.content, { source: 'editor' });
    if (!result.success) {
      this.bus.publisher(EDITOR_TOPIC).onError({
        kind: 'save',
        path: tab.path,
        error: result.error,
      });
      return false;
    }
    // 拿 mutation 时的最新版本（防止保存期间内容又被改了 —— 此时仍按当时写入的算 clean）
    const current = this.getTab(tabId);
    if (!current) return true;
    const writtenContent = tab.content;
    const updated: EditorTab = {
      ...current,
      originalContent: writtenContent,
      isDirty: current.content !== writtenContent,
    };
    this.replaceTab(updated);
    this.commit();
    this.bus.publisher(EDITOR_TOPIC).onTabSaved(updated);
    return true;
  }

  /**
   * 另存为 —— 把当前 tab 的内容写到一个新路径, 然后把新文件作为 tab 打开并激活。
   * 原 tab 保持不变 (跟主流编辑器一致: Save As 产出一份副本/新文件, 不改原文件)。
   * newPath 由 caller 通过 saveFileDialog 选定。diff tab 不适用。
   */
  async saveAs(tabId: string, newPath: string): Promise<boolean> {
    const tab = this.getTab(tabId);
    if (!tab || tab.diffMode) return false;
    const result = await this.vfs.writeFile(newPath, tab.content, { source: 'editor' });
    if (!result.success) {
      this.bus.publisher(EDITOR_TOPIC).onError({
        kind: 'save',
        path: newPath,
        error: result.error,
      });
      return false;
    }
    // 落盘成功后把新文件作为 tab 打开 (已存在则激活); 内容刚写过, 读回即 originalContent。
    await this.openFile(newPath);
    return true;
  }

  revertTab(tabId: string): void {
    const tab = this.getTab(tabId);
    if (!tab || tab.diffMode) return;
    if (tab.content === tab.originalContent) return; // 本来就干净
    const updated: EditorTab = { ...tab, content: tab.originalContent, isDirty: false };
    this.replaceTab(updated);
    this.commit();
    this.bus.publisher(EDITOR_TOPIC).onTabContentChanged(updated);
  }

  /**
   * 对应 useEditorTabs.handleSaveAll。
   *
   * 串行保存所有脏 tab。任一失败不影响其他（错误通过 onError 事件汇报）。
   * 跟原版一样，失败的 tab 状态保持脏。
   */
  async saveAll(): Promise<void> {
    // 用 path 列表而不是 tab 引用快照，因为保存间隙状态可能变化
    const dirtyIds = this.tabs.filter((t) => t.isDirty).map((t) => t.id);
    for (const id of dirtyIds) {
      await this.save(id);
    }
  }

  // ============================================================================
  // 选中文件路径（可独立于 active tab）
  // ============================================================================

  /** 显式设置 selectedFilePath（Project View 在没打开 tab 时也能高亮当前选中文件） */
  setSelectedFilePath(path: string | null): void {
    if (this.selectedFilePath === path) return;
    this.selectedFilePath = path;
    this.commit();
  }

  // ============================================================================
  // 内部工具
  // ============================================================================

  private setSelectedFilePathInternal(path: string | null): void {
    this.selectedFilePath = path;
  }

  private setActiveTabIdInternal(tabId: string | null): void {
    this.activeTabId = tabId;
  }

  private replaceTab(updated: EditorTab): void {
    this.tabs = this.tabs.map((t) => (t.id === updated.id ? updated : t));
  }

  /**
   * 重建 snapshot 并通知所有订阅者。
   * 所有 mutation 路径都必须以 commit() 结束 —— 这是状态一致性的核心。
   */
  private commit(): void {
    this.snapshot = {
      tabs: this.tabs.slice(),
      activeTabId: this.activeTabId,
      selectedFilePath: this.selectedFilePath,
    };
    // 重建 path → tab 反向索引，O(tabs) 很小
    this.pathIndex = new Map(this.tabs.map((t) => [t.path, t]));
    // 复制 listener 集合，避免某个 listener 在回调里 unsubscribe 影响迭代
    const snapshot = [...this.listeners];
    for (const listener of snapshot) {
      try {
        listener();
      } catch (err) {
        console.error('[EditorService] listener threw:', err);
      }
    }
    this.bus.publisher(EDITOR_TOPIC).onStateChanged(this.snapshot);
  }

  // ============================================================================
  // VFS 事件处理 —— 外部改动 → 编辑器感知
  // ============================================================================

  /**
   * VFS 发出 onChanged（某文件被写入了）—— 处理逻辑：
   *
   * 1. source === 'editor' → 跳过。这是我们自己 save 触发的。
   * 2. 没有匹配的 tab → 跳过。文件没被打开，编辑器不需要做什么。
   * 3. tab 是 dirty → 跳过。用户有未保存的修改，不覆盖。
   *    （未来可以在这里发一个 onExternalConflict 事件给 toast 层）
   * 4. clean tab → 从 VFS 重新读内容，刷新 tab。
   */
  private onVfsChanged(event: FileChangeEvent): void {
    if (event.source === 'editor') return;
    const tab = this.pathIndex.get(event.path);
    if (!tab) return;

    // Dirty tab + 外部改动 → 冲突.
    // 也以为它写进去了). 现在读一次磁盘, 把 diskContent 挂在 tab 上,
    // UI 会显示冲突 banner 让用户选.
    if (tab.isDirty) {
      if (this.reloadingPaths.has(event.path)) return;
      void this.detectConflict(tab);
      return;
    }

    if (this.reloadingPaths.has(event.path)) return;

    // 非 dirty → 直接 reload (跟之前一致)
    void this.reloadTab(tab);
  }

  /**
   * Dirty tab 遭外部改动 → 读磁盘拿最新内容, 更新 tab.conflict 供 UI 渲染.
   * 如果 disk 内容跟 tab.content 或 tab.originalContent 一致 (说明没真冲突,
   * 比如 agent 写的就是用户也要写的那一段), 就无操作.
   */
  private async detectConflict(tab: EditorTab): Promise<void> {
    if (tab.largeFile) return; // 大文件不适用
    this.reloadingPaths.add(tab.path);
    try {
      const result = await this.vfs.readFile(tab.path);
      if (!result.success) return;
      const diskContent = result.content ?? '';
      const current = this.pathIndex.get(tab.path);
      if (!current) return;
      // 用户已保存或解决 → 不报冲突
      if (!current.isDirty) return;
      // 已有 conflict 且内容一致 → 不重复触发
      if (current.conflict && current.conflict.diskContent === diskContent) return;
      // 磁盘内容 === 用户当前内容 → 没有真冲突 (用户和外部恰好写成一样).
      // 把 originalContent 同步为 disk 版本, isDirty 自然清掉.
      if (diskContent === current.content) {
        if (current.originalContent !== diskContent || current.isDirty || current.conflict) {
          const cleared: EditorTab = {
            ...current,
            originalContent: diskContent,
            isDirty: false,
            conflict: undefined,
          };
          this.replaceTab(cleared);
          this.commit();
          this.bus.publisher(EDITOR_TOPIC).onTabContentChanged(cleared);
        }
        return;
      }
      const updated: EditorTab = {
        ...current,
        conflict: { diskContent, detectedAt: Date.now() },
      };
      this.replaceTab(updated);
      this.commit();
      this.bus.publisher(EDITOR_TOPIC).onExternalConflict(updated);
      this.bus.publisher(EDITOR_TOPIC).onTabContentChanged(updated);
    } finally {
      this.reloadingPaths.delete(tab.path);
    }
  }

  // ============================================================================
  // 冲突解决 (UI 调这三个方法)
  // ============================================================================

  /**
   * 保留用户修改, 把 originalContent 更新成 disk 版本.
   * 下次 save 就会覆盖 disk 上的外部改动.
   */
  resolveConflictKeepMine(tabId: string): void {
    const tab = this.getTab(tabId);
    if (!tab || !tab.conflict) return;
    const updated: EditorTab = {
      ...tab,
      originalContent: tab.conflict.diskContent,
      isDirty: tab.content !== tab.conflict.diskContent,
      conflict: undefined,
    };
    this.replaceTab(updated);
    this.commit();
    this.bus.publisher(EDITOR_TOPIC).onTabContentChanged(updated);
  }

  /**
   * 采用磁盘版本, 放弃用户的未保存修改.
   */
  resolveConflictUseTheirs(tabId: string): void {
    const tab = this.getTab(tabId);
    if (!tab || !tab.conflict) return;
    const diskContent = tab.conflict.diskContent;
    const updated: EditorTab = {
      ...tab,
      content: diskContent,
      originalContent: diskContent,
      isDirty: false,
      conflict: undefined,
    };
    this.replaceTab(updated);
    this.commit();
    this.bus.publisher(EDITOR_TOPIC).onTabContentChanged(updated);
  }

  /**
   * 打开一个 diff tab 让用户手动合并.
   * 原 tab 不动 —— 用户看完 diff 可以回来手动 merge 或选另一个方案.
   */
  resolveConflictShowDiff(tabId: string): EditorTab | null {
    const tab = this.getTab(tabId);
    if (!tab || !tab.conflict) return null;
    return this.openDiffTab({
      title: `${basename(tab.path)} (conflict)`,
      originalContent: tab.conflict.diskContent,
      modifiedContent: tab.content,
      originalLabel: 'On disk',
      modifiedLabel: 'Your changes',
      language: tab.language,
    });
  }

  /**
   * VFS 发出 onDeleted —— 对于已打开的 tab，不自动关闭（用户可能想保留
   * 编辑内容），但标记为 dirty（磁盘上已经没了，保存时会重建文件）。
   *
   * 这个行为跟 VSCode 一致：文件被外部删除后，tab 会显示"已删除"，内容
   * 保留让用户决定要不要保存。
   */
  private onVfsDeleted(event: FileChangeEvent): void {
    if (event.source === 'editor') return;
    const tab = this.pathIndex.get(event.path);
    if (!tab) return;
    if (tab.isDirty) return; // 已经脏了，不用动
    const updated: EditorTab = { ...tab, isDirty: true, originalContent: '' };
    this.replaceTab(updated);
    this.commit();
    this.bus.publisher(EDITOR_TOPIC).onTabContentChanged(updated);
  }

  /**
   * 重新从 VFS 读文件内容并刷新 tab。
   *
   * 用 reloadingPaths 去重：同一路径不会并发 reload。
   */
  private async reloadTab(tab: EditorTab): Promise<void> {
    // 大文件 tab 不持有完整内容 —— 文件变更就让 viewer 自己 refetch 分页即可,
    // 不要把数十 MB 的全量内容塞进 tab.content.
    if (tab.largeFile) return;
    this.reloadingPaths.add(tab.path);
    try {
      const result = await this.vfs.readFile(tab.path);
      if (!result.success) return;
      const content = result.content ?? '';
      // re-lookup —— 在 await 期间 tab 可能已经被关掉了
      const current = this.pathIndex.get(tab.path);
      if (!current) return;
      if (current.isDirty) return; // 在 await 期间变脏了，不覆盖
      if (current.content === content) return; // 内容没变
      const updated: EditorTab = {
        ...current,
        content,
        originalContent: content,
        isDirty: false,
      };
      this.replaceTab(updated);
      this.commit();
      this.bus.publisher(EDITOR_TOPIC).onTabContentChanged(updated);
    } finally {
      this.reloadingPaths.delete(tab.path);
    }
  }

  // --------------------------------------------------------------------------
  // Pin / Unpin / Reopen Closed (IDEA Tab Management)
  // --------------------------------------------------------------------------

  /** 钉住一个 tab —— 钉住的 tab 不会被 closeOthers / closeAll / closeSaved 关掉 */
  pinTab(tabId: string): void {
    const tab = this.getTab(tabId);
    if (!tab || tab.pinned) return;
    const updated: EditorTab = { ...tab, pinned: true, preview: false };
    this.replaceTab(updated);
    this.commit();
  }

  /** 取消钉住 */
  unpinTab(tabId: string): void {
    const tab = this.getTab(tabId);
    if (!tab || !tab.pinned) return;
    const updated: EditorTab = { ...tab, pinned: false };
    this.replaceTab(updated);
    this.commit();
  }

  /** 切换钉住状态 */
  togglePin(tabId: string): void {
    const tab = this.getTab(tabId);
    if (!tab) return;
    tab.pinned ? this.unpinTab(tabId) : this.pinTab(tabId);
  }

  /**
   * 重新打开最后关闭的 tab (Cmd+Shift+T)。
   * 返回被重新打开的文件路径，调用方负责实际加载。
   */
  reopenClosedTab(): string | null {
    if (this.closedTabsStack.length === 0) return null;
    const last = this.closedTabsStack.pop()!;
    // 如果这个文件已经打开了（比如在关闭后用户又手动打开了），跳过
    if (this.tabs.some((t) => t.path === last.path)) {
      return last.path; // 已打开，只返回路径让调用方激活
    }
    return last.path;
  }

  /** 获取 closed stack 的长度（UI 显示"可 reopen N 个"） */
  getClosedTabCount(): number {
    return this.closedTabsStack.length;
  }
}
