
import { useEffect, useRef } from 'react';

/** 跟 WAI-ARIA "focusable elements" 一致, 含 contenteditable / 自定义 tabindex≥0. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/** 过滤掉 hidden / display:none / visibility:hidden 元素 — offsetParent 是最稳的检查. */
function isVisible(el: HTMLElement): boolean {
  if (el.hidden) return false;
  if (el.offsetParent !== null) return true;
  /* offsetParent 在 position:fixed 元素上是 null, 用 getClientRects fallback */
  return el.getClientRects().length > 0;
}

export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement | null>,
  isActive: boolean,
): void {
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isActive) return;
    const container = containerRef.current;
    if (!container) return;

    /* 记下 modal 打开前的焦点 — 关 modal 时还回去, 键盘用户的鼠标轨迹保持连贯 */
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    /* 进入 modal: 焦点设到 container 内. 优先 autofocus 的; 否则第一个 focusable. */
    const allFocusables = Array.from(
      container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter(isVisible);
    const autoFocus = container.querySelector<HTMLElement>('[autofocus]');
    const target = (autoFocus && isVisible(autoFocus)) ? autoFocus : allFocusables[0];
    if (target) {
      /* defer 一帧 — modal 渲染那一帧 React 还在做 commit, 直接 focus 可能被 React
       *  自身的 restore 覆盖. requestAnimationFrame 让 React 先走完 */
      requestAnimationFrame(() => { try { target.focus(); } catch { /* ignore */ } });
    }

    /* Tab / Shift+Tab 拦截 — 焦点跑到 container 外或边界时强制回环. */
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      /* 每次 Tab 都重新查 focusables — modal 内容可能动态变 (例如 list 项增删) */
      const live = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter(isVisible);
      if (live.length === 0) {
        e.preventDefault();
        return;
      }
      const first = live[0];
      const last = live[live.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        /* Shift+Tab 在第一个 / 不在 container 内 → 跳到最后一个 */
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        /* Tab 在最后一个 / 不在 container 内 → 跳到第一个 */
        if (active === last || !container.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    /* 用 capture 阶段监听 — 防止 modal 内的 input 自己 stopPropagation 把 Tab 吞了 */
    container.addEventListener('keydown', onKeyDown, true);

    return () => {
      container.removeEventListener('keydown', onKeyDown, true);
      /* 关 modal 把焦点还给触发元素. try-catch 防元素已 unmount. */
      const prev = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
        try { prev.focus(); } catch { /* ignore */ }
      }
    };
  }, [isActive, containerRef]);
}
