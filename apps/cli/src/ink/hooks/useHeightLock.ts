import { useRef } from 'react';
import { measureElement, type DOMElement } from '../../../vendor/ink/src/index.js';

/**
 * 高度锁 (输入框防跳的地基)
 *
 * ## 为什么需要
 * Ink 的 live region 顶锚定重绘，因此输入框的位置取决于上方 live
 * 内容的高度。锁定期内高度缩小时保留空行，避免输入框随动态内容上下移动。
 *
 * ## 做法
 * 一个 turn 内让锁定区域高度单调不减，结束时一次性释放。
 *
 * ## 为什么量真实高度而不是估算
 * measureElement 读取 Yoga 的实际布局高度，包含终端换行和 padding。
 *
 * ## 为什么在 render 期读 ref 而不是 useLayoutEffect
 * Ink 先计算并输出布局，再执行 layout effects，因此 effect 中更新高度会晚一帧。
 * render 期读取最近一次布局高度可立即提供 minHeight；内容增长仍会自然撑开容器。
 */
export interface HeightLock {
  /** 挂到被锁的那个 Box 上 */
  ref: React.MutableRefObject<DOMElement | null>;
  /** 直接摊进 Box props: {...lock.props} */
  props: { minHeight?: number };
  /** 当前锁定高度 (0 = 未锁), 调试/测试用 */
  locked: number;
}

/**
 * @param active   是否处于锁定期 (通常 = isRunning)。false 时立即释放。
 * @param maxHeight 锁定高度上限, 防止某块把整个 live region 顶穿屏幕。
 */
export function useHeightLock(active: boolean, maxHeight = Number.POSITIVE_INFINITY): HeightLock {
  const ref = useRef<DOMElement | null>(null);
  const hwmRef = useRef(0);

  if (active) {
    /* Read the most recent layout height. minHeight makes the measured
     * value monotonic while the lock is active. */
    const measured = ref.current ? measureElement(ref.current).height : 0;
    if (measured > hwmRef.current) {
      hwmRef.current = measured;
    }
    if (hwmRef.current > maxHeight) {
      hwmRef.current = maxHeight; // 终端变矮 (resize) 时跟着收
    }
  } else if (hwmRef.current !== 0) {
    hwmRef.current = 0;
  }

  const locked = hwmRef.current;
  return {
    ref,
    props: locked > 0 ? { minHeight: locked } : {},
    locked,
  };
}
