/* ============================================================
 * FileRowContextMenu — 文件行右键菜单 (portal 渲染避免 panel overflow clip)
 *
 *   actions 按 area (staged/unstaged/untracked) 自动过滤:
 *     · 在编辑器打开 / 在 Surface 预览     永远显
 *     · 查看 diff                          tracked 才显 (untracked 没 diff)
 *     · 暂存                               unstaged / untracked 才显
 *     · 取消暂存                           staged 才显
 *     · 还原改动                           tracked 才显 (untracked 走"删除文件")
 *     · 删除文件                           untracked 才显
 *     · 加到 .gitignore                    untracked 才显
 *     · 复制路径 / 复制相对路径            永远显
 *
 *   关闭: 点空白 / ESC / 选中一项后.
 * ============================================================ */

import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import { usePopoverDismiss } from '../../../hooks/usePopoverDismiss';
import { useI18n } from '../../../hooks/useI18n';

export type FileArea = 'staged' | 'unstaged' | 'untracked' | 'conflict';

export interface FileRowContextMenuProps {
  /** popover 锚点屏幕坐标 (x, y) — 右键时取 event.clientX/Y */
  anchor: { x: number; y: number };
  /** 文件路径 (workspace 相对) */
  filePath: string;
  /** 当前 area — 决定哪些 action 显示 */
  area: FileArea;
  onClose: () => void;
  /** 各 action 回调 — 由 CommitPanel 注入 */
  /** 在右侧面板打开 (代码面板自带编辑器) */
  onOpen: () => void;
  onViewDiff: () => void;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
  onDelete: () => void;
  onAddToGitignore: () => void;
  onCopyPath: () => void;
  onCopyRelativePath: () => void;
}

interface MenuItem {
  key: string;
  label: string;
  /** 危险操作 (红色) — discard/delete */
  danger?: boolean;
  /** 分组分隔线在此 item 之前 */
  divider?: boolean;
  /** 提示文字 (副标题, 显示在右侧灰字) */
  hint?: string;
  onClick: () => void;
}

export const FileRowContextMenu: React.FC<FileRowContextMenuProps> = ({
  anchor, filePath, area, onClose,
  onOpen, onViewDiff,
  onStage, onUnstage, onDiscard, onDelete, onAddToGitignore,
  onCopyPath, onCopyRelativePath,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const { isZh } = useI18n();

  /* 统一 popover 关闭逻辑 */
  usePopoverDismiss({
    open: true,
    refs: [ref],
    onDismiss: onClose,
  });

  /* 包装 onClick — 选中后自动关闭菜单 */
  const wrap = (fn: () => void) => () => { try { fn(); } finally { onClose(); } };

  const items: MenuItem[] = [];

  items.push({ key: 'open', label: isZh ? '打开' : 'Open', onClick: wrap(onOpen) });

  /* diff — 只 tracked */
  if (area !== 'untracked') {
    items.push({ key: 'diff', label: isZh ? '查看改动 diff' : 'View diff', divider: true, onClick: wrap(onViewDiff) });
  }

  /* git 操作 */
  if (area === 'conflict') {
    // 冲突文件: 手动解决后用 stage(git add) 标记为已解决, 才能继续提交完成合并
    items.push({ key: 'stage', label: isZh ? '标记为已解决 (暂存)' : 'Mark resolved (stage)', divider: true, onClick: wrap(onStage) });
  } else if (area === 'unstaged' || area === 'untracked') {
    items.push({ key: 'stage', label: isZh ? '暂存' : 'Stage', divider: true, onClick: wrap(onStage) });
  }
  if (area === 'staged') {
    items.push({ key: 'unstage', label: isZh ? '取消暂存' : 'Unstage', divider: true, onClick: wrap(onUnstage) });
  }
  if (area !== 'untracked') {
    items.push({ key: 'discard', label: isZh ? '还原改动' : 'Discard changes', danger: true, hint: isZh ? '回到 HEAD' : 'back to HEAD', onClick: wrap(onDiscard) });
  } else {
    items.push({ key: 'delete', label: isZh ? '删除文件' : 'Delete file', danger: true, divider: true, onClick: wrap(onDelete) });
    items.push({ key: 'gitignore', label: isZh ? '加到 .gitignore' : 'Add to .gitignore', onClick: wrap(onAddToGitignore) });
  }

  /* copy */
  items.push({ key: 'copyPath',  label: isZh ? '复制完整路径' : 'Copy absolute path', divider: true, onClick: wrap(onCopyPath) });
  items.push({ key: 'copyRel',   label: isZh ? '复制相对路径' : 'Copy relative path', onClick: wrap(onCopyRelativePath) });

  /* clamp 坐标: 不溢出屏幕 */
  const W = 220;
  const estimatedH = items.length * 28 + 12;
  const left = Math.min(Math.max(8, anchor.x), window.innerWidth - W - 8);
  const top  = Math.min(Math.max(8, anchor.y), window.innerHeight - estimatedH - 8);

  return createPortal(
    <div
      ref={ref}
      className="neox-filerow-cm"
      role="menu"
      style={{ left, top, width: W }}
      aria-label={isZh ? `${filePath} 文件操作` : `File actions for ${filePath}`}
    >
      {items.map((it) => (
        <React.Fragment key={it.key}>
          {it.divider && <div className="neox-filerow-cm__divider" aria-hidden="true" />}
          <button
            type="button"
            role="menuitem"
            className={`neox-filerow-cm__item${it.danger ? ' is-danger' : ''}`}
            onClick={it.onClick}
          >
            <span className="neox-filerow-cm__label">{it.label}</span>
            {it.hint && <span className="neox-filerow-cm__hint">{it.hint}</span>}
          </button>
        </React.Fragment>
      ))}
    </div>,
    document.body,
  );
};

export default FileRowContextMenu;
