import { useLayoutEffect, useRef } from 'react';

/** 位移小于这个值不做动画 —— 也避免把普通重排误当成布局切换 */
export const FLIP_MIN_DELTA_PX = 24;
/** 位移动画时长 —— 兜底清理按它算 */
export const FLIP_DURATION_MS = 260;

export function shouldPlayComposerFlip(input: {
  enabled: boolean;
  wasCentered: boolean;
  centered: boolean;
  startTop: number | null;
  endTop: number;
}): boolean {
  const { enabled, wasCentered, centered, startTop, endTop } = input;
  if (!enabled) return false;
  if (!wasCentered || centered) return false;
  if (startTop == null) return false;
  return Math.abs(startTop - endTop) >= FLIP_MIN_DELTA_PX;
}

export function useComposerFlip(centered: boolean, enabled = true) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const prevCenteredRef = useRef(centered);
  /** 居中态下最后一次量到的视口 top —— 落底节点挂载时它已经卸载了, 只能提前存 */
  const centeredTopRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  /** 兜底清理定时器 —— transitionend 不来时也要把行内 transform 抹掉 */
  const clearTimerRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    const wasCentered = prevCenteredRef.current;
    prevCenteredRef.current = centered;
    if (!slot) return;

    if (centered) {
      /* First: 存起点。每次居中态渲染都刷新 —— 附件条 / 多行输入都会改它 */
      centeredTopRef.current = slot.getBoundingClientRect().top;
      return;
    }

    /* Last: 此刻是落底节点挂载后的首个 layout effect, 量到的即终态 */
    const endTop = slot.getBoundingClientRect().top;
    const startTop = centeredTopRef.current;
    centeredTopRef.current = null;
    if (!shouldPlayComposerFlip({ enabled, wasCentered, centered, startTop, endTop })) return;

    /* Invert: 跳回起点。这一帧必须 transition:none, 否则会先反向动画一次 */
    const delta = (startTop as number) - endTop;
    slot.style.transition = 'none';
    slot.style.transform = `translateY(${delta}px)`;
    slot.style.willChange = 'transform';

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    const clearFlip = (el: HTMLElement | null) => {
      if (!el) return;
      el.style.transition = '';
      el.style.transform = '';
      el.style.willChange = '';
    };
    if (clearTimerRef.current !== null) window.clearTimeout(clearTimerRef.current);

    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = requestAnimationFrame(() => {
        if (slotRef.current !== slot) { clearFlip(slot); return; }
        slot.style.transition = `transform ${FLIP_DURATION_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1)`;
        slot.style.transform = 'translateY(0)';
        const done = () => {
          clearFlip(slot);
          slot.removeEventListener('transitionend', done);
          slot.removeEventListener('transitioncancel', done);
          if (clearTimerRef.current !== null) {
            window.clearTimeout(clearTimerRef.current);
            clearTimerRef.current = null;
          }
        };
        slot.addEventListener('transitionend', done);
        slot.addEventListener('transitioncancel', done);
        /* 兜底: 动画时长 + 一点余量后无条件清干净, 不管事件来没来 */
        clearTimerRef.current = window.setTimeout(done, FLIP_DURATION_MS + 120);
      });
    });
  }, [centered, enabled]);

  useLayoutEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    if (clearTimerRef.current !== null) window.clearTimeout(clearTimerRef.current);
    const el = slotRef.current;
    if (el) { el.style.transition = ''; el.style.transform = ''; el.style.willChange = ''; }
  }, []);

  return slotRef;
}
