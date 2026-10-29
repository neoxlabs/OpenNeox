
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePopoverDismiss } from '../../../hooks/usePopoverDismiss';
import { useI18n } from '../../../hooks/useI18n';
import { bodyOf, winOf } from '../../../utils/ownerDoc';

interface Props {
  filePath?: string;
  /** 主按钮 tooltip 文案前缀, 默认"在外部应用打开" */
  label?: string;
  /** 按钮上的字 (查看器顶栏里写「用 Word 打开」这种), 默认「外部打开」 */
  text?: string;
}

interface AppEntry {
  id: string;
  name: string;
  exists: boolean;
}

export const OpenInExternalAppButton: React.FC<Props> = ({ filePath, label, text }) => {
  const { isZh } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const [apps, setApps] = useState<AppEntry[] | null>(null);
  const [appsLoading, setAppsLoading] = useState(false);
  const arrowRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /* 主按钮点击 — 系统默认 app 打开 */
  const onMainClick = useCallback(async () => {
    if (!filePath || busy) return;
    setBusy(true);
    setError(null);
    try {
      const api = (window as any).neox;
      const fn = api?.surfaceOpenExternal;
      if (!fn) { setError(isZh ? 'surfaceOpenExternal bridge 不可用' : 'surfaceOpenExternal bridge unavailable'); return; }
      const r = await fn(filePath);
      if (r?.success === false) setError(r.error || (isZh ? '打开失败' : 'failed to open'));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
      if (error) setTimeout(() => setError(null), 2000);
    }
  }, [filePath, busy, error, isZh]);

  /* 用指定 app 打开 */
  const onPickApp = useCallback(async (app: AppEntry) => {
    setMenuOpen(false);
    if (!filePath) return;
    /* "系统默认 app" 走的是另一条 bridge (surfaceOpenExternal) —— 别拿 '__default__'
       当 app id 丢给 surfaceOpenWith, 后端不认这个假 id。 */
    if (app.id === '__default__') { void onMainClick(); return; }
    if (!app.exists) {
      setError(isZh ? `${app.name} 未安装` : `${app.name} not installed`);
      setTimeout(() => setError(null), 2500);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const api = (window as any).neox;
      const fn = api?.surfaceOpenWith;
      if (!fn) { setError(isZh ? 'surfaceOpenWith bridge 不可用' : 'surfaceOpenWith bridge unavailable'); return; }
      const r = await fn(filePath, app.id);
      if (r?.success === false) {
        setError(r.notInstalled
          ? (isZh ? `${app.name} 未安装` : `${app.name} not installed`)
          : (r.error || (isZh ? '打开失败' : 'failed to open')));
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
      setTimeout(() => setError(null), 2500);
    }
  }, [filePath, isZh, onMainClick]);

  /* 异步加载 app 列表 — menuOpen 首次为 true 时跑 */
  useEffect(() => {
    if (!menuOpen || apps !== null || !filePath) return;
    setAppsLoading(true);
    const defaultName = isZh ? '系统默认 app' : 'System default app';
    (async () => {
      try {
        const api = (window as any).neox;
        const fn = api?.surfaceListExternalApps;
        if (!fn) { setApps([{ id: '__default__', name: defaultName, exists: true }]); return; }
        const r = await fn(filePath);
        const list: AppEntry[] = (r?.success && Array.isArray(r.apps)) ? r.apps : [];
        setApps(list.some(a => a.id === '__default__')
          ? list
          : [{ id: '__default__', name: defaultName, exists: true }, ...list]);
      } finally {
        setAppsLoading(false);
      }
    })();
  }, [menuOpen, apps, filePath, isZh]);

  /* 统一 popover 关闭逻辑 */
  usePopoverDismiss({
    open: menuOpen,
    refs: [arrowRef, menuRef],
    onDismiss: () => setMenuOpen(false),
  });

  const toggleMenu = useCallback(() => {
    if (menuOpen) { setMenuOpen(false); return; }
    const rect = arrowRef.current?.getBoundingClientRect();
    if (rect) {
      setMenuPos({
        top: rect.bottom + 4,
        right: Math.max(8, winOf(arrowRef.current).innerWidth - rect.right),
      });
    }
    setMenuOpen(true);
  }, [menuOpen]);

  if (!filePath) return null;

  const mainTitle = error
    ? (isZh ? `打开失败: ${error}` : `Failed to open: ${error}`)
    : busy ? (isZh ? '打开中…' : 'Opening…')
    : `${label ?? (isZh ? '在外部应用打开' : 'Open in external app')}${isZh ? ' (用系统默认 app)' : ' (system default app)'}`;

  return (
    <>
      <button
        ref={arrowRef}
        type="button"
        className={`sfc-open-ext-btn${error ? ' is-error' : ''}${busy ? ' is-busy' : ''}`}
        onClick={toggleMenu}
        title={mainTitle}
        disabled={busy}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
             strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 13 V19 a2 2 0 0 1 -2 2 H5 a2 2 0 0 1 -2 -2 V8 a2 2 0 0 1 2 -2 H11" />
          <path d="M15 3 H21 V9" />
          <path d="M10 14 L21 3" />
        </svg>
        <span className="sfc-open-ext-btn__label">{text ?? (isZh ? '外部打开' : 'Open ext.')}</span>
      </button>
      {menuOpen && menuPos && createPortal(
        <div
          ref={menuRef}
          className="sfc-export-menu"
          role="menu"
          style={{ top: menuPos.top, right: menuPos.right, minWidth: 220 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {appsLoading && (
            <div className="sfc-export-menu__item" style={{ opacity: 0.6, cursor: 'progress' }}>
              <span className="sfc-export-menu__item-label">{isZh ? '检测可用 app…' : 'Detecting apps…'}</span>
            </div>
          )}
          {!appsLoading && apps && apps.map(app => (
            <button
              key={app.id}
              type="button"
              className="sfc-export-menu__item"
              onClick={() => void onPickApp(app)}
              role="menuitem"
              disabled={!app.exists}
              style={!app.exists ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
              title={app.exists ? app.name : (isZh ? `${app.name} 未安装` : `${app.name} not installed`)}
            >
              <span className="sfc-export-menu__item-label">
                {app.name}
                {!app.exists && (
                  <span style={{
                    marginLeft: 6, fontSize: 10,
                    color: 'var(--neox-fg-hint)',
                    fontWeight: 'normal',
                  }}>{isZh ? '未安装' : 'not installed'}</span>
                )}
              </span>
              {/* 不再显示具体安装路径 — 信息冗余, 用户只关心 app 名 */}
            </button>
          ))}
          {!appsLoading && (!apps || apps.length === 0) && (
            <div className="sfc-export-menu__item" style={{ opacity: 0.6 }}>
              <span className="sfc-export-menu__item-label">{isZh ? '无可用 app' : 'No apps available'}</span>
            </div>
          )}
        </div>,
        /* 按钮在哪个窗口就挂哪个窗口 (Surface 独立窗口) */
        bodyOf(arrowRef.current),
      )}
    </>
  );
};

export default OpenInExternalAppButton;
