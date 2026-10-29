import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import AvatarMenu from './AvatarMenu';
import {
  IconCog,
  IconBrain,
} from './shellIcons';
import { useAppStore, THEME_PRESETS, type ThemePreset } from '../../../state/appStore';
import { useI18n } from '../../hooks/useI18n';

/* 左轨 / 左侧栏当前面板: 会话列表 (agent) · 文件树 (explorer) · Git (git); 其余是历史取值 */
export type RailKey =
  | 'home'
  | 'agent'
  | 'workflow'
  | 'team'
  | 'history'
  | 'settings'
  | 'explorer'
  | 'git';

interface RailItem {
  key: RailKey;
  label: { zh: string; en: string };
  Icon: React.ComponentType<{ size?: number }>;
}

/* rail 点击只换 *左侧栏面板*, 不动 main 区 */
const RAIL_ITEMS: RailItem[] = [
  { key: 'agent',  label: { zh: '会话', en: 'Chats' }, Icon: IconBrain },
];

interface IconRailProps {
  activeKey?: RailKey;
  onSelect?: (key: RailKey) => void;
  onOpenSettings?: () => void;
  /** @deprecated rail 主题切换已升级为 preset 选择 popover, 不再是二态 toggle. 保留 prop 为兼容性, 不再使用. */
  onToggleTheme?: () => void;
}

/* ============================================================
 * 调色板 icon (主题切换 trigger 用) — shellIcons 没现成的, 这里 inline
 * ============================================================ */
const IconPalette: React.FC<{ size?: number }> = ({ size = 20 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 22a10 10 0 1 1 10-10c0 2.21-1.79 4-4 4h-1.5a1.5 1.5 0 0 0-1.06 2.56l.06.06A1.5 1.5 0 0 1 14.5 21H12z" />
    <circle cx="7.5"  cy="10.5" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="12"   cy="7"    r="1.3" fill="currentColor" stroke="none" />
    <circle cx="16.5" cy="10.5" r="1.3" fill="currentColor" stroke="none" />
  </svg>
);

/* ============================================================
 * ThemePresetSwitcher — rail 底部"主题切换"按钮
 *   icon: IconPalette (调色板)
 *   click: 弹出 popover, 列 4 个 preset (浅白/晨光/墨夜/暖阳) 可选
 *   选中态: 当前 preset 高亮 + active mark
 * ============================================================ */
const ThemePresetSwitcher: React.FC = () => {
  const { isZh } = useI18n();
  const { themePreset, setThemePreset } = useAppStore();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number } | null>(null);

  /* outside-click + Esc 关. 因为 popover 通过 portal 渲染到 body 外, 不能简单 contains 判断,
   * 但 trigger 和 menu 各持 ref 分别 check. */
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current && triggerRef.current.contains(t)) return;
      if (menuRef.current && menuRef.current.contains(t)) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  /* 打开时算 popover 位置: rail 在最左, 锚到按钮右侧 + 上方对齐按钮底.
   * 用 useLayoutEffect 在 portal 挂载后立即测量, 避免肉眼可见的"先错位后跳正". */
  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    const btn = triggerRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    setMenuPos({
      left: rect.right + 8,
      bottom: window.innerHeight - rect.bottom,
    });
  }, [open]);

  const handlePick = (id: ThemePreset) => {
    setThemePreset(id);
    setOpen(false);
  };

  const current = THEME_PRESETS.find((p) => p.id === themePreset);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`neox-rail__btn${open ? ' is-active' : ''}`}
        title={isZh ? `主题: ${current?.name ?? ''} · 点击切换` : `Theme: ${current?.name ?? ''} · Click to switch`}
        aria-label={isZh ? "切换主题" : "Switch theme"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <IconPalette />
      </button>
      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          className="neox-rail__theme-menu"
          role="menu"
          style={{ left: menuPos.left, bottom: menuPos.bottom }}
        >
          <div className="neox-rail__theme-menu__title">{isZh ? '选择主题' : 'Choose theme'}</div>
          {THEME_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitemradio"
              aria-checked={themePreset === p.id}
              className={`neox-rail__theme-item${themePreset === p.id ? ' is-active' : ''}`}
              onClick={() => handlePick(p.id)}
              title={p.desc}
            >
              <span
                className="neox-rail__theme-swatch"
                aria-hidden="true"
                style={{
                  background: `linear-gradient(135deg, ${p.swatch[0]} 0 50%, ${p.swatch[1]} 50% 100%)`,
                }}
              />
              <span className="neox-rail__theme-meta">
                <span className="neox-rail__theme-name">{p.name}</span>
                <span className="neox-rail__theme-desc">{p.desc}</span>
              </span>
              {themePreset === p.id && <span className="neox-rail__theme-check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
};

/* ============================================================
 * IconRail — 左 56 竖向图标轨
 *   底部: 头像 (online dot) · 设置 · 主题
 * ============================================================ */
const IconRailImpl: React.FC<IconRailProps> = ({
  activeKey = 'home',
  onSelect,
  onOpenSettings,
  onToggleTheme,
}) => {
  const { isZh } = useI18n();
  return (
    <nav className="neox-rail neox-shell__rail" aria-label={isZh ? "主导航" : "Main navigation"}>
      {RAIL_ITEMS.map(({ key, label, Icon }) => {
        const itemLabel = isZh ? label.zh : label.en;
        return (
        <button
          key={key}
          type="button"
          className={`neox-rail__btn${activeKey === key ? ' is-active' : ''}`}
          title={itemLabel}
          aria-label={itemLabel}
          aria-pressed={activeKey === key}
          onClick={() => onSelect?.(key)}
        >
          <Icon />
        </button>
        );
      })}

      <div className="neox-rail__spacer" />
      <ThemePresetSwitcher />
    </nav>
  );
};

export const IconRail = React.memo(IconRailImpl);
IconRail.displayName = 'IconRail';

export default IconRail;
