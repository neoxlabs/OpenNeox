/* 懒挂载 (S-05): 元素接近视口时才挂真正的内容。
 *
 * PPTX 打开时会把每一页缩略图 (完整 SlideView + SVG) 一次全渲出来 ——
 * 40 页的 deck 就是 40 棵同构子树, 首屏被拖慢, 而用户首屏只看得到前几页。
 *
 * 这里的约定:
 *   · 没有 IntersectionObserver (老内核 / 测试环境) → 直接可见, 行为等同改动前;
 *   · observed=false 时不自作主张隐藏 (调用方自己决定什么时候启用);
 *   · 一旦可见就不再收回 (缩略图列表会滚动, 收回去会闪)。
 */

import { useEffect, useRef, useState } from 'react';

interface Options {
  root?: Element | null;
  rootMargin?: string;
  enabled?: boolean;
}

export function useLazyVisible<T extends Element>(opts: Options = {}) {
  const { root = null, rootMargin = '400px', enabled = true } = opts;
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(!enabled || typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (!enabled) {
      setVisible(true);
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    if (visible) return;
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { root, rootMargin });
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, root, rootMargin, visible]);

  return { ref, visible };
}
