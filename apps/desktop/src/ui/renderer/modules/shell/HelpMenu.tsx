import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEnterTransition } from '../../hooks/useEnterTransition';
import { createPortal } from 'react-dom';
import { ContextMenu } from '../../components/ContextMenu';
import { IconHelp } from './shellIcons';
import {
  KEYMAP_ACTIONS,
  formatShortcut,
  getBinding,
  subscribeKeymap,
  actionName,
  actionDescription,
  categoryLabel,
  type KeymapAction,
  type KeymapCategory,
} from '../../utils/keymap';
import { productLinks } from '../../utils/productLinks';
import { useI18n } from '../../hooks/useI18n';

const NEOX_LOGO_URL = `${import.meta.env.BASE_URL}icons/icon-128.png`;

declare const window: Window & {
  neox?: {
    openExternal?: (url: string) => Promise<void>;
    getAppInfo?: () => Promise<{ version: string; platform: string; arch: string }>;
  };
};

const openExternal = (url: string) => {
  window.neox?.openExternal?.(url).catch((err) => {
    console.error('[HelpMenu] openExternal failed:', err);
  });
};

export const HelpMenu: React.FC = () => {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const { language } = useI18n();
  const zh = language === 'zh';

  const openMenu = useCallback(() => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    /* 菜单宽 ~220, 让其右边和按钮右边对齐, 顶部贴按钮底 4px */
    setMenuPos({ x: rect.right - 220, y: rect.bottom + 4 });
  }, []);

  const closeMenu = useCallback(() => setMenuPos(null), []);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="neox-topbar__iconbtn"
        title={zh ? '帮助' : 'Help'}
        aria-label={zh ? '帮助' : 'Help'}
        onClick={openMenu}
      >
        <IconHelp />
      </button>
      {menuPos && (
        <ContextMenu
          position={menuPos}
          items={[
            {
              id: 'shortcuts',
              label: zh ? '键盘快捷键' : 'Keyboard Shortcuts',
              onClick: () => { closeMenu(); setShortcutsOpen(true); },
            },
            { separator: true },
            {
              id: 'docs',
              label: zh ? '使用文档' : 'Documentation',
              onClick: () => { closeMenu(); openExternal(productLinks.docs); },
            },
            {
              id: 'changelog',
              label: zh ? '更新日志' : 'Changelog',
              onClick: () => { closeMenu(); openExternal(productLinks.changelog); },
            },
            {
              id: 'feedback',
              label: zh ? '反馈 / 客服' : 'Feedback / Support',
              onClick: () => { closeMenu(); openExternal(productLinks.feedback); },
            },
            { separator: true },
            {
              id: 'github',
              label: 'GitHub',
              onClick: () => { closeMenu(); openExternal(productLinks.github); },
            },
            { separator: true },
            {
              id: 'about',
              label: zh ? '关于 Neox Agent' : 'About Neox Agent',
              onClick: () => { closeMenu(); setAboutOpen(true); },
            },
          ]}
          onClose={closeMenu}
        />
      )}
      <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </>
  );
};

/* ============================================================
 * ShortcutsSheet — 全部快捷键 modal
 *   按 category 分组, 直接读 keymap 当前 binding (用户自定义会反映)
 * ============================================================ */
const ShortcutsSheet: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const { isZh } = useI18n();
  /* 用户在设置页改快捷键时, 表内容要刷 */
  const [, bumpRender] = useState(0);
  useEffect(() => {
    if (!open) return;
    return subscribeKeymap(() => bumpRender((v) => v + 1));
  }, [open]);

  /* Esc 关闭 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const grouped = useMemo<Array<[KeymapCategory, KeymapAction[]]>>(() => {
    const map = new Map<KeymapCategory, KeymapAction[]>();
    for (const a of KEYMAP_ACTIONS) {
      const list = map.get(a.category) ?? [];
      list.push(a);
      map.set(a.category, list);
    }
    return Array.from(map.entries());
  }, []);

  /* 入场动画: motion-macos / motion-win32 */

  const entered = useEnterTransition();


  if (!open) return null;

  return createPortal(
    <div className={`neox-modal-backdrop nx-in nx-in--scrim ${entered ? 'is-in' : ''}`} onClick={onClose} role="presentation">
      <div
        className={`neox-modal-panel neox-shortcuts-sheet nx-in nx-in--modal ${entered ? 'is-in' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={isZh ? '键盘快捷键' : 'Keyboard shortcuts'}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="neox-modal-header">
          <h2>{isZh ? '键盘快捷键' : 'Keyboard Shortcuts'}</h2>
          <button
            type="button"
            className="neox-modal-close"
            onClick={onClose}
            aria-label={isZh ? '关闭' : 'Close'}
          >
            ×
          </button>
        </header>
        <div className="neox-modal-body neox-shortcuts-body">
          {grouped.map(([category, actions]) => (
            <section key={category} className="neox-shortcuts-section">
              <h3>{categoryLabel(category, isZh)}</h3>
              <table className="neox-shortcuts-table">
                <tbody>
                  {actions.map((a) => {
                    const binding = getBinding(a.id);
                    return (
                      <tr key={a.id}>
                        <td className="action-name" title={actionDescription(a, isZh)}>{actionName(a, isZh)}</td>
                        <td className="action-shortcut">
                          {binding ? formatShortcut(binding) : <span className="muted">{isZh ? '未绑定' : 'Unbound'}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
};

/* ============================================================
 * AboutDialog — 关于 Neox Agent
 *   logo + 版本号 + 平台/架构 + GitHub 入口
 * ============================================================ */
const AboutDialog: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const { isZh } = useI18n();
  const [info, setInfo] = useState<{ version: string; platform: string; arch: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    window.neox?.getAppInfo?.().then((res) => {
      if (!cancelled) setInfo(res);
    }).catch((err) => {
      console.error('[AboutDialog] getAppInfo failed:', err);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="neox-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="neox-modal-panel neox-about-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={isZh ? '关于 Neox Agent' : 'About Neox Agent'}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="neox-modal-close neox-modal-close--floating"
          onClick={onClose}
          aria-label={isZh ? '关闭' : 'Close'}
        >
          ×
        </button>
        <img className="neox-about-logo" src={NEOX_LOGO_URL} alt="" aria-hidden="true" />
        <h1>Neox Agent</h1>
        {info ? (
          <p className="neox-about-meta">
            v{info.version} · {info.platform} {info.arch}
          </p>
        ) : (
          <p className="neox-about-meta muted neox-text-shimmer">{isZh ? '载入中…' : 'Loading…'}</p>
        )}
        <p className="neox-about-tagline">{isZh ? '面向开发者的 AI Agent 工作台' : 'The AI agent workbench for developers'}</p>
        <div className="neox-about-actions">
          <button type="button" onClick={() => openExternal(productLinks.github)}>
            GitHub
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default HelpMenu;
