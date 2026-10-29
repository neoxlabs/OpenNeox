/**
 * Editor 平台层类型定义
 *
 * 这一层只描述"标签页 / 文档 / 文件"的抽象，跟 Monaco 无关、跟 React 无关、
 * 跟 Electron 无关。具体编辑器实现（Monaco / NotebookEditor / 图片预览…）
 * 是 EditorService 的消费者。
 */

import { createServiceToken } from '../container/ServiceContainer.js';
import { createTopic } from '../bus/MessageBus.js';
import type { ServiceToken } from '../container/ServiceContainer.js';
import type { Topic } from '../bus/MessageBus.js';

/**
 * 一个被打开的文件的最小完整状态。
 *
 * 字段语义跟 useEditorTabs.ts 里的 EditorTab 完全对齐 —— 这是 step 2 的硬约束，
 * 后续 React 层接入时不需要任何字段映射。
 */
export interface EditorTab {
  /** 唯一 id，由 EditorService 生成 */
  id: string;
  /** 绝对路径或相对 workspace 的路径（由调用方决定） */
  path: string;
  /** 用于 tab 标题显示，等同 path 的 basename */
  name: string;
  /** 当前内存中的内容（可能脏） */
  content: string;
  originalContent: string;
  /** content !== originalContent */
  isDirty: boolean;
  /** Monaco language id 的可选 override；空时由编辑器组件按扩展名推导 */
  language?: string;
  /** 钉住 —— pinned tab 不会被 closeOthers / closeSaved / closeAll 关掉 */
  pinned?: boolean;
  /** Preview tab —— 单击文件树打开的预览 tab，再打开新文件时会被替换 */
  preview?: boolean;
  /** Diff 模式 —— 在编辑器中以并排 diff 显示 */
  diffMode?: {
    originalContent: string;
    modifiedContent: string;
    originalLabel?: string;
    modifiedLabel?: string;
  };
  /**
   * 大文件标记 —— 文件字节数超过 HUGE_FILE_BYTES (20MB) 时设置.
   * 这种 tab 的 content 始终为空字符串, 不读入内存.
   * Render 层根据此字段跳过 Monaco, 改用分页 LargeFileViewer (IntelliJ 风格).
   * isDirty / originalContent / save 等字段对它无效.
   */
  largeFile?: {
    /** 文件字节数 (stat 时拿到) */
    size: number;
  };

  /**
   * 外部冲突 —— 用户有 dirty 未保存, 磁盘被其他进程 (agent / 另一个编辑器)
   * 改了. 对应 VSCode 的 "File has been changed on disk" 提示.
   *
   * 解决路径 (由 UI 调 EditorService):
   *   - keepMine: 保留用户内容, 把 originalContent 更新成 disk 的新版本;
   *               下次 save 就会覆盖 disk.
   *   - useTheirs: content 换成 disk 版本, isDirty 清除.
   *   - showDiff: 打开一个 diff tab 让用户手动合并, 原 tab 不动.
   */
  conflict?: {
    /** 磁盘当前内容 (VFS 再读一次的结果) */
    diskContent: string;
    /** 冲突被检测到的时间戳, UI 做 "刚刚/N 秒前" 显示 */
    detectedAt: number;
  };

  /**
   * 流式写入中标记 —— openOrUpdateStreamingFile(isComplete=false) 置 true.
   * auto-save 见到 true 跳过该 tab, 避免在 agent 流式写文件过程中反复存盘.
   * 完成时 (isComplete=true) 清除.
   */
  streaming?: boolean;
}

/** EditorService 对外暴露的状态快照 */
export interface EditorState {
  readonly tabs: readonly EditorTab[];
  readonly activeTabId: string | null;
  /**
   * 当前"被选中"的文件路径。
   *
   * 它跟 activeTabId 紧密但**不完全等价** —— Project View 在某些场景需要
   * 高亮一个并未打开的文件（例如 reveal-in-tree 但还没双击打开）。
   */
  readonly selectedFilePath: string | null;
}

/**
 * 兼容性 re-export —— FileSystemPort 现在的真正定义在 src/ide/vfs/types.ts
 * （它是 VFS 的底层端口）。这里 re-export 让现有从 editor types 引用的代码
 * 不破坏。step 5 之后新代码应该直接从 src/ide/vfs 引入。
 */
export type { FileSystemPort } from '../vfs/types.js';

/**
 * EditorService 在 MessageBus 上发布的事件。
 *
 * 订阅者只实现关心的方法即可。这是给"跨组件协调"用的语义通道，
 * 跟 EditorService.subscribe(() => void) 的"状态变了，重渲染"通道是两回事。
 */
export interface EditorEvents {
  /** 任何状态变化（含细粒度事件之外的所有变化）都会触发。给 React 重渲染 / 日志用 */
  onStateChanged(state: EditorState): void;

  /** 一个新 tab 被创建 */
  onTabOpened(tab: EditorTab): void;
  /** 活动 tab 切换 */
  onTabActivated(tab: EditorTab): void;
  /** tab 被关闭 */
  onTabClosed(payload: { tabId: string; path: string }): void;
  /** tab 内容变化（用户输入 / agent 流式写入） */
  onTabContentChanged(tab: EditorTab): void;
  /** tab 被保存到磁盘 */
  onTabSaved(tab: EditorTab): void;
  /** 所有 tab 都被关闭 */
  onAllTabsClosed(): void;

  /** 打开 / 保存失败 — 给 toast 等 UI 反馈使用 */
  onError(payload: { kind: 'open' | 'save'; path: string; error?: string }): void;

  /** 检测到外部文件改动 + 当前 tab 有未保存修改 —— 冲突进入"等用户解决"状态 */
  onExternalConflict(tab: EditorTab): void;

  /**
   * Wave 11 (5.1): 调用方 (CommandPalette 跳符号 / FindInFiles 跳匹配 / log 跳错误行)
   *   要求把光标定位到 path 的 line:column. openFile(path, { line, column }) 在 tab
   *   open 后 publish 此事件; EditorTabs 订阅, 找对应 tab 把 reveal 传给 CodeEditor.
   *   一次性 — 同 path 重复 openFile 即重新 reveal.
   */
  onRevealRequested(payload: { tabId: string; line: number; column?: number }): void;
}

/** EditorService 在 MessageBus 上的 topic */
export const EDITOR_TOPIC: Topic<EditorEvents> = createTopic<EditorEvents>('editor.tabs');

/**
 * EditorService 在 ServiceContainer 中的 token。
 * 作用域 = workspace（切换 workspace 时整个编辑器状态重建）。
 */
// 前向引用：EditorService 类在另一文件里定义。这里只保留 token，
// 真正的 service 类型由消费者从 EditorService.js 单独 import。
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
export const EDITOR_SERVICE: ServiceToken<import('./EditorService.js').EditorService> =
  createServiceToken('editor', 'workspace');
