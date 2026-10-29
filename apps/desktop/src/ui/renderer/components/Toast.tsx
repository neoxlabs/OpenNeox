import React, { useEffect, useState, useCallback } from 'react';

export type ToastType = 'info' | 'success' | 'warning' | 'error';

interface ToastMessage {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

interface ToastProps {
  messages: ToastMessage[];
  onRemove: (id: string) => void;
}

/* 不同 type 的默认存活时长 — error/warning 比 info/success 显著长, 防用户切窗错过关键提示.
 *  调用方仍可显式传 duration 覆盖. duration=0 → 不自动关 (强制 dismissible). */
const DEFAULT_DURATION_BY_TYPE: Record<ToastType, number> = {
  info:    3000,
  success: 3000,
  warning: 6000,
  error:   8000,
};

const ToastItem = ({ message, type, onClose, duration }: {
  message: string;
  type: ToastType;
  onClose: () => void;
  duration?: number;
}) => {
  const [isExiting, setIsExiting] = useState(false);
  const effectiveDuration = duration ?? DEFAULT_DURATION_BY_TYPE[type];

  useEffect(() => {
    /* duration=0 表示永不自动关闭 — error 类有时希望强制用户点 × 才消失 */
    if (effectiveDuration <= 0) return;
    const timer = setTimeout(() => {
      setIsExiting(true);
      setTimeout(onClose, 200);
    }, effectiveDuration);

    return () => clearTimeout(timer);
  }, [effectiveDuration, onClose]);

  const handleClose = () => {
    setIsExiting(true);
    setTimeout(onClose, 200);
  };

  return (
    <div className={`toast-item toast-${type} ${isExiting ? 'toast-exit' : ''}`}>
      {/* UI 3.0 (设计稿 v5「提示与反馈」): 细线类型图标 —— 信息 ⓘ 钴蓝 / 成功 ✓ 绿 / 警告·出错 ! 琥珀·红。
        * 不是实心圆点, 也不是色条; 字和底不变色。 */}
      <span className={`toast-glyph toast-glyph--${type}`} aria-hidden="true">
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="8" r="6.3" />
          {type === 'success'
            ? <path d="M5.4 8.2 7.2 10l3.4-3.8" />
            : type === 'info'
              ? <><path d="M8 7.4v3.4" /><circle cx="8" cy="5.2" r=".5" fill="currentColor" stroke="none" /></>
              : <><path d="M8 4.8v3.6" /><circle cx="8" cy="10.9" r=".5" fill="currentColor" stroke="none" /></>}
        </svg>
      </span>
      <span className="toast-message">{message}</span>
      <button className="toast-close" onClick={handleClose} type="button">×</button>
    </div>
  );
};

export const Toast: React.FC<ToastProps> = ({ messages, onRemove }) => {
  if (messages.length === 0) return null;

  return (
    <div className="toast-container">
      {messages.map((msg) => (
        <ToastItem
          key={msg.id}
          message={msg.message}
          type={msg.type}
          duration={msg.duration}
          onClose={() => onRemove(msg.id)}
        />
      ))}
    </div>
  );
};

/* 同屏 toast 上限 — 极端场景 (批量操作连续失败) 不至于叠满整屏.
 *  超出时丢最老的一条; error/warning 存活本来就更长, 不做类型区分保持简单. */
const MAX_STACK = 5;

// Hook for easy toast usage
export const useToast = () => {
  const [messages, setMessages] = useState<ToastMessage[]>([]);

  /* duration 不传时, ToastItem 内部按 type 取 DEFAULT_DURATION_BY_TYPE
   *   (info/success=3s, warning=6s, error=8s, =0=永不自动关). */
  const addToast = useCallback((message: string, type: ToastType = 'info', duration?: number) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setMessages((prev) => {
      const next = [...prev, { id, message, type, duration }];
      return next.length > MAX_STACK ? next.slice(next.length - MAX_STACK) : next;
    });
    return id;
  }, []);

  const removeToast = useCallback((id: string) => {
    setMessages((prev) => prev.filter((msg) => msg.id !== id));
  }, []);

  const toast = {
    info: (message: string, duration?: number) => addToast(message, 'info', duration),
    success: (message: string, duration?: number) => addToast(message, 'success', duration),
    warning: (message: string, duration?: number) => addToast(message, 'warning', duration),
    error: (message: string, duration?: number) => addToast(message, 'error', duration),
  };

  return { messages, removeToast, toast };
};

export default Toast;
