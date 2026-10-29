/**
 * useEscClose — modal/overlay 的 Esc 关闭 hook (capture 阶段 + LIFO 栈).
 *
 *   跟 usePopoverDismiss 的区别: 后者是 popover 语义 (点外面也关, bubble Esc);
 *   这个专给"带遮罩的 modal"用 — capture + stopPropagation, 保证:
 *     · 设置页之上叠 modal 时, Esc 只关最上层 modal, 不会穿透把设置页整个关掉
 *       (SettingsPage 的 Esc handler 挂在 window bubble, capture 层 stop 掉就到不了)
 *     · 多个 modal 叠加时 Esc 按打开顺序逐层往外关 (LIFO), 不会一键全关
 *     · 不依赖焦点位置 — 焦点在按钮/空白处 Esc 一样工作
 *
 *   用法:
 *     useEscClose(isOpen, () => setOpen(false));
 *     useEscClose(isOpen && !busy, onClose);   // busy 时不许关
 */
import { useEffect } from 'react';

/** 当前活跃的 esc 监听栈 — 只有栈顶 (最后打开的 modal) 响应 Esc. */
const escStack: symbol[] = [];

export function useEscClose(active: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!active) return;
    const token = Symbol('esc-close');
    escStack.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (escStack[escStack.length - 1] !== token) return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    /* Surface 独立窗口里按的 Esc: utils/ownerDoc 会把这个监听同步挂过去 */
    document.addEventListener('keydown', onKey, true);
    return () => {
      const i = escStack.indexOf(token);
      if (i >= 0) escStack.splice(i, 1);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [active, onClose]);
}
