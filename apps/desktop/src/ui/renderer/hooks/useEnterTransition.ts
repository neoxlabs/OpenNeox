import { useEffect, useState } from 'react';

export function useEnterTransition(enabled = true): boolean {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!enabled) { setEntered(false); return; }
    /* 双 rAF: 第一帧让初态真正提交到合成器, 第二帧再改属性。
       单 rAF 在 React 18 的并发渲染下偶尔仍会和首次绘制并到同一帧,
       表现是"十次里有一两次没动画" —— 这种间歇性问题最难查。 */
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setEntered(true));
    });
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
  }, [enabled]);
  return entered;
}
