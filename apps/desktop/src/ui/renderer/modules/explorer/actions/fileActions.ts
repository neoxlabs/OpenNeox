/**
 * fileActions - Project View 文件操作单一注册表
 *
 * 设计参考: IntelliJ IDEA `AnAction` + `ActionRegistry`
 *
 * 这是整个文件操作模块的"单一数据源":
 *   - 右键菜单(ContextMenu)从这里读 items
 *   - 键盘快捷键(useScopedShortcut)从这里读 handler
 *   - 工具栏按钮(explorer-actions)从这里读 handler
 *   - 命令面板(将来)从这里读 items
 *
 * 增加一个新动作只需要在 fileActions 数组里加一项,以上 4 处全部自动更新。
 *
 * 每个 action 是一个纯函数描述,跟 React 无关 → 易测试、易复用。
 */

import type { Translations } from '../../../i18n';
import { fileSystemService } from '../../../services/fileSystemService';
import { fileClipboard } from '../state/fileClipboard';
import type { KeymapActionId } from '../../../utils/keymap';
import { revealInFileManagerLabel } from '../../../utils/fileManagerLabels';
import { confirmAsync } from '../../../components/confirmEvents';

/* truncateErr — fs 错误消息可能很长 (路径 + 系统返回 + stack), 直接塞 toast 撑爆 UI.
 * 只取第一行 + 100 字符上限, 用户看不全可去 console 看完整. */
function truncateErr(e: any, fallback = '操作失败'): string {
  const raw = e?.message ?? (typeof e === 'string' ? e : '');
  const oneLine = String(raw).split('\n')[0]!.trim();
  if (!oneLine) return fallback;
  return oneLine.length > 100 ? oneLine.slice(0, 100) + '…' : oneLine;
}

/**
 * 动作执行上下文 — 每次触发动作时由 FileExplorer 提供
 *
 * 多选模型(IDEA-style):
 *   - selectedPaths : 全部选中的路径集合 (1+)
 *   - leadPath      : 最近一次点击的"主"选中,作为光标 / shift-click 锚点
 *   - leadIsDirectory: lead 的类型
 *   - selectedPath/selectedIsDirectory : leadPath 的别名(向后兼容)
 */
export interface FileActionContext {
  /** 全部选中的路径集合 */
  selectedPaths: string[];
  /** 主选中(最近一次点击) */
  leadPath: string | null;
  leadIsDirectory: boolean;
  /** @deprecated 请用 leadPath。保留是为了兼容旧代码 */
  selectedPath: string | null;
  /** @deprecated 请用 leadIsDirectory */
  selectedIsDirectory: boolean;
  /** workspace 根路径(用于相对路径计算) */
  workspacePath: string;
  /** i18n 文本(供 toast / dialog 用) */
  t: Translations;
  /** UI 反馈钩子 — toast / 对话框 / 进入 rename 模式 */
  ui: {
    /** 弹 toast 反馈 */
    toast: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
    /** 弹 "新建文件" 对话框,resolve 时返回输入的名字(取消则 reject) */
    promptNewItem: (parentDir: string, isDirectory: boolean) => Promise<string>;
    /** 弹 "确认删除" 对话框 */
    confirmDelete: (paths: string[]) => Promise<boolean>;
    /** 进入行内 rename 模式(由 FileExplorer 自己实现) */
    startInlineRename: (path: string) => void;
  };
  /** 文件树 mutator — 各动作触发后通知 FileExplorer 刷新 */
  refresh: (parentDir?: string) => void;
}

function hasLead(ctx: FileActionContext): boolean {
  return ctx.leadPath != null;
}

function hasAnySelection(ctx: FileActionContext): boolean {
  return ctx.selectedPaths.length > 0;
}

/** 只对单选生效 (rename/duplicate 多选时只作用单文件 → 之前 hasSelection 误导) */
function singleSelection(ctx: FileActionContext): boolean {
  return ctx.selectedPaths.length === 1;
}

/**
 * FileAction 描述
 */
export interface FileAction {
  /** 唯一 id,跟 KeymapActionId 一致(便于关联快捷键) */
  id: KeymapActionId;
  /** 在右键菜单 / toast 里显示的文案 key,从 i18n explorer namespace 取 */
  labelKey: keyof Translations['explorer'];
  /** 是不是分组分隔符 */
  group?: 'create' | 'clipboard' | 'edit' | 'delete' | 'navigate' | 'misc';
  /** 该 action 是否对当前 context 启用 */
  enabled: (ctx: FileActionContext) => boolean;
  /** 是不是在右键菜单显示(有些只走快捷键,不进菜单) */
  showInContextMenu?: boolean;
  /** 是不是破坏性动作(红色) */
  destructive?: boolean;
  /** 真正的执行 */
  execute: (ctx: FileActionContext) => Promise<void>;
}

// ── 工具函数 ──
/** @deprecated use hasLead */
function hasSelection(ctx: FileActionContext): boolean {
  return ctx.leadPath != null;
}

function selectionParentDir(ctx: FileActionContext): string {
  if (!ctx.leadPath) return ctx.workspacePath;
  // 如果选中是文件夹,新文件就建在它里面;如果选中是文件,新文件建在它的父目录
  if (ctx.leadIsDirectory) return ctx.leadPath;
  const lastSep = Math.max(ctx.leadPath.lastIndexOf('/'), ctx.leadPath.lastIndexOf('\\'));
  return lastSep > 0 ? ctx.leadPath.slice(0, lastSep) : ctx.workspacePath;
}

// ──────────────────────── ACTION DEFINITIONS ────────────────────────

export const fileActions: FileAction[] = [
  // ── 创建组 ──
  {
    id: 'file.newFile',
    labelKey: 'newFile',
    group: 'create',
    showInContextMenu: true,
    enabled: () => true, // 总是可以新建(没选 → 在 workspace 根新建)
    async execute(ctx) {
      const parent = selectionParentDir(ctx);
      try {
        const name = await ctx.ui.promptNewItem(parent, false);
        await fileSystemService.create(parent, name, false);
        ctx.refresh(parent);
        ctx.ui.toast(ctx.t.explorer.successCreated, 'success');
      } catch (e: any) {
        ctx.ui.toast(`${ctx.t.explorer.errorCreate}: ${truncateErr(e)}`, 'error');
      }
    },
  },
  {
    id: 'file.newFolder',
    labelKey: 'newFolder',
    group: 'create',
    showInContextMenu: true,
    enabled: () => true,
    async execute(ctx) {
      const parent = selectionParentDir(ctx);
      try {
        const name = await ctx.ui.promptNewItem(parent, true);
        await fileSystemService.create(parent, name, true);
        ctx.refresh(parent);
        ctx.ui.toast(ctx.t.explorer.successCreated, 'success');
      } catch (e: any) {
        ctx.ui.toast(`${ctx.t.explorer.errorCreate}: ${truncateErr(e)}`, 'error');
      }
    },
  },

  // ── 剪贴板组 (支持批量) ──
  {
    id: 'file.cut',
    labelKey: 'cut',
    group: 'clipboard',
    showInContextMenu: true,
    enabled: hasAnySelection,
    async execute(ctx) {
      if (ctx.selectedPaths.length === 0) return;
      fileClipboard.cut(ctx.selectedPaths);
    },
  },
  {
    id: 'file.copy',
    labelKey: 'copy',
    group: 'clipboard',
    showInContextMenu: true,
    enabled: hasAnySelection,
    async execute(ctx) {
      if (ctx.selectedPaths.length === 0) return;
      fileClipboard.copy(ctx.selectedPaths);
    },
  },
  {
    id: 'file.paste',
    labelKey: 'paste',
    group: 'clipboard',
    showInContextMenu: true,
    enabled: () => fileClipboard.hasContent(),
    async execute(ctx) {
      const state = fileClipboard.get();
      if (!state) return;
      const destDir = selectionParentDir(ctx);
      try {
        for (const src of state.paths) {
          if (state.operation === 'cut') {
            await fileSystemService.moveTo(src, destDir);
          } else {
            await fileSystemService.copyTo(src, destDir);
          }
        }
        fileClipboard.consumeCut();
        ctx.refresh(destDir);
        ctx.ui.toast(ctx.t.explorer.successPasted, 'success');
      } catch (e: any) {
        ctx.ui.toast(`${ctx.t.explorer.errorCreate}: ${truncateErr(e)}`, 'error');
      }
    },
  },
  {
    id: 'file.copyPath',
    labelKey: 'copyPath',
    group: 'clipboard',
    showInContextMenu: true,
    enabled: hasSelection,
    async execute(ctx) {
      if (!ctx.selectedPath) return;
      try {
        await fileSystemService.copyPathToClipboard(ctx.selectedPath);
        ctx.ui.toast(ctx.t.explorer.successCopiedPath, 'success');
      } catch (e: any) {
        ctx.ui.toast(`${ctx.t.explorer.errorCopyToClipboard}: ${truncateErr(e)}`, 'error');
      }
    },
  },
  {
    id: 'file.copyRelativePath',
    labelKey: 'copyRelativePath',
    group: 'clipboard',
    showInContextMenu: true,
    enabled: hasSelection,
    async execute(ctx) {
      if (!ctx.selectedPath) return;
      try {
        await fileSystemService.copyRelativePathToClipboard(ctx.selectedPath, ctx.workspacePath);
        ctx.ui.toast(ctx.t.explorer.successCopiedPath, 'success');
      } catch (e: any) {
        ctx.ui.toast(`${ctx.t.explorer.errorCopyToClipboard}: ${truncateErr(e)}`, 'error');
      }
    },
  },

  // ── 编辑组 ──
  {
    id: 'file.duplicate',
    labelKey: 'duplicate',
    group: 'edit',
    showInContextMenu: true,
    enabled: singleSelection,
    async execute(ctx) {
      if (!ctx.selectedPath) return;
      try {
        await fileSystemService.duplicate(ctx.selectedPath);
        const parent = ctx.selectedPath.slice(0, ctx.selectedPath.lastIndexOf('/'));
        ctx.refresh(parent);
        ctx.ui.toast(ctx.t.explorer.successDuplicated, 'success');
      } catch (e: any) {
        ctx.ui.toast(`${ctx.t.explorer.errorCreate}: ${truncateErr(e)}`, 'error');
      }
    },
  },
  {
    id: 'file.rename',
    labelKey: 'rename',
    group: 'edit',
    showInContextMenu: true,
    enabled: singleSelection,
    async execute(ctx) {
      if (!ctx.selectedPath) return;
      // 进入 inline rename 模式,实际改名走 commitInlineRename
      ctx.ui.startInlineRename(ctx.selectedPath);
    },
  },

  // ── 还原改动 (git discard, 回到 HEAD) ──
  {
    id: 'file.revert',
    labelKey: 'revert',
    group: 'edit',
    showInContextMenu: true,
    destructive: true,
    // 只对单个文件 (非目录) 显示; 没有 git status 集成前对所有文件显, 后端无改动会报错→toast
    enabled: (ctx) => hasLead(ctx) && !ctx.leadIsDirectory,
    async execute(ctx) {
      const p = ctx.leadPath;
      if (!p) return;
      const name = p.split(/[/\\]/).pop() || p;
      const ok = await confirmAsync({
        title: `还原「${name}」的改动?`,
        message: '丢弃该文件未提交的改动, 恢复到 HEAD 版本。',
        description: '此操作不可撤销 (未提交内容会丢失)。',
        variant: 'danger',
        confirmLabel: '还原',
      });
      if (!ok) return;
      const rel = p.startsWith(ctx.workspacePath) ? p.slice(ctx.workspacePath.length).replace(/^[/\\]+/, '') : p;
      try {
        await (window as any).neox?.gitDiscardFile?.(ctx.workspacePath, rel, 'tracked');
        ctx.ui.toast(`已还原 ${name}`, 'success');
        ctx.refresh(selectionParentDir(ctx));
      } catch (e: any) {
        ctx.ui.toast(`还原失败 (该文件可能无改动): ${truncateErr(e)}`, 'error');
      }
    },
  },

  // ── 删除组 (支持批量) ──
  {
    id: 'file.delete',
    labelKey: 'delete',
    group: 'delete',
    showInContextMenu: true,
    destructive: true,
    enabled: hasAnySelection,
    async execute(ctx) {
      if (ctx.selectedPaths.length === 0) return;
      const confirmed = await ctx.ui.confirmDelete(ctx.selectedPaths);
      if (!confirmed) return;
      try {
        // 串行删除(避免父子目录同时删除时的竞态)
        const parents = new Set<string>();
        for (const p of ctx.selectedPaths) {
          await fileSystemService.trash(p);
          parents.add(p.slice(0, p.lastIndexOf('/')));
        }
        // 刷新所有受影响的父目录
        for (const parent of parents) ctx.refresh(parent);
        ctx.ui.toast(ctx.t.explorer.successDeleted, 'success');
      } catch (e: any) {
        ctx.ui.toast(`${ctx.t.explorer.errorDelete}: ${truncateErr(e)}`, 'error');
      }
    },
  },

  // ── 导航组 ──
  {
    id: 'file.revealInFinder',
    labelKey: 'revealInFinder',
    group: 'navigate',
    showInContextMenu: true,
    enabled: hasSelection,
    async execute(ctx) {
      if (!ctx.selectedPath) return;
      try {
        await fileSystemService.revealInFinder(ctx.selectedPath);
      } catch (e: any) {
        ctx.ui.toast(`${truncateErr(e)}`, 'error');
      }
    },
  },
  {
    id: 'file.attachToComposer',
    labelKey: 'attachToComposer',
    group: 'navigate',
    showInContextMenu: true,
    enabled: hasSelection,
    async execute(ctx) {
      const paths = ctx.selectedPaths.length > 0 ? ctx.selectedPaths : (ctx.selectedPath ? [ctx.selectedPath] : []);
      if (paths.length === 0) return;
      window.dispatchEvent(new CustomEvent('neox:composer-attach-path', {
        detail: { paths, dir: !!ctx.selectedIsDirectory },
      }));
    },
  },
  {
    id: 'file.openInTerminal',
    labelKey: 'openInTerminal',
    group: 'navigate',
    showInContextMenu: true,
    enabled: hasSelection,
    async execute(ctx) {
      if (!ctx.selectedPath) return;
      try {
        await fileSystemService.openInTerminal(ctx.selectedPath);
      } catch (e: any) {
        ctx.ui.toast(`${truncateErr(e)}`, 'error');
      }
    },
  },
];

/**
 * 按 group 分组,并在组之间插入 separator,生成 ContextMenu items
 */
export function buildContextMenuItems(ctx: FileActionContext) {
  const groups: Record<string, FileAction[]> = {};
  for (const action of fileActions) {
    if (!action.showInContextMenu) continue;
    if (!action.enabled(ctx)) continue;
    const group = action.group || 'misc';
    if (!groups[group]) groups[group] = [];
    groups[group].push(action);
  }
  const order: Array<FileAction['group']> = ['create', 'clipboard', 'edit', 'delete', 'navigate', 'misc'];
  const items: any[] = [];
  for (const g of order) {
    if (g && groups[g] && groups[g].length > 0) {
      if (items.length > 0) items.push({ separator: true });
      for (const a of groups[g]) {
        items.push({
          id: a.id,
          label: a.labelKey === 'revealInFinder'
            ? revealInFileManagerLabel(ctx.t.explorer.newFile === '新建文件')
            : ctx.t.explorer[a.labelKey],
          destructive: a.destructive,
          onClick: () => a.execute(ctx),
        });
      }
    }
  }
  return items;
}

/**
 * 通过 id 找到 action,触发它(用于 keymap 调用)
 */
export function executeFileAction(actionId: KeymapActionId, ctx: FileActionContext): Promise<void> | void {
  const action = fileActions.find(a => a.id === actionId);
  if (!action) return;
  if (!action.enabled(ctx)) return;
  return action.execute(ctx);
}
