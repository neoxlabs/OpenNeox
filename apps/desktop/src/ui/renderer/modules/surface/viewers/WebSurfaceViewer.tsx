/**
 * WebSurfaceViewer — Neox 内嵌浏览器 (Chrome 风, 单 surface 内多 tab).
 *
 * 架构:
 *   · 右栏只有一个 surface tab "浏览器", 内部画自己的 tab bar 管多个网页 (Chrome / Arc 风)
 *   · 每个内部 tab = 一个 BrowserView (主进程那边 1:1 创建)
 *   · 切 tab: bringToFront 新 view + hide 其他, 网页状态保留不重新加载
 *   · 关 tab: destroy 对应 BrowserView + 从 metadata.tabs 移除
 *   · 新 tab: + 按钮 / agent 调 browser_new_tab → surfaceStore.addBrowserTab
 *
 * agent 操作:
 *   · BrowserView window.name = "neox-sfc-<tabId>", agent 用 tabId 作 surfaceId 操作
 *   · browser_list_surfaces 通过 CDP 反查每个 BrowserView, 自动返每个内部 tab
 *
 * 工具栏 (back / forward / reload / url bar / 收藏 / DevTools) 跟当前 active tab.
 *
 * useSuppressBrowserView fade 兼容: BrowserView 是 OS view 仍盖 DOM, 弹下拉时 fade 流程不变.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Surface } from '../../../state/surfaceStore';

/* 工具栏 icon — 统一 16×16 monoline SVG, 跟左 sidebar 风格一致, 解决 emoji/字符
 * 度量不齐 + 大小不一的问题. 全部 stroke=currentColor 跟随父 color. */
const ICON_PROPS = { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true } as const;
const IconBack = () => <svg {...ICON_PROPS}><path d="M12.5 8 H4.5 M8 4 L4.5 8 L8 12" /></svg>;
const IconForward = () => <svg {...ICON_PROPS}><path d="M3.5 8 H11.5 M8 4 L11.5 8 L8 12" /></svg>;
const IconReload = () => <svg {...ICON_PROPS}><path d="M13.5 8 A5.5 5.5 0 1 1 11.5 4 M13.5 3 V5.5 H11" /></svg>;
const IconStarFilled = () => <svg {...ICON_PROPS} fill="currentColor"><path d="M8 2.2 L9.65 5.7 L13.5 6.25 L10.75 8.95 L11.4 12.75 L8 10.95 L4.6 12.75 L5.25 8.95 L2.5 6.25 L6.35 5.7 Z" /></svg>;
const IconStarOutline = () => <svg {...ICON_PROPS}><path d="M8 2.2 L9.65 5.7 L13.5 6.25 L10.75 8.95 L11.4 12.75 L8 10.95 L4.6 12.75 L5.25 8.95 L2.5 6.25 L6.35 5.7 Z" /></svg>;
const IconCog = () => <svg {...ICON_PROPS}><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5 V3.5 M8 12.5 V14.5 M14.5 8 H12.5 M3.5 8 H1.5 M12.6 3.4 L11.2 4.8 M4.8 11.2 L3.4 12.6 M12.6 12.6 L11.2 11.2 M4.8 4.8 L3.4 3.4" /></svg>;
const IconExternal = () => <svg {...ICON_PROPS}><path d="M6.5 3.5 H3.5 V12.5 H12.5 V9.5 M9 3.5 H12.5 V7 M12.5 3.5 L7.5 8.5" /></svg>;
const IconChevronDown = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6.5 L8 10.5 L12 6.5" /></svg>;
/* IconClose / IconPlus 不再用 — chrome bar 接管 tab 关闭 + 新建 */

import {
  type BrowserTab,
  updateBrowserTab,
} from '../../../state/surfaceStore';
import { useBrowserMode } from './useBrowserMode';
import { ExternalChromeCard } from './ExternalChromeCard';
import { useNeoxRuntime } from '../../../app/NeoxRuntimeContext';
import { useSuppressBrowserView } from './useSuppressBrowserView';
import { useI18n } from '../../../hooks/useI18n';

interface Props {
  surface: Surface;
  isActive?: boolean;
}

const MAX_HISTORY = 30;
const MAX_BOOKMARKS = 50;
const HISTORY_KEY = 'neox.browser.history';
const BOOKMARK_KEY = 'neox.browser.bookmarks';

interface HistEntry { url: string; title: string; ts: number; }
interface BookmarkEntry { url: string; title: string; ts: number; }
interface BrowserBounds { x: number; y: number; width: number; height: number; }
interface EdgeRect { left: number; top: number; right: number; bottom: number; }

const BROWSER_VIEW_EDGE_GUARD_PX = 2;

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as any;
    return fallback;
  } catch { return fallback; }
}
function saveJson(key: string, val: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* */ }
}

function faviconForUrl(url: string): string | undefined {
  try {
    if (!url || url === 'about:blank' || url.startsWith('data:') || url.startsWith('file:')) return undefined;
    const u = new URL(url);
    return `${u.origin}/favicon.ico`;
  } catch { return undefined; }
}

function normalizeBrowserNavigationInput(input: string): string {
  let target = String(input ?? '').trim();
  if (!target || target.length > 4096) throw new Error('invalid url');
  if (target === 'about:blank') return target;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    target = `https://${target}`;
  }
  const parsed = new URL(target);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`browser navigation protocol not allowed: ${parsed.protocol}`);
  }
  return parsed.toString();
}

function titleFromUrl(url: string): string {
  try {
    if (url === 'about:blank') return 'untitled';
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function edgeRectFromDom(r: DOMRect): EdgeRect {
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
  };
}

function intersectRects(a: EdgeRect, b: EdgeRect): EdgeRect {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

function rectSize(r: EdgeRect): { width: number; height: number } {
  return {
    width: Math.max(0, r.right - r.left),
    height: Math.max(0, r.bottom - r.top),
  };
}

function elementClipsBrowserView(el: HTMLElement): boolean {
  const style = window.getComputedStyle(el);
  /* display: contents 不生成真实布局盒, getBoundingClientRect() 通常是 0x0.
   * 它不能裁剪 native BrowserView; 把它当 clip ancestor 会把可见区域算成 null,
   * 导致页面已加载但 BrowserView 被反复 hide. */
  if (style.display === 'contents') return false;
  const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
  return /(hidden|clip|auto|scroll)/.test(overflow);
}

function browserLayoutBlocksBrowserView(el: HTMLElement): boolean {
  const rightSlot = el.closest<HTMLElement>('.neox-shell__right--surface-slot');
  const rightMotion = rightSlot?.getAttribute('data-motion');
  return rightMotion === 'closing' || rightMotion === 'closed';
}

function reserveShellChromeForBrowserView(el: HTMLElement, visible: EdgeRect): EdgeRect {
  const rightSlot = el.closest<HTMLElement>('.neox-shell__right--surface-slot');
  if (!rightSlot) return visible;

  const slotRect = edgeRectFromDom(rightSlot.getBoundingClientRect());
  let leftGuard = BROWSER_VIEW_EDGE_GUARD_PX;
  const borderLeft = Number.parseFloat(window.getComputedStyle(rightSlot).borderLeftWidth || '0');
  if (Number.isFinite(borderLeft)) {
    leftGuard = Math.max(leftGuard, Math.ceil(borderLeft));
  }

  /* BrowserView 是 native view, 会盖住 DOM 的 divider/splitter。
   * right splitter 14px 命中区居中在 main/right 边界, 其中右半边伸入 right slot;
   * 这里把伸入的宽度从 BrowserView bounds 中扣掉, 让分割线和拖拽命中区不被网页吞掉。 */
  const glassCard = rightSlot.closest<HTMLElement>('.neox-shell__glass-card');
  const rightResizer = glassCard?.querySelector<HTMLElement>('.neox-shell__resizer--right');
  if (rightResizer && rightResizer.offsetParent !== null) {
    const resizerRect = rightResizer.getBoundingClientRect();
    const overlapsRightEdge = resizerRect.left < slotRect.left + 16 && resizerRect.right > slotRect.left;
    if (overlapsRightEdge) {
      leftGuard = Math.max(leftGuard, Math.ceil(resizerRect.right - slotRect.left));
    }
  }

  return intersectRects(visible, {
    left: slotRect.left + leftGuard,
    top: slotRect.top,
    right: slotRect.right,
    bottom: slotRect.bottom,
  });
}

function getBrowserBoundsSyncTargets(el: HTMLElement): HTMLElement[] {
  const targets = new Set<HTMLElement>([el]);
  let node = el.parentElement;
  while (node && node !== document.body) {
    if (elementClipsBrowserView(node)) targets.add(node);
    node = node.parentElement;
  }
  [
    '.sfc-web__viewport-stack',
    '.sfc-web',
    '.sfc-panel__body',
    '.sfc-panel',
    '.neox-shell__right-mode-pane',
    '.neox-shell__right-stack',
    '.neox-shell__right--surface-slot',
    '.neox-shell__glass-card',
    '.neox-shell',
  ].forEach((selector) => {
    const target = el.closest<HTMLElement>(selector);
    if (target) targets.add(target);
  });
  const glassCard = el.closest<HTMLElement>('.neox-shell__glass-card');
  const rightResizer = glassCard?.querySelector<HTMLElement>('.neox-shell__resizer--right');
  if (rightResizer) targets.add(rightResizer);
  return [...targets];
}

function readVisibleBrowserBounds(el: HTMLElement): BrowserBounds | null {
  if (el.offsetParent === null) return null;
  if (browserLayoutBlocksBrowserView(el)) return null;

  let visible = edgeRectFromDom(el.getBoundingClientRect());
  let size = rectSize(visible);
  if (size.width < 8 || size.height < 8) return null;

  let node = el.parentElement;
  while (node && node !== document.body) {
    if (elementClipsBrowserView(node)) {
      visible = intersectRects(visible, edgeRectFromDom(node.getBoundingClientRect()));
      size = rectSize(visible);
      if (size.width < 8 || size.height < 8) return null;
    }
    node = node.parentElement;
  }

  visible = intersectRects(visible, {
    left: 0,
    top: 0,
    right: Math.max(0, window.innerWidth),
    bottom: Math.max(0, window.innerHeight),
  });
  visible = reserveShellChromeForBrowserView(el, visible);

  const x = Math.max(0, Math.ceil(visible.left));
  const y = Math.max(0, Math.ceil(visible.top));
  const width = Math.max(0, Math.floor(visible.right) - x);
  const height = Math.max(0, Math.floor(visible.bottom) - y);
  if (width < 8 || height < 8) return null;
  return { x, y, width, height };
}

/** 单 tab 的 BrowserView 占位 div + lifecycle 管理. 每个 tab 独立 mount. */
const TabView: React.FC<{
  tab: BrowserTab;
  isActive: boolean;
  workspacePath: string | undefined;
}> = ({ tab, isActive, workspacePath }) => {
  const { isZh } = useI18n();
  const placeholderRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const viewVisibleRef = useRef(false);
  const isActiveRef = useRef(isActive);
  const [mountError, setMountError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const hideBrowserView = useCallback(() => {
    viewVisibleRef.current = false;
    const api = (window as any).neox;
    void api?.embeddedBrowserHide?.({ surfaceId: tab.id });
  }, [tab.id]);

  const reportBounds = useCallback(() => {
    if (!isActive) {
      hideBrowserView();
      return;
    }
    const el = placeholderRef.current;
    if (!el) return;
    const api = (window as any).neox;
    const bounds = readVisibleBrowserBounds(el);
    if (!bounds) {
      hideBrowserView();
      return;
    }
    void api?.embeddedBrowserSetBounds?.({
      surfaceId: tab.id,
      bounds,
    });
    viewVisibleRef.current = true;
    void api?.embeddedBrowserBringToFront?.({ surfaceId: tab.id });
  }, [tab.id, isActive, hideBrowserView]);

  /* Fix "reportBounds 闭包被 ResizeObserver 锁死" bug.
   * mount 阶段的 useEffect 依赖 [tab.id, workspacePath, retryNonce], 不带 reportBounds.
   * 结果: ResizeObserver 捕获的是第一次 render 时的 reportBounds, isActive 后来变了, 老闭包
   * 里 isActive 还是初始值. 用 ref 转发, 观察者永远调最新版. */
  const reportBoundsRef = useRef(reportBounds);
  useEffect(() => { reportBoundsRef.current = reportBounds; }, [reportBounds]);
  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);

  /* Mount BrowserView (一次性, tab 整个生命周期). */
  useEffect(() => {
    const el = placeholderRef.current;
    if (!el) return;
    const api = (window as any).neox;
    if (!api?.embeddedBrowserMount) return;
    let rafId: number | null = null;
    const timers = new Set<number>();
    const scheduleSync = () => {
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        reportBoundsRef.current();
      });
    };
    const scheduleSyncBurst = () => {
      scheduleSync();
      [80, 180, 320, 600].forEach((delay) => {
        const timer = window.setTimeout(() => {
          timers.delete(timer);
          scheduleSync();
        }, delay);
        timers.add(timer);
      });
    };

    setMountError(null);
    /* mount 时若 placeholder 尚未有真实布局 (面板初始折叠 / 首帧未 layout),
     * 用 0×0 bounds 挂载 — BrowserViewManager.applyVisibility 见 hidden 会推到 -10000,
     * 待 ResizeObserver 上报真实 bounds 再显示. 避免"先左上角闪一下 Ce favicon 再定位"回归. */
    const initialBounds = isActive ? readVisibleBrowserBounds(el) : null;
    void api.embeddedBrowserMount({
      surfaceId: tab.id,
      initialUrl: tab.url,
      bounds: initialBounds ?? { x: -10000, y: -10000, width: 0, height: 0 },
      workspacePath: workspacePath ?? undefined,
    }).then((res: any) => {
      if (res?.ok) {
        mountedRef.current = true;
        if (isActiveRef.current) {
          scheduleSyncBurst();
        } else {
          viewVisibleRef.current = false;
          void api.embeddedBrowserHide?.({ surfaceId: tab.id });
        }
      } else {
        const msg = res?.error || 'mount returned non-ok';
        console.warn('[WebSurfaceViewer] embeddedBrowserMount returned non-ok:', res);
        setMountError(msg);
      }
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[WebSurfaceViewer] embeddedBrowserMount failed:', msg);
      setMountError(msg);
    });

    /* 用 ref 转发, 拿到最新 reportBounds — 见上方 reportBoundsRef 注释. */
    const syncTargets = getBrowserBoundsSyncTargets(el);
    const obs = new ResizeObserver(scheduleSync);
    syncTargets.forEach((target) => obs.observe(target));

    const motionObserver = new MutationObserver(scheduleSyncBurst);
    syncTargets.forEach((target) => {
      motionObserver.observe(target, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-motion', 'data-sidebar-motion'],
      });
    });

    const onScroll = () => scheduleSync();
    const onLayoutDone = () => scheduleSyncBurst();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    window.visualViewport?.addEventListener('resize', onScroll);
    window.visualViewport?.addEventListener('scroll', onScroll);
    syncTargets.forEach((target) => {
      target.addEventListener('transitionend', onLayoutDone);
      target.addEventListener('animationend', onLayoutDone);
    });
    scheduleSyncBurst();

    return () => {
      obs.disconnect();
      motionObserver.disconnect();
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      window.visualViewport?.removeEventListener('resize', onScroll);
      window.visualViewport?.removeEventListener('scroll', onScroll);
      syncTargets.forEach((target) => {
        target.removeEventListener('transitionend', onLayoutDone);
        target.removeEventListener('animationend', onLayoutDone);
      });
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
      if (rafId != null) cancelAnimationFrame(rafId);
      const tabId = tab.id;
      const tryDestroy = (attempt: number): void => {
        api?.embeddedBrowserDestroy?.({ surfaceId: tabId })
          ?.catch?.((err: unknown) => {
            if (attempt < 2) {
              setTimeout(() => tryDestroy(attempt + 1), 250 * attempt);
            } else {
              console.error('[WebSurfaceViewer] embeddedBrowserDestroy failed after retry, BrowserView may leak:', tabId, err);
            }
          });
      };
      tryDestroy(1);
      mountedRef.current = false;
      viewVisibleRef.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, workspacePath, retryNonce]);

  /* isActive 切换 — bringToFront/hide BrowserView. */
  useEffect(() => {
    if (!mountedRef.current) return;
    if (isActive) {
      const raf = requestAnimationFrame(reportBounds);
      const t1 = window.setTimeout(reportBounds, 120);
      const t2 = window.setTimeout(reportBounds, 280);
      return () => {
        cancelAnimationFrame(raf);
        window.clearTimeout(t1);
        window.clearTimeout(t2);
      };
    }
    hideBrowserView();
  }, [isActive, tab.id, reportBounds, hideBrowserView]);

  useEffect(() => {
    if (!mountedRef.current || !isActive) return;
    const api = (window as any).neox;
    void api?.embeddedBrowserBringToFront?.({ surfaceId: tab.id });
    const raf = requestAnimationFrame(reportBounds);
    const t1 = window.setTimeout(reportBounds, 100);
    const t2 = window.setTimeout(reportBounds, 260);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [isActive, tab.id, tab.url, reportBounds]);

  return (
    <div
      className="sfc-web__viewport sfc-web__viewport--placeholder"
      ref={placeholderRef}
      data-browser-surface-id={tab.id}
      style={!isActive ? { visibility: 'hidden' } : undefined}
    >
      {mountError ? (
        <div className="sfc-web__empty" role="alert">
          <div style={{ fontSize: 13, color: 'var(--neox-danger-700, #b91c1c)', marginBottom: 8 }}>
            {isZh ? '⚠ 内嵌浏览器加载失败' : '⚠ Embedded browser failed to load'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--neox-fg-muted)', marginBottom: 12, maxWidth: 360, textAlign: 'center' }}>
            {mountError}
          </div>
          <button
            type="button"
            onClick={() => setRetryNonce((n) => n + 1)}
            style={{
              padding: '4px 12px',
              fontSize: 11,
              borderRadius: 4,
              border: '1px solid var(--neox-line)',
              background: 'var(--neox-bg-hover)',
              cursor: 'pointer',
            }}
          >
            {isZh ? '重试' : 'Retry'}
          </button>
        </div>
      ) : !tab.url || tab.url === 'about:blank' ? (
        <div className="sfc-web__empty">
          <svg className="sfc-web__empty-art" viewBox="0 0 120 120" aria-hidden="true">
            <defs>
              <radialGradient id={`sfc-web-empty-glow-${tab.id}`} cx="50%" cy="45%" r="55%">
                <stop offset="0%" stopColor="currentColor" stopOpacity="0.06" />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
              </radialGradient>
            </defs>
            <circle cx="60" cy="55" r="55" fill={`url(#sfc-web-empty-glow-${tab.id})`} />
            <rect x="22" y="32" width="76" height="56" rx="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <line x1="22" y1="44" x2="98" y2="44" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="29" cy="38" r="1.3" fill="currentColor" />
            <circle cx="34" cy="38" r="1.3" fill="currentColor" />
            <circle cx="39" cy="38" r="1.3" fill="currentColor" />
            <rect x="46" y="35.5" width="44" height="5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="0.9" opacity="0.6" />
            <path d="M62 64 L74 70 L68 71 L72 78 L70 79 L66 72 L62 76 Z" fill="var(--neox-primary-500, #7c5cff)" opacity="0.95" />
            <line x1="32" y1="56" x2="50" y2="56" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.45" />
            <line x1="32" y1="62" x2="44" y2="62" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.3" />
            <line x1="32" y1="76" x2="56" y2="76" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.45" />
            <line x1="32" y1="82" x2="48" y2="82" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.3" />
          </svg>
          <div className="sfc-web__empty-title">{isZh ? '新标签页' : 'New tab'}</div>
          <div className="sfc-web__empty-subtitle">{isZh ? '在上方地址栏输入网址开始浏览' : 'Enter a URL in the address bar above to start browsing'}</div>
        </div>
      ) : null}
    </div>
  );
};

/**
 * WebSurfaceViewer — top-level 分派器. 只调 useBrowserMode 一个 hook, 按 mode 派到子组件.
 *   external → ExternalChromeCard (真 Chrome, Neox 里只显状态卡)
 *   loading  → 短暂骨架 (~10ms, 主进程冷启动一次返 mode 就稳定)
 *   embedded → EmbeddedWebSurfaceViewer (老路径, 内嵌 BrowserView)
 * 分派 pattern 避免 hooks 数量在 mode 变化时突变 (React hook 顺序违规). */
export const WebSurfaceViewer: React.FC<Props> = (props) => {
  const browserMode = useBrowserMode();
  if (browserMode === 'external') return <ExternalChromeCard surface={props.surface} />;
  if (browserMode === 'loading') return <div className="sfc-web sfc-web--mode-loading" aria-busy="true" />;
  return <EmbeddedWebSurfaceViewer {...props} />;
};

const EmbeddedWebSurfaceViewer: React.FC<Props> = ({ surface, isActive = true }) => {
  const { workspacePath, activeSession } = useNeoxRuntime();
  const { isZh } = useI18n();
  const sessionId: string = activeSession?.id ?? '';

  const tabs: BrowserTab[] = useMemo(
    () => ((surface.metadata?.tabs as BrowserTab[] | undefined) ?? []),
    [surface.metadata],
  );
  const activeTabId: string = useMemo(
    () => (surface.metadata?.activeTabId as string | undefined) ?? tabs[0]?.id ?? '',
    [surface.metadata, tabs],
  );
  const activeTab: BrowserTab | undefined = useMemo(
    () => tabs.find(t => t.id === activeTabId) ?? tabs[0],
    [tabs, activeTabId],
  );

  /* 工具栏状态跟 active tab 同步 */
  const [inputUrl, setInputUrl] = useState<string>(() => activeTab?.url ?? 'about:blank');
  useEffect(() => {
    if (activeTab?.url) {
      const ae = document.activeElement;
      const isEditingUrl = ae instanceof HTMLInputElement && ae.classList.contains('sfc-web__urlbar');
      if (!isEditingUrl) setInputUrl(activeTab.url);
    }
  }, [activeTab?.url]);

  const [history, setHistory] = useState<HistEntry[]>(() => loadJson<HistEntry[]>(HISTORY_KEY, []));
  const [bookmarks, setBookmarks] = useState<BookmarkEntry[]>(() => loadJson<BookmarkEntry[]>(BOOKMARK_KEY, []));
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const urlbarRef = useRef<HTMLInputElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useSuppressBrowserView(menuOpen, menuRef);

  const isBookmarked = useMemo(
    () => !!activeTab?.url && bookmarks.some(b => b.url === activeTab.url),
    [bookmarks, activeTab?.url],
  );

  /* 周期同步当前 active tab 的 URL / title 给 surfaceStore (用户在 BrowserView 自己导航时). */
  useEffect(() => {
    if (!activeTab || !sessionId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (!alive) return;
      const api = (window as any).neox;
      if (api?.embeddedBrowserGetState) {
        try {
          const s = await api.embeddedBrowserGetState({ surfaceId: activeTab.id });
          if (s && alive) {
            const newUrl = typeof s.url === 'string' ? s.url : activeTab.url;
            const newTitle = typeof s.title === 'string' ? s.title : activeTab.title;
            if (newUrl !== activeTab.url || newTitle !== activeTab.title) {
              updateBrowserTab(sessionId, surface.id, activeTab.id, { url: newUrl, title: newTitle });
              if (newUrl && newUrl !== 'about:blank' && !newUrl.startsWith('data:')) {
                setHistory(prev => {
                  if (prev[0]?.url === newUrl) return prev;
                  const filtered = prev.filter(h => h.url !== newUrl);
                  const next = [{ url: newUrl, title: newTitle || newUrl, ts: Date.now() }, ...filtered].slice(0, MAX_HISTORY);
                  saveJson(HISTORY_KEY, next);
                  return next;
                });
              }
            }
          }
        } catch { /* */ }
      }
      if (alive) timer = setTimeout(tick, 1500);
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, sessionId, surface.id]);

  /* 全局 mousedown / Esc 关菜单 */
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuBtnRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    const t = setTimeout(() => {
      window.addEventListener('mousedown', onDown);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const navigateActiveTab = useCallback((rawTarget: string) => {
    if (!activeTab) return;
    let target: string;
    try {
      target = normalizeBrowserNavigationInput(rawTarget);
    } catch {
      return;
    }
    const optimisticTitle = titleFromUrl(target);
    setInputUrl(target);
    if (sessionId) {
      updateBrowserTab(sessionId, surface.id, activeTab.id, {
        url: target,
        title: optimisticTitle,
        loading: true,
      });
    }

    const api = (window as any).neox;
    const runNavigate = (attempt: number): void => {
      void api?.embeddedBrowserShow?.({ surfaceId: activeTab.id });
      const navPromise = api?.embeddedBrowserNavigate?.({ surfaceId: activeTab.id, url: target });
      if (!navPromise?.then) {
        if (sessionId) {
          updateBrowserTab(sessionId, surface.id, activeTab.id, { loading: false });
        }
        return;
      }
      void navPromise.then((res: any) => {
        if (res?.ok === false) {
          if (attempt < 3) {
            window.setTimeout(() => runNavigate(attempt + 1), 120 * attempt);
            return;
          }
          if (sessionId) {
            updateBrowserTab(sessionId, surface.id, activeTab.id, { loading: false });
          }
          return;
        }
        const nextUrl = typeof res?.url === 'string' && res.url ? res.url : target;
        const nextTitle = typeof res?.title === 'string' && res.title ? res.title : titleFromUrl(nextUrl);
        if (sessionId) {
          updateBrowserTab(sessionId, surface.id, activeTab.id, {
            url: nextUrl,
            title: nextTitle,
            loading: false,
          });
        }
        if (nextUrl && nextUrl !== 'about:blank' && !nextUrl.startsWith('data:')) {
          setHistory(prev => {
            if (prev[0]?.url === nextUrl) return prev;
            const filtered = prev.filter(h => h.url !== nextUrl);
            const next = [{ url: nextUrl, title: nextTitle || nextUrl, ts: Date.now() }, ...filtered].slice(0, MAX_HISTORY);
            saveJson(HISTORY_KEY, next);
            return next;
          });
        }
      }).catch(() => {
        if (attempt < 3) {
          window.setTimeout(() => runNavigate(attempt + 1), 120 * attempt);
          return;
        }
        if (sessionId) {
          updateBrowserTab(sessionId, surface.id, activeTab.id, { loading: false });
        }
      });
    };
    runNavigate(1);
  }, [activeTab, sessionId, surface.id]);

  const submitUrl = useCallback(() => {
    navigateActiveTab(inputUrl);
  }, [inputUrl, navigateActiveTab]);

  const reload = useCallback(() => {
    if (!activeTab) return;
    void (window as any).neox?.embeddedBrowserReload?.({ surfaceId: activeTab.id });
  }, [activeTab]);
  const goBack = useCallback(() => {
    if (!activeTab) return;
    void (window as any).neox?.embeddedBrowserBack?.({ surfaceId: activeTab.id });
  }, [activeTab]);
  const goForward = useCallback(() => {
    if (!activeTab) return;
    void (window as any).neox?.embeddedBrowserForward?.({ surfaceId: activeTab.id });
  }, [activeTab]);
  const toggleDevTools = useCallback(() => {
    if (!activeTab) return;
    void (window as any).neox?.embeddedBrowserToggleDevTools?.({ surfaceId: activeTab.id });
  }, [activeTab]);
  const openExternal = useCallback(() => {
    if (!activeTab?.url) return;
    const api = (window as any).neox;
    if (typeof api?.openExternal === 'function') void api.openExternal(activeTab.url);
    else window.open(activeTab.url, '_blank', 'noopener,noreferrer');
  }, [activeTab?.url]);

  const toggleBookmark = useCallback(() => {
    if (!activeTab?.url) return;
    const url = activeTab.url;
    const title = activeTab.title || url;
    setBookmarks(prev => {
      const idx = prev.findIndex(b => b.url === url);
      const next = idx >= 0
        ? prev.filter(b => b.url !== url)
        : [{ url, title, ts: Date.now() }, ...prev].slice(0, MAX_BOOKMARKS);
      saveJson(BOOKMARK_KEY, next);
      return next;
    });
  }, [activeTab]);

  const openMenu = useCallback(() => {
    if (menuOpen) { setMenuOpen(false); return; }
    const rect = urlbarRef.current?.getBoundingClientRect();
    if (rect) setMenuPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    setMenuOpen(true);
  }, [menuOpen]);

  const navigateTo = useCallback((target: string) => {
    navigateActiveTab(target);
    setMenuOpen(false);
  }, [navigateActiveTab]);

  const removeBookmark = useCallback((u: string) => {
    setBookmarks(prev => {
      const next = prev.filter(b => b.url !== u);
      saveJson(BOOKMARK_KEY, next);
      return next;
    });
  }, []);
  const clearHistory = useCallback(() => {
    setHistory([]);
    saveJson(HISTORY_KEY, []);
  }, []);

  /* tab 切换 / 新建 / 关闭都搬到 SurfacePanel chrome bar 统一处理, 这里不再需要 */

  return (
    <div className="sfc-web">
      {/* web 不再画自己的 tab bar — browser tabs 全部走 SurfacePanel 顶部统一 chrome bar,
       *   chrome 里 web kind 还会额外渲染一个 "+ 新建标签页" 按钮. 这里只剩 URL 工具栏 + viewport. */}
      {/* URL 工具栏 — 跟 active tab. 全部 16×16 SVG icon, 视觉对齐严格 */}
      <div className="sfc-web__toolbar">
        <button type="button" className="sfc-web__nav-btn" onClick={goBack} title={isZh ? '后退' : 'Back'} aria-label={isZh ? '后退' : 'Back'}><IconBack /></button>
        <button type="button" className="sfc-web__nav-btn" onClick={goForward} title={isZh ? '前进' : 'Forward'} aria-label={isZh ? '前进' : 'Forward'}><IconForward /></button>
        <button type="button" className="sfc-web__nav-btn" onClick={reload} title={isZh ? '刷新' : 'Reload'} aria-label={isZh ? '刷新' : 'Reload'}><IconReload /></button>
        <div className="sfc-web__urlbar-wrap">
          <input
            ref={urlbarRef}
            type="text"
            className="sfc-web__urlbar"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitUrl();
              }
            }}
            spellCheck={false}
            placeholder="https://..."
          />
          <button
            ref={menuBtnRef}
            type="button"
            className="sfc-web__urlbar-menu-btn"
            onClick={openMenu}
            title={isZh ? '历史 / 收藏' : 'History / bookmarks'}
            aria-expanded={menuOpen}
            aria-label={isZh ? '历史和收藏' : 'History and bookmarks'}
          ><IconChevronDown /></button>
        </div>
        <button
          type="button"
          className={`sfc-web__nav-btn${isBookmarked ? ' is-star-on' : ''}`}
          onClick={toggleBookmark}
          disabled={!activeTab?.url || activeTab.url === 'about:blank'}
          title={isBookmarked ? (isZh ? '取消收藏' : 'Remove bookmark') : (isZh ? '收藏此页' : 'Bookmark this page')}
          aria-label={isBookmarked ? (isZh ? '取消收藏' : 'Remove bookmark') : (isZh ? '收藏' : 'Bookmark')}
        >{isBookmarked ? <IconStarFilled /> : <IconStarOutline />}</button>
        <button type="button" className="sfc-web__nav-btn" onClick={toggleDevTools} title="DevTools (Inspect)" aria-label="DevTools"><IconCog /></button>
        <button type="button" className="sfc-web__nav-btn" onClick={openExternal} title={isZh ? '在外部浏览器打开' : 'Open in external browser'} aria-label={isZh ? '在外部浏览器打开' : 'Open in external browser'}><IconExternal /></button>
      </div>

      {/* 所有 tab 的 BrowserView 全部 mount; 只 active 那个 show (其他 hide). 切 tab 0 重载. */}
      <div className="sfc-web__viewport-stack">
        {tabs.map(t => (
          <TabView
            key={t.id}
            tab={t}
            isActive={isActive && t.id === activeTabId}
            workspacePath={workspacePath}
          />
        ))}
      </div>

      {menuOpen && menuPos && createPortal(
        <div
          ref={menuRef}
          className="sfc-web__menu"
          style={{ top: menuPos.top, left: menuPos.left, minWidth: menuPos.width }}
          onMouseDown={(e) => e.stopPropagation()}
          role="menu"
        >
          {bookmarks.length > 0 && (
            <>
              <div className="sfc-web__menu-section">{isZh ? '收藏' : 'Bookmarks'}</div>
              {bookmarks.map(b => (
                <div key={b.url} className="sfc-web__menu-row">
                  <button
                    type="button"
                    className="sfc-web__menu-item"
                    onClick={() => navigateTo(b.url)}
                    title={b.url}
                  >
                    <span className="sfc-web__menu-star">★</span>
                    <span className="sfc-web__menu-text">
                      <span className="sfc-web__menu-title">{b.title}</span>
                      <span className="sfc-web__menu-url">{b.url}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="sfc-web__menu-del"
                    onClick={(e) => { e.stopPropagation(); removeBookmark(b.url); }}
                    title={isZh ? '取消收藏' : 'Remove bookmark'}
                  >×</button>
                </div>
              ))}
            </>
          )}
          {history.length > 0 && (
            <>
              <div className="sfc-web__menu-section sfc-web__menu-section--with-action">
                <span>{isZh ? '历史' : 'History'}</span>
                <button type="button" onClick={clearHistory} className="sfc-web__menu-section-action">{isZh ? '清空' : 'Clear'}</button>
              </div>
              {history.slice(0, 20).map(h => (
                <button
                  key={`${h.url}-${h.ts}`}
                  type="button"
                  className="sfc-web__menu-item"
                  onClick={() => navigateTo(h.url)}
                  title={h.url}
                >
                  <span className="sfc-web__menu-text">
                    <span className="sfc-web__menu-title">{h.title}</span>
                    <span className="sfc-web__menu-url">{h.url}</span>
                  </span>
                </button>
              ))}
            </>
          )}
          {bookmarks.length === 0 && history.length === 0 && (
            <div className="sfc-web__menu-empty">{isZh
              ? '暂无历史 / 收藏 — 浏览几个页面后再回来'
              : 'No history or bookmarks yet — browse a few pages and come back'}</div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
};

export { faviconForUrl };
export default WebSurfaceViewer;
