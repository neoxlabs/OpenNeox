import { useSyncExternalStore } from 'react';

export interface FloatGeom { x: number; y: number; w: number; h: number }

export interface FloatingSurface {
  sessionId: string;
  /** hostId 或 hostId::tabId —— 跟标签栏里那一格同一个身份 */
  key: string;
  hostId: string;
  tabId?: string;
  /** 开窗时的屏幕坐标和大小; 开出来以后位置归系统窗口管 */
  geom: FloatGeom;
  /** 窗口里显示的是哪个查看器实例 (viewHosts 的宿主 key)。拖的是右栏正在显示的那个, 就是右栏那个实例本身 —— 搬过去不重开 */
  viewKey: string;
  /** 拖出来时这个会话的工作区 (切到别的会话后窗口里的查看器还要用它) */
  workspacePath?: string;
}

let all: FloatingSurface[] = [];
const listeners = new Set<() => void>();

function emit(): void { for (const l of listeners) l(); }

export function floatingKey(hostId: string, tabId?: string): string {
  return tabId ? `${hostId}::${tabId}` : hostId;
}

export function floatSurface(
  sessionId: string, hostId: string, tabId: string | undefined, geom: FloatGeom, viewKey: string, workspacePath?: string,
): void {
  if (!sessionId) return;
  const key = floatingKey(hostId, tabId);
  /* geom 是屏幕坐标 (独立窗口开在松手处, 可以在别的屏上), 不按主窗口大小夹, 只保最小尺寸 */
  all = [
    ...all.filter((f) => !(f.sessionId === sessionId && f.key === key)),
    { sessionId, key, hostId, tabId, viewKey, workspacePath, geom: { ...geom, w: Math.max(320, geom.w), h: Math.max(220, geom.h) } },
  ];
  emit();
}

export function dockFloating(sessionId: string, key: string): void {
  if (!all.some((f) => f.sessionId === sessionId && f.key === key)) return;
  all = all.filter((f) => !(f.sessionId === sessionId && f.key === key));
  emit();
}

/** 所有会话的独立窗口 (数组只在变化时换新, 可直接当 useSyncExternalStore 快照) */
export function useAllFloatingSurfaces(): FloatingSurface[] {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => all,
  );
}
