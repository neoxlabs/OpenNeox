import { useEffect, useRef, useState } from 'react';

export function useCountUp(target: number, active: boolean): number {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    /* 不在流式中 / 目标回退 / 差距为 0 → 直接吸附。完成后显示的必须是真实值。 */
    if (!active || target <= shownRef.current) {
      if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      shownRef.current = target;
      setShown(target);
      return;
    }

    let last = performance.now();
    const tick = (now: number) => {
      const dtMs = Math.min(64, now - last);   /* 掉帧时别一次跳太多 */
      last = now;
      const gap = target - shownRef.current;
      if (gap <= 0) { rafRef.current = null; return; }
      /* 每 16ms 追掉差距的 ~18%, 至少 1 行 —— 差距大时快, 快到目标时慢, 收尾自然 */
      const step = Math.max(1, Math.round(gap * 0.18 * (dtMs / 16)));
      shownRef.current = Math.min(target, shownRef.current + step);
      setShown(shownRef.current);
      if (shownRef.current < target) rafRef.current = requestAnimationFrame(tick);
      else rafRef.current = null;
    };
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    };
  }, [target, active]);

  return shown;
}
