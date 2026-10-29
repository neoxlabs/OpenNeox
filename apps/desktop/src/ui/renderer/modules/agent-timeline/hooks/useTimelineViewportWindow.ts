/**
 * @deprecated 自研窗口已退役。请使用 `useTimelineVirtualizer`（@tanstack/react-virtual Chat 模式）。
 * 本文件仅保留空壳，避免旧 import 路径在过渡期炸编译；请勿再扩展。
 */
export function useTimelineViewportWindow(_args: unknown): never {
  throw new Error(
    "useTimelineViewportWindow was removed. Use useTimelineVirtualizer instead."
  );
}
