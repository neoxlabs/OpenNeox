
import { useCallback, useEffect, useRef, useState } from 'react';

export const CTX_RAIL_SHOW_AT = 912;
export const CTX_RAIL_HIDE_AT = 876;

export function useContextRailFit(enabled: boolean): {
  shellRef: (node: HTMLDivElement | null) => void;
  fits: boolean;
} {
  const [fits, setFits] = useState(false);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  /* 迟滞判定读的是「上一次的结论」, 用 ref 而不是 state —— 避免把 fits 写进
     ResizeObserver 回调的闭包依赖, 否则每次翻转都要重建 observer。 */
  const fitsRef = useRef(false);

  const measure = useCallback((w: number) => {
    const next = fitsRef.current ? w >= CTX_RAIL_HIDE_AT : w >= CTX_RAIL_SHOW_AT;
    if (next === fitsRef.current) return;
    fitsRef.current = next;
    setFits(next);
  }, []);

  const shellRef = useCallback((n: HTMLDivElement | null) => setNode(n), []);

  useEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) measure(box.width);
    });
    ro.observe(node);
    /* enabled 进依赖: Surface 收起那一刻宽度可能**没变**(面板是覆盖式收的),
       RO 不会触发, 只能在这里主动重算一次。 */
    measure(node.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [node, measure, enabled]);

  /* enabled 现在只用来**触发重算** (Surface 覆盖式开合时宽度可能没变, RO 不响),
     不再参与结论 —— 结论只由"宽度够不够" + 调用方的"看得见 timeline 吗"决定。 */
  return { shellRef, fits };
}
