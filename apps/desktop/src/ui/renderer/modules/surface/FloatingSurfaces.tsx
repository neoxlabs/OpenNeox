import React from 'react';
import { createPortal } from 'react-dom';
import type { Surface } from '../../state/surfaceStore';
import { setActiveSurface, setActiveBrowserTab } from '../../state/surfaceStore';
import { dockFloating, type FloatingSurface } from '../../state/floatingSurfacesStore';
import { useI18n } from '../../hooks/useI18n';
import { trackInteractionIn, mirrorMainListenersTo } from '../../utils/ownerDoc';

type Tab = { id: string; url?: string; title?: string };

/** 子窗口里给查看器的那一份: 文件类容器只留被拖出来的那一个文件 */
export function floatView(host: Surface, f: FloatingSurface): { surface: Surface; title: string } | null {
  const tabs = (host.metadata?.tabs as Tab[] | undefined) ?? [];
  const tabTitle = (t: Tab) => t.title || String(t.url ?? '').split(/[/\\]/).pop() || host.title;
  if (!f.tabId) {
    /* 整格搬出来的文件类容器 (只有一个文件): 窗口标题用文件名, 不是「Word」「源码」这种容器名 */
    const only = tabs.length === 1 ? tabs[0] : undefined;
    return { surface: host, title: only ? tabTitle(only) : (host.title || host.kind) };
  }
  const tab = tabs.find((t) => t.id === f.tabId);
  if (!tab) return null;
  return {
    surface: { ...host, metadata: { ...host.metadata, tabs: [tab], activeTabId: tab.id } },
    title: tabTitle(tab),
  };
}

const MIRROR = 'data-neox-mirror';

/** 主窗口 head 里的样式整份镜像到子窗口 (先删旧镜像再克隆, HMR 换样式时也跟上) */
function mirrorHead(doc: Document): void {
  doc.head.querySelectorAll(`[${MIRROR}]`).forEach((n) => n.remove());
  document.head.querySelectorAll('style, link[rel="stylesheet"]').forEach((n) => {
    const c = n.cloneNode(true) as HTMLElement;
    c.setAttribute(MIRROR, '');
    doc.head.appendChild(c);
  });
}

function mirrorRootAttrs(doc: Document): void {
  const src = document.documentElement;
  const dst = doc.documentElement;
  for (const a of Array.from(dst.attributes)) if (!src.hasAttribute(a.name)) dst.removeAttribute(a.name);
  for (const a of Array.from(src.attributes)) dst.setAttribute(a.name, a.value);
  dst.classList.remove('is-sfc-tab-dragging');
}

type PopoutEvent = {
  name: string;
  type: 'move' | 'moved' | 'closed' | 'state';
  bounds?: { x: number; y: number; width: number; height: number };
  tucked?: boolean; pinned?: boolean; peeking?: boolean; side?: 'left' | 'right';
};
/* 主进程只有一条推送通道, 这里按窗口名分发给各个 PopoutWin (第一次用时才订阅) */
const popoutHandlers = new Map<string, (ev: PopoutEvent) => void>();
let popoutChannelOff: (() => void) | null = null;
function onPopoutEvent(name: string, fn: (ev: PopoutEvent) => void): () => void {
  popoutHandlers.set(name, fn);
  if (!popoutChannelOff) {
    const sub = (window as unknown as { neox?: { onSurfacePopoutEvent?: (cb: (ev: PopoutEvent) => void) => () => void } })
      .neox?.onSurfacePopoutEvent;
    popoutChannelOff = sub ? sub((ev) => popoutHandlers.get(ev.name)?.(ev)) : () => {};
  }
  return () => { if (popoutHandlers.get(name) === fn) popoutHandlers.delete(name); };
}

const PopoutWin: React.FC<{
  sessionId: string;
  f: FloatingSurface;
  surface: Surface;
  title: string;
  icon?: React.ReactNode;
  renderBody: (s: Surface, viewKey: string, isZh: boolean) => React.ReactNode;
}> = ({ sessionId, f, surface, title, icon, renderBody }) => {
  const { isZh } = useI18n();
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  const winRef = React.useRef<Window | null>(null);
  const [winState, setWinState] = React.useState({ tucked: false, pinned: false, peeking: false, side: 'right' as 'left' | 'right' });
  const winName = `neox-sfc-pop:${f.sessionId}:${f.key}`;
  const api = (window as unknown as { neox?: Record<string, (...a: unknown[]) => unknown> }).neox;
  /* 竖条: 鼠标停 300ms 才探出 (一划而过不弹; 快速点一下 = 回原位, 不会先被探出抢走),
   * 离开等 220ms 再缩回 (从竖条滑到展开的窗口那一下不算离开) */
  const leaveT = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const enterT = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onStripEnter = () => {
    if (leaveT.current) { clearTimeout(leaveT.current); leaveT.current = null; }
    /* 已经探出: 告诉主进程鼠标回来了 (它可能正在等光标离开标题栏) */
    if (winState.tucked && winState.peeking) { void api?.surfacePopoutPeek?.(winName, true); return; }
    if (!winState.tucked || enterT.current) return;
    enterT.current = setTimeout(() => { enterT.current = null; void api?.surfacePopoutPeek?.(winName, true); }, 300);
  };
  const onStripLeave = () => {
    if (enterT.current) { clearTimeout(enterT.current); enterT.current = null; }
    if (!winState.tucked) return;
    if (leaveT.current) clearTimeout(leaveT.current);
    leaveT.current = setTimeout(() => { void api?.surfacePopoutPeek?.(winName, false); }, 220);
  };
  const restoreFromStrip = () => {
    if (enterT.current) { clearTimeout(enterT.current); enterT.current = null; }
    void api?.surfacePopoutUntuck?.(winName);
  };

  const dockBack = React.useCallback(() => {
    dockFloating(sessionId, f.key);
    setActiveSurface(sessionId, f.hostId);
    if (f.tabId) setActiveBrowserTab(sessionId, f.hostId, f.tabId);
  }, [sessionId, f.key, f.hostId, f.tabId]);
  const dockBackRef = React.useRef(dockBack);
  dockBackRef.current = dockBack;

  /* 开窗只做一次 (按 key); 卸载 (放回右栏) 时关窗。切会话不卸载 —— 窗口按全部会话常驻 */
  React.useEffect(() => {
    const { x, y, w, h } = f.geom;
    const win = window.open('about:blank', winName,
      `left=${Math.round(x)},top=${Math.round(y)},width=${Math.round(w)},height=${Math.round(h)}`);
    if (!win) { dockBackRef.current(); return undefined; }
    winRef.current = win;
    const doc = win.document;
    const base = doc.createElement('base');
    base.href = location.href;
    doc.head.appendChild(base);
    const meta = doc.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    doc.head.appendChild(meta);
    mirrorHead(doc);
    mirrorRootAttrs(doc);
    const headObs = new MutationObserver(() => mirrorHead(doc));
    headObs.observe(document.head, { childList: true, subtree: true, characterData: true });
    const rootObs = new MutationObserver(() => mirrorRootAttrs(doc));
    rootObs.observe(document.documentElement, { attributes: true });
    doc.body.className = 'sfc-popwin-body';
    const root = doc.createElement('div');
    root.className = 'sfc-popwin-root';
    doc.body.appendChild(root);
    setContainer(root);
    /* 右键菜单 / 对话框这类没有锚点的弹层靠它判断该开在哪个窗口 (utils/ownerDoc) */
    const untrack = trackInteractionIn(win);
    /* 主窗口的点外面关菜单 / Esc / 快捷键监听同步挂到这个窗口 */
    const unmirror = mirrorMainListenersTo(win);
    /* 松手那一下焦点还在主窗口, 新窗口会被压在主窗口底下 —— 等这一拍过去再提到最前 */
    const focusT = window.setTimeout(() => { try { win.focus(); } catch { /* 已关 */ } }, 60);

    /* 窗口事件由主进程推 (surfacePopouts.ts), 不轮询:
     *   · move: 一路推坐标 —— 标题栏中点落在主窗口右栏标签栏上 (上下各放宽 30) 就给标签栏描蓝
     *   · moved: 松手 / 停稳 —— 这时还在标签栏上就合并回右栏
     *   · closed: 用户点红灯 → 放回右栏 (不是关掉这个标签)
     *   · state: 收到屏幕边上 / 探出 / 钉住 */
    let closedByUs = false;
    let targetBar: Element | null = null;
    const setTarget = (bar: Element | null) => {
      if (targetBar === bar) return;
      targetBar?.classList.remove('is-merge-target');
      bar?.classList.add('is-merge-target');
      targetBar = bar;
    };
    const overDockBar = (b: { x: number; y: number; width: number }): Element | null => {
      const bar = document.querySelector('.neox-shell .sfc-chrome');
      const r = bar?.getBoundingClientRect();
      if (!bar || !r || r.width <= 0 || document.visibilityState !== 'visible') return null;
      const ox = window.screenX;
      const oy = window.screenY + (window.outerHeight - window.innerHeight);
      const px = b.x + b.width / 2;
      const py = b.y + 20;
      return px >= ox + r.left && px <= ox + r.right && py >= oy + r.top - 30 && py <= oy + r.bottom + 30 ? bar : null;
    };
    const offEvents = onPopoutEvent(winName, (ev) => {
      if (ev.type === 'move' && ev.bounds) setTarget(overDockBar(ev.bounds));
      else if (ev.type === 'moved' && ev.bounds) {
        const hit = overDockBar(ev.bounds);
        setTarget(null);
        if (hit) dockBackRef.current();
      } else if (ev.type === 'closed') {
        setTarget(null);
        if (!closedByUs) dockBackRef.current();
      } else if (ev.type === 'state') {
        setWinState({ tucked: !!ev.tucked, pinned: !!ev.pinned, peeking: !!ev.peeking, side: ev.side === 'left' ? 'left' : 'right' });
      }
    });
    return () => {
      closedByUs = true;
      offEvents();
      window.clearTimeout(focusT);
      setTarget(null);
      untrack();
      unmirror();
      headObs.disconnect();
      rootObs.disconnect();
      setContainer(null);
      if (!win.closed) win.close();
      winRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.key]);

  React.useEffect(() => {
    if (winRef.current && !winRef.current.closed) winRef.current.document.title = title;
  }, [title, container]);

  const stripHandlers = React.useRef({ enter: onStripEnter, leave: onStripLeave });
  stripHandlers.current = { enter: onStripEnter, leave: onStripLeave };
  React.useEffect(() => {
    const doc = container?.ownerDocument;
    if (!doc) return undefined;
    const enter = () => stripHandlers.current.enter();
    const leave = () => stripHandlers.current.leave();
    doc.documentElement.addEventListener('mouseenter', enter);
    doc.documentElement.addEventListener('mouseleave', leave);
    return () => {
      doc.documentElement.removeEventListener('mouseenter', enter);
      doc.documentElement.removeEventListener('mouseleave', leave);
    };
  }, [container]);

  if (!container) return null;
  const stripOnly = winState.tucked && !winState.peeking;
  return createPortal(
    <div
      className={`sfc-panel sfc-popwin${winState.tucked ? ' is-tucked' : ''}${stripOnly ? ' is-strip' : ''}${winState.pinned ? ' is-pinned' : ''} is-side-${winState.side}`}
    >
      {/* 收在屏幕边上的书签: 标签自己的图标 + 竖排名字 + 一道把手线; 停 0.3 秒整窗探出, 快点一下回原位。
       * 窗口往屏幕外让出 10px (主进程 STRIP_OVERHANG), 内容往屏幕里那侧收 10px, 不被裁掉 */}
      {stripOnly && (
        <button type="button" className="sfc-popwin__strip" onClick={restoreFromStrip}
          title={isZh ? `${title} · 停一下展开，点一下回到原来的位置` : `${title} · hover to peek, click to restore`}>
          <span className="sfc-popwin__strip-icon" aria-hidden="true">{icon}</span>
          <span className="sfc-popwin__strip-title">{title}</span>
          <span className="sfc-popwin__strip-grip" aria-hidden="true" />
        </button>
      )}
      {/* 顶栏: 整条是系统拖动区 (红绿灯在左边); 右边 钉住 / 收到边上 (或探出时: 回原位) / 放回右栏 */}
      <div className="sfc-popwin__bar">
        <span className="sfc-popwin__title">{title}</span>
        {winState.tucked ? (
          <button type="button" className="sfc-popwin__btn" onClick={() => void api?.surfacePopoutUntuck?.(winName)}
            title={isZh ? '回到原来的位置' : 'Restore position'}>
            <span>{isZh ? '回原位' : 'Restore'}</span>
          </button>
        ) : (
          <button type="button" className="sfc-popwin__btn sfc-popwin__btn--icon" onClick={() => void api?.surfacePopoutTuck?.(winName)}
            title={isZh ? '收到屏幕边上 (回主界面时挡着的会自动收)' : 'Tuck to screen edge'} aria-label={isZh ? '收到边上' : 'Tuck'}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 3.5 14 8l-4 4.5" /><path d="M14 8H5" /><path d="M2 2.5v11" />
            </svg>
          </button>
        )}
        <button type="button" className={`sfc-popwin__btn sfc-popwin__btn--icon${winState.pinned ? ' is-on' : ''}`}
          onClick={() => void api?.surfacePopoutPin?.(winName, !winState.pinned)}
          title={winState.pinned ? (isZh ? '取消钉住' : 'Unpin') : (isZh ? '钉住: 不自动收起, 一直在最前' : 'Pin: stay on top, never tuck')}
          aria-pressed={winState.pinned} aria-label={isZh ? '钉住' : 'Pin'}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill={winState.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 2h4l-.6 4.2L12 8.5v1H4v-1l2.6-2.3z" /><path d="M8 9.5V14" strokeLinecap="round" />
          </svg>
        </button>
        <button type="button" className="sfc-popwin__btn" onClick={dockBack}
          title={isZh ? '放回右栏' : 'Dock back'} aria-label={isZh ? '放回右栏' : 'Dock back'}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
            <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" /><path d="M9.5 3v10" />
          </svg>
          <span>{isZh ? '放回右栏' : 'Dock'}</span>
        </button>
      </div>
      {renderBody(surface, f.viewKey, isZh)}
    </div>,
    container,
  );
};

/** 一个独立窗口 + 它此刻要显示的内容 (SurfacePanel 按各自会话的 surface 算好传进来)。
 *  view 为空 + lost: 那个会话的数据在, 但这个标签已经被关掉了 (agent 关、⌘W、文件被删)。
 *  view 为空但不 lost: 那个会话的数据还没读回来, 先等, 别误判成关掉了。 */
export interface PopoutEntry {
  f: FloatingSurface;
  view: { surface: Surface; title: string; icon?: React.ReactNode } | null;
  lost: boolean;
}

export const FloatingSurfaces: React.FC<{
  entries: PopoutEntry[];
  renderBody: (s: Surface, viewKey: string, isZh: boolean) => React.ReactNode;
}> = ({ entries, renderBody }) => {
  /* 标签在别处被关掉了 —— 窗口跟着收掉, 不留空壳 */
  React.useEffect(() => {
    for (const e of entries) if (e.lost) dockFloating(e.f.sessionId, e.f.key);
  });
  return (
    <>
      {entries.map(({ f, view }) => view && (
        <PopoutWin key={`${f.sessionId}:${f.key}`} sessionId={f.sessionId} f={f} surface={view.surface} title={view.title} icon={view.icon} renderBody={renderBody} />
      ))}
    </>
  );
};
