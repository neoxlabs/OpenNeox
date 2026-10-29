/**
 * useExclusivePopover — 顶栏/侧栏各处 popover 互斥关闭.
 *
 * 场景: 铃铛开着时点 mode picker, 铃铛不会自动关 → 两个 popover 同屏叠在一起,
 *       视觉混乱. 加一个轻量全局广播: 谁开谁广播, 其他人一收到就关自己.
 *
 * 用法:
 *   const [open, setOpen] = useState(false);
 *   useExclusivePopover('bell', open, () => setOpen(false));
 *   const onClick = () => setOpen(true);   // hook 会自动广播 'bell' opened
 *
 * 不涉及点外部关闭 / Esc 关闭 — 那两个各组件自己已经处理. 只解决 sibling 冲突.
 */
import { useEffect } from 'react';

const EVT = 'neox:popover-opened';

export function useExclusivePopover(id: string, isOpen: boolean, close: () => void): void {
  /* 打开时广播: 其他 popover 收到会关自己 (id 不同才关). */
  useEffect(() => {
    if (!isOpen) return;
    try { window.dispatchEvent(new CustomEvent(EVT, { detail: { id } })); } catch { /* noop */ }
  }, [id, isOpen]);

  /* 监听别人打开: 如果不是自己, 关自己. */
  useEffect(() => {
    if (!isOpen) return; // 关闭时无需监听
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ id?: string }>).detail;
      if (detail?.id && detail.id !== id) close();
    };
    window.addEventListener(EVT, handler);
    return () => window.removeEventListener(EVT, handler);
  }, [id, isOpen, close]);
}
