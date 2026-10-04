import { useEffect, useState } from 'react';

export interface BottomPanelState {
  title: string;
  /** 已着色 (chalk) 的行 */
  lines: string[];
  /** 标题右侧的灰字状态: "刷新中…" / "刚刚更新" / 错误 */
  status?: string;
  statusTone?: 'dim' | 'error';
  /** 右上角的关闭提示, 默认 "Esc 关闭" (登录等待中是 "Esc 取消") */
  closeHint?: string;
  /** 被用户关掉 (Esc / 开始新一轮) 时调用 —— 登录面板靠它取消等待; 程序自己 setBottomPanel(null) 不触发 */
  onClose?: () => void;
}

let current: BottomPanelState | null = null;
const listeners = new Set<(s: BottomPanelState | null) => void>();

export function setBottomPanel(s: BottomPanelState | null): void {
  current = s;
  for (const fn of listeners) {
    try { fn(s); } catch { /* */ }
  }
}

/** 只改面板里的部分字段 (面板已关就不再打开 —— 用户 Esc 之后网络才回来的情况) */
export function patchBottomPanel(patch: Partial<BottomPanelState>): void {
  if (!current) return;
  setBottomPanel({ ...current, ...patch });
}

export function closeBottomPanel(): void {
  const closing = current;
  setBottomPanel(null);
  try { closing?.onClose?.(); } catch { /* */ }
}

export function useBottomPanel(): BottomPanelState | null {
  const [s, setS] = useState<BottomPanelState | null>(current);
  useEffect(() => {
    listeners.add(setS);
    setS(current);
    return () => { listeners.delete(setS); };
  }, []);
  return s;
}
