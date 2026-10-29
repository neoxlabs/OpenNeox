import React from 'react';
import { createPortal } from 'react-dom';

const hosts = new Map<string, HTMLDivElement>();
type ScrollSnap = Array<[Element, number, number]>;
const snaps = new WeakMap<HTMLElement, ScrollSnap>();

const scrolled = new WeakMap<HTMLElement, Set<Element>>();

function hostFor(key: string): HTMLDivElement {
  let el = hosts.get(key);
  if (!el) {
    el = document.createElement('div');
    el.className = 'sfc-viewhost';
    el.dataset.viewKey = key;
    const seen = new Set<Element>();
    scrolled.set(el, seen);
    el.addEventListener('scroll', (ev) => { if (ev.target instanceof Element) seen.add(ev.target); }, { capture: true, passive: true });
    hosts.set(key, el);
  }
  return el;
}

/** 搬家前记下滚过的元素 (只看收到过 scroll 事件的那几个) */
function snapshotScroll(host: HTMLElement): void {
  const out: ScrollSnap = [];
  if (host.scrollTop || host.scrollLeft) out.push([host, host.scrollTop, host.scrollLeft]);
  const seen = scrolled.get(host);
  if (seen) {
    for (const e of seen) {
      if (!e.isConnected || !host.contains(e)) { seen.delete(e); continue; }
      if (e.scrollTop || e.scrollLeft) out.push([e, e.scrollTop, e.scrollLeft]);
    }
  }
  snaps.set(host, out);
}

function restoreScroll(host: HTMLElement): void {
  const s = snaps.get(host);
  if (!s?.length) return;
  snaps.delete(host);
  /* 新位置布局完再还原, 不然容器高度还是 0, scrollTop 设不进去 */
  const win = host.ownerDocument.defaultView ?? window;
  win.requestAnimationFrame(() => {
    for (const [e, t, l] of s) { e.scrollTop = t; e.scrollLeft = l; }
  });
}

/** 查看器出现的地方: 只是一个空槽, 宿主 div 搬进来 */
export const ViewSlot: React.FC<{ viewKey: string; hidden?: boolean }> = ({ viewKey, hidden }) => {
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return undefined;
    const host = hostFor(viewKey);
    slot.appendChild(host);
    restoreScroll(host);
    /* 宿主搬了家 (可能进了别的窗口): 让里面按尺寸排版的东西 (终端 fit、编辑器 layout) 重新量一次 */
    const win = slot.ownerDocument.defaultView;
    win?.requestAnimationFrame(() => win.dispatchEvent(new Event('resize')));
    return () => {
      /* 卸槽先于 DOM 移除, 这一刻宿主还在布局树里, 滚动位置读得到 */
      if (host.parentElement === slot) snapshotScroll(host);
    };
  }, [viewKey]);
  return <div ref={ref} className="sfc-viewslot" style={hidden ? { display: 'none' } : undefined} />;
};

export interface ViewerPortalItem { key: string; node: React.ReactNode }

/** 所有查看器都在这里 portal 进各自的宿主; 列表里没有了的宿主一起扔掉 */
export const ViewerPortals: React.FC<{ items: ViewerPortalItem[] }> = ({ items }) => {
  React.useEffect(() => {
    const live = new Set(items.map((i) => i.key));
    for (const [k, el] of hosts) {
      if (!live.has(k)) { el.remove(); hosts.delete(k); }
    }
  });
  return <>{items.map((it) => createPortal(it.node, hostFor(it.key), it.key))}</>;
};
