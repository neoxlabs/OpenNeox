/**
 * useSuppressBrowserView — DOM overlay 弹窗时, 平滑藏起被它覆盖的 BrowserView.
 *
 *   ## 为什么要这玩意儿
 *   BrowserView 是 OS 级 native view, 在 Electron 窗口里永远盖在 DOM 之上, 无视
 *   z-index / position. 下拉菜单 / 弹窗看起来"被浏览器盖住 + 点不到", 唯一干净的
 *   解法是物理 hide BrowserView.
 *
 *   ## 自研 fade — 跟硬切对比的体感
 *   - 硬切: BrowserView 推屏外 → 瞬时空白 → 用户看到的是"页面突然消失"
 *   - fade: capture 当前 BrowserView 画面 → DOM 端贴 base64 image overlay → 150ms 渐变 →
 *     真正 hide BrowserView. 用户看到的是"页面温和淡出". restore 反向.
 *
 *   ## 体验优化 — bbox 重叠检测
 *   只有 overlay 的视口 rect 跟 BrowserView 的视口 rect 真有重叠时才 suppress.
 *   左侧 sidebar 弹的菜单 / 顶部 dropdown 不在浏览器面板内时, 完全不动 BrowserView.
 *
 *   ## 计数器
 *   单例计数: 第一个 overlay 显示时 capture+fade-in+suppress, 最后一个关闭时 restore+fade-out.
 *   嵌套 overlay 正确合并, 不会过早 restore.
 *
 *   ## 用法
 *   ```tsx
 *   const overlayRef = useRef<HTMLDivElement>(null);
 *   useSuppressBrowserView(menuOpen, overlayRef);  // overlayRef 用来算 bbox 重叠
 *   ```
 */

import { useEffect, useRef, type RefObject } from 'react';

const FADE_MS = 150;

interface SuppressedSurface {
  surfaceId: string;
  bounds: { x: number; y: number; width: number; height: number };
  overlayEl: HTMLDivElement;
}

/* 全局状态 — 一台 Neox 一个 manager. */
let activeOverlayCount = 0;
let suppressedSurfaces: SuppressedSurface[] = [];
/** 防止 restore 跟另一个 push 的 suppress 在同一帧打架 (微任务防抖). */
let restoreScheduled = false;

/** 拿当前所有 BrowserView 列表 + 视口 bounds. 给重叠检测用. */
async function listVisibleBrowserViews(): Promise<Array<{ surfaceId: string; bounds: DOMRect }>> {
  const api = (window as any).neox;
  if (typeof api?.embeddedBrowserList !== 'function') return [];
  /* 把 main 的 list 跟 renderer 的占位 div bounds 联起来 — DOM 这边的占位 div
   * 才能告诉我们 BrowserView "应该在哪". 用 data-surface-id 属性约定. */
  const elems = Array.from(document.querySelectorAll<HTMLElement>('[data-browser-surface-id]'));
  return elems.map(el => ({
    surfaceId: el.dataset.browserSurfaceId!,
    bounds: el.getBoundingClientRect(),
  }));
}

function rectsOverlap(a: DOMRect, b: DOMRect): boolean {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

/** 创建一个浮在 BrowserView 之上的 snapshot overlay div (绝对定位, 内含 base64 image). */
function makeSnapshotOverlay(bounds: DOMRect, base64: string): HTMLDivElement {
  const div = document.createElement('div');
  div.style.cssText = [
    'position: fixed',
    `left: ${bounds.left}px`,
    `top: ${bounds.top}px`,
    `width: ${bounds.width}px`,
    `height: ${bounds.height}px`,
    'opacity: 0',
    `transition: opacity ${FADE_MS}ms ease`,
    'z-index: 999',  /* 在 BrowserView 之上 (BrowserView 是 native view ~level z-index 高, 这里不重要;
                       关键是 overlay 在 BrowserView 上方区域里) */
    'pointer-events: none',
    'background-size: cover',
    'background-repeat: no-repeat',
    'background-position: top left',
    `background-image: url(data:image/png;base64,${base64})`,
    'box-shadow: 0 0 0 1px rgba(0,0,0,0.05)',
  ].join(';');
  document.body.appendChild(div);
  /* 下一帧触发 transition — 设置 opacity:1 */
  requestAnimationFrame(() => {
    div.style.opacity = '1';
  });
  return div;
}

async function suppressNow(checkOverlayRef?: RefObject<HTMLElement | null>): Promise<void> {
  const api = (window as any).neox;
  if (!api) return;

  const views = await listVisibleBrowserViews();
  if (views.length === 0) return;

  /* bbox 检测: 如果传了 overlay ref, 只藏跟 overlay rect 真重叠的 view. 没传就藏全部 (兼容旧调用方). */
  const overlayRect = checkOverlayRef?.current?.getBoundingClientRect();

  for (const v of views) {
    if (overlayRect && !rectsOverlap(overlayRect, v.bounds)) continue;
    /* 先 capture 当前画面给 DOM 假 fade 用. capture 失败就直接硬切 (容忍). */
    try {
      const cap = await api.embeddedBrowserCapture?.({ surfaceId: v.surfaceId });
      if (cap?.ok && cap.base64) {
        const overlayEl = makeSnapshotOverlay(v.bounds, cap.base64);
        suppressedSurfaces.push({ surfaceId: v.surfaceId, bounds: v.bounds, overlayEl });
        /* 等 fade-in 跑完再真 suppress, 让 image 占满之后浏览器才消失 */
        await new Promise(r => setTimeout(r, FADE_MS));
        await api.embeddedBrowserSuppress?.({ surfaceId: v.surfaceId });
      } else {
        /* capture 失败 — 直接 suppress, 没 fade */
        await api.embeddedBrowserSuppress?.({ surfaceId: v.surfaceId });
        suppressedSurfaces.push({ surfaceId: v.surfaceId, bounds: v.bounds, overlayEl: null as any });
      }
    } catch {
      /* 出错容忍 */
    }
  }
}

async function restoreNow(): Promise<void> {
  const api = (window as any).neox;
  if (!api) return;

  /* 先把 BrowserView 都 restore 回来 — 这是 OS 级操作, 瞬时. */
  for (const s of suppressedSurfaces) {
    try { await api.embeddedBrowserRestore?.({ surfaceId: s.surfaceId }); } catch { /* */ }
  }
  /* 然后让 overlay 渐隐, 用户看到的是"浏览器淡入". 这里实际上是 overlay 在 BrowserView 之上消失.
   * BrowserView 已经回到正确位置, 渐隐 overlay 露出它. */
  for (const s of suppressedSurfaces) {
    if (s.overlayEl) {
      s.overlayEl.style.opacity = '0';
    }
  }
  /* fade 完移除 DOM */
  await new Promise(r => setTimeout(r, FADE_MS));
  for (const s of suppressedSurfaces) {
    if (s.overlayEl?.parentNode) s.overlayEl.parentNode.removeChild(s.overlayEl);
  }
  suppressedSurfaces = [];
}

function push(checkOverlayRef?: RefObject<HTMLElement | null>): void {
  activeOverlayCount++;
  if (activeOverlayCount === 1) {
    void suppressNow(checkOverlayRef);
  }
}

function pop(): void {
  activeOverlayCount = Math.max(0, activeOverlayCount - 1);
  if (activeOverlayCount === 0) {
    if (restoreScheduled) return;
    restoreScheduled = true;
    /* 同一帧内多个 overlay 切换 (menu 关时 modal 同步开) 防止 restore→suppress 闪 */
    queueMicrotask(() => {
      restoreScheduled = false;
      if (activeOverlayCount === 0) {
        void restoreNow();
      }
    });
  }
}

/** Hook: 传 active=true 进来 = 通知这个 overlay 正在显示, false = 关闭.
 *  可选 overlayRef: overlay 元素 DOM ref. 传了会算 bbox 重叠 — 只在 overlay 跟 BrowserView 真有重叠时才动 view.
 *  没传 overlayRef 时 fallback 全部 suppress (兼容已有调用方). */
export function useSuppressBrowserView(active: boolean, overlayRef?: RefObject<HTMLElement | null>): void {
  /* 把 overlayRef 存一份在闭包外, push 时用 — useEffect 重建时旧 ref 失效 */
  const refHolder = useRef(overlayRef);
  refHolder.current = overlayRef;

  useEffect(() => {
    if (!active) return;
    push(refHolder.current);
    return () => pop();
  }, [active]);
}
