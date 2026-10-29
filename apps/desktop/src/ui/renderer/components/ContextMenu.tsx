/**
 * ContextMenu - 通用右键菜单组件
 *
 * 设计参考: IntelliJ IDEA Project View 右键菜单 + macOS 原生 menu
 *
 * 特性:
 *   - 通过 portal 渲染到 body, 不被 sidebar overflow 截断
 *   - 自动避免超出视口边界 (右下角文件 → 菜单向上弹)
 *   - 键盘导航: ↑↓ 移动 / Enter 触发 / Esc / 点外面 关闭
 *   - 支持子菜单(嵌套 items)
 *   - 支持快捷键提示(右对齐显示)
 *   - 支持 separator / disabled / icon
 *
 * 用法:
 *   <ContextMenu
 *     position={{x: e.clientX, y: e.clientY}}
 *     items={[
 *       {id: 'open', label: '打开', shortcut: '↩', onClick: () => ...},
 *       {separator: true},
 *       {id: 'rename', label: '重命名', shortcut: 'F2', onClick: () => ...},
 *       {id: 'delete', label: '删除', destructive: true, onClick: () => ...},
 *     ]}
 *     onClose={() => setMenuOpen(false)}
 *   />
 */
import React, { useEffect, useRef, useState, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { interactionDoc } from '../utils/ownerDoc';

export interface ContextMenuItem {
  /** 唯一 id (separator 不需要) */
  id?: string;
  /** 显示文字 */
  label?: string;
  header?: boolean;
  /** header 的第二行 (邮箱 / 说明), 只在 header 为 true 时渲染 */
  subtitle?: string;
  /** 右侧快捷键提示 (如 "⌘C" "F2") */
  shortcut?: string;
  /** 左侧 icon 组件 */
  icon?: React.ReactNode;
  /** 子菜单(展开右侧二级) */
  submenu?: ContextMenuItem[];
  /** 点击时触发 */
  onClick?: () => void;
  /** 是否禁用(灰色,不可点) */
  disabled?: boolean;
  /** 红色破坏性动作样式(如 删除) */
  destructive?: boolean;
  /** 是分隔线(其它字段被忽略) */
  separator?: boolean;
}

export interface ContextMenuProps {
  position: { x: number; y: number };
  items: ContextMenuItem[];
  onClose: () => void;
  /** 子菜单偏移量(嵌套渲染时内部用) */
  isSubmenu?: boolean;
  flipUp?: boolean;
}

const MENU_MIN_WIDTH = 220;
const MENU_PADDING_VIEWPORT = 8;
const ITEM_HEIGHT = 26;
const SEPARATOR_HEIGHT = 7;
const HEADER_HEIGHT = 50;

export const ContextMenu: React.FC<ContextMenuProps> = ({ position, items, onClose, isSubmenu, flipUp }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  /* 右键发生在哪个窗口就开在哪个窗口 (Surface 独立窗口里右键文件树, 菜单不能弹到主窗口); 打开那一刻定下 */
  const [ownDoc] = useState(() => interactionDoc());
  const ownWin = ownDoc.defaultView ?? window;
  const [adjustedPos, setAdjustedPos] = useState(position);
  const [openSubmenuIndex, setOpenSubmenuIndex] = useState<number | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  // 计算菜单实际位置(避免超出视口)
  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const vw = ownWin.innerWidth;
    const vh = ownWin.innerHeight;
    let x = position.x;
    /* flipUp: position.y 是底边 —— 先换算成顶边, 再走下面同一套出屏夹紧 */
    let y = flipUp ? position.y - rect.height : position.y;
    if (x + rect.width > vw - MENU_PADDING_VIEWPORT) {
      x = Math.max(MENU_PADDING_VIEWPORT, vw - rect.width - MENU_PADDING_VIEWPORT);
    }
    if (y + rect.height > vh - MENU_PADDING_VIEWPORT) {
      y = Math.max(MENU_PADDING_VIEWPORT, vh - rect.height - MENU_PADDING_VIEWPORT);
    }
    setAdjustedPos({ x, y });
  }, [position, flipUp, ownWin]);

  // 点外面关闭
  useEffect(() => {
    if (isSubmenu) return; // 子菜单由父级管理
    const onMouseDown = (e: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // 用 timeout 避免立即触发(右键事件本身会被 mousedown 捕获)
    const timer = setTimeout(() => {
      ownWin.addEventListener('mousedown', onMouseDown);
    }, 0);
    return () => {
      clearTimeout(timer);
      ownWin.removeEventListener('mousedown', onMouseDown);
    };
  }, [onClose, isSubmenu, ownWin]);

  // ESC 关闭 / 键盘导航
  useEffect(() => {
    if (isSubmenu) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      // ↑↓ 移动选中
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const enabledIndices = items
          .map((it, i) => ({ it, i }))
          .filter(({ it }) => !it.separator && !it.disabled && !it.header)
          .map(({ i }) => i);
        if (enabledIndices.length === 0) return;
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        const currentIdx = hoveredIndex == null ? -1 : enabledIndices.indexOf(hoveredIndex);
        const next = currentIdx === -1
          ? (dir === 1 ? enabledIndices[0] : enabledIndices[enabledIndices.length - 1])
          : enabledIndices[(currentIdx + dir + enabledIndices.length) % enabledIndices.length];
        setHoveredIndex(next);
        return;
      }
      // Enter 触发
      if (e.key === 'Enter' && hoveredIndex != null) {
        e.preventDefault();
        const item = items[hoveredIndex];
        if (item && !item.separator && !item.disabled && item.onClick) {
          item.onClick();
          onClose();
        }
      }
    };
    ownWin.addEventListener('keydown', onKeyDown);
    return () => ownWin.removeEventListener('keydown', onKeyDown);
  }, [items, hoveredIndex, onClose, isSubmenu, ownWin]);

  const handleItemClick = (item: ContextMenuItem) => {
    if (item.disabled || item.separator) return;
    if (item.submenu) return; // 子菜单不直接点
    item.onClick?.();
    onClose();
  };

  const menu = (
    <div
      ref={menuRef}
      className="neox-context-menu"
      style={{
        position: 'fixed',
        left: `${adjustedPos.x}px`,
        top: `${adjustedPos.y}px`,
        minWidth: `${MENU_MIN_WIDTH}px`,
        zIndex: 10000,
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.separator) {
          return <div key={`sep-${i}`} className="neox-context-menu-separator" />;
        }
        if (item.header) {
          return (
            <div key={item.id || `header-${i}`} className="neox-context-menu-header">
              {item.icon && <span className="neox-context-menu-header__avatar">{item.icon}</span>}
              <span className="neox-context-menu-header__text">
                <span className="neox-context-menu-header__title">{item.label}</span>
                {item.subtitle && <span className="neox-context-menu-header__sub">{item.subtitle}</span>}
              </span>
            </div>
          );
        }
        const isHovered = hoveredIndex === i;
        const isSubmenuOpen = openSubmenuIndex === i;
        return (
          <div
            key={item.id || `item-${i}`}
            className={`neox-context-menu-item${item.disabled ? ' disabled' : ''}${item.destructive ? ' destructive' : ''}${isHovered || isSubmenuOpen ? ' hovered' : ''}`}
            onMouseEnter={() => {
              setHoveredIndex(i);
              if (item.submenu) {
                setOpenSubmenuIndex(i);
              } else {
                setOpenSubmenuIndex(null);
              }
            }}
            onMouseLeave={() => {
              if (!item.submenu) setHoveredIndex(null);
            }}
            onClick={() => handleItemClick(item)}
          >
            <span className="neox-context-menu-icon">{item.icon}</span>
            <span className="neox-context-menu-label">{item.label}</span>
            {item.shortcut && (
              <span className="neox-context-menu-shortcut">{item.shortcut}</span>
            )}
            {item.submenu && <span className="neox-context-menu-arrow">▶</span>}
            {/* 渲染子菜单 — y 按前面 item/separator 的实际高度累加, separator 比 item 矮,
              * 用 i * ITEM_HEIGHT 会在有分隔线的菜单里越往下偏得越多 */}
            {isSubmenuOpen && item.submenu && menuRef.current && (
              <ContextMenu
                isSubmenu
                position={{
                  x: menuRef.current.getBoundingClientRect().right - 4,
                  y: menuRef.current.getBoundingClientRect().top
                    + items.slice(0, i).reduce(
                      (acc, it) => acc + (it.separator ? SEPARATOR_HEIGHT : it.header ? HEADER_HEIGHT : ITEM_HEIGHT), 0),
                }}
                items={item.submenu}
                onClose={() => {
                  setOpenSubmenuIndex(null);
                  onClose();
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );

  return createPortal(menu, ownDoc.body);
};
