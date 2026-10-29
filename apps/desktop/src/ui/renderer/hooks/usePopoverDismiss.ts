/* ============================================================
 * usePopoverDismiss — 统一处理 popover/menu 的关闭逻辑
 *
 *   解决之前各 popover 各写一套 click-outside 导致体验不一致的痛点:
 *     · 有的只听 mousedown, 有的只听 click — 部分场景关不掉
 *     · setTimeout 0 注册时机不稳, 偶尔点击触发就立即关 (尤其在 webkit)
 *     · ESC 没统一
 *     · 多 popover 共存时不互斥
 *
 *   行为:
 *     1. 监听 window pointerdown (capture 阶段, 比 mousedown / click 更可靠)
 *        — pointerdown 兼容鼠标 / 触控 / 笔, 不被嵌入 webview 抢走
 *     2. 监听 window keydown — Esc 关
 *     3. 用 openedAtRef 防 "打开瞬间被自身 trigger click 关掉" — 跳过 ≤50ms 的事件
 *     4. ignore 的 refs 都被排除 (按钮自己 + popover 自己都不算 outside)
 *     5. open=false 时彻底不绑事件, 0 开销
 *
 *   用法:
 *     const btnRef = useRef<HTMLButtonElement>(null);
 *     const menuRef = useRef<HTMLDivElement>(null);
 *     usePopoverDismiss({
 *       open,
 *       refs: [btnRef, menuRef],
 *       onDismiss: () => setOpen(false),
 *     });
 * ============================================================ */

import { useEffect, useRef } from 'react';

export interface PopoverDismissOpts {
  open: boolean;
  /** 哪些 DOM 节点点击不算 outside (按钮自己 + popover 自己) */
  refs: Array<React.RefObject<HTMLElement | null>>;
  /** 关闭回调 */
  onDismiss: () => void;
  /** 是否监听 Esc 关 (默认 true) */
  closeOnEsc?: boolean;
  /** 是否禁用 (某些场景临时不希望自动关) */
  disabled?: boolean;
}

export function usePopoverDismiss({ open, refs, onDismiss, closeOnEsc = true, disabled }: PopoverDismissOpts): void {
  /* 打开时间戳 — 防自身点击 trigger 关闭 */
  const openedAtRef = useRef(0);

  useEffect(() => {
    if (open) openedAtRef.current = performance.now();
  }, [open]);

  useEffect(() => {
    if (!open || disabled) return;

    const isInside = (target: EventTarget | null): boolean => {
      /* 不用 instanceof Node: Surface 独立窗口里的元素属于子窗口自己的 JS 环境, instanceof 主窗口的 Node 恒为假 */
      if (!target || typeof (target as Node).nodeType !== 'number') return false;
      for (const r of refs) {
        const el = r.current;
        if (el && el.contains(target as Node)) return true;
      }
      return false;
    };

    const onPointerDown = (e: PointerEvent) => {
      /* 防自身 click trigger 关闭: 50ms 缓冲 (足够浏览器消化 onClick → state update → effect 注册) */
      if (performance.now() - openedAtRef.current < 50) return;
      if (isInside(e.target)) return;
      onDismiss();
    };

    const onKey = (e: KeyboardEvent) => {
      if (!closeOnEsc) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onDismiss();
      }
    };

    /* capture 阶段 — 在事件冒泡前就接收, 不被嵌入 webview / iframe 抢走 */
    /* Surface 独立窗口里的点击 / 按键: utils/ownerDoc 会把主窗口这两个监听同步挂过去, 这里不用管 */
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, refs, onDismiss, closeOnEsc, disabled]);
}
