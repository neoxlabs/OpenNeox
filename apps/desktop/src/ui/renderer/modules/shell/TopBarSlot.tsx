import React, { useEffect, useSyncExternalStore } from 'react';
import ReactDOM from 'react-dom';


const canUseDom = typeof document !== 'undefined';

/** 顶栏中段的落点。TopBar 把它 append 进 .neox-topbar__center。 */
export const TOPBAR_SLOT_EL: HTMLElement | null = canUseDom
  ? (() => {
      const el = document.createElement('div');
      el.className = 'neox-topbar__slot';
      return el;
    })()
  : null;

/* 占用者栈 —— 数组本身可变, 所以对外暴露的快照是**栈顶那个 id (字符串)**,
 * 不是数组: useSyncExternalStore 要求 getSnapshot 返回稳定值, 每次新建数组会死循环。 */
const occupants: string[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function topOccupant(): string | null {
  return occupants.length > 0 ? occupants[occupants.length - 1]! : null;
}

/** 顶栏中段现在是不是被 tab 条占着 —— TopBar 据此决定还显不显示会话标题。 */
export function useTopBarSlotOccupant(): string | null {
  return useSyncExternalStore(subscribe, topOccupant, () => null);
}

/**
 * TopBarHoist — 把 children 渲染到顶栏中段。
 *
 *   active=false 时原地渲染 (谁在不在顶栏由调用方判断: 比如 Surface 只有在
 *   "叠放·看产出"这种独占主区的版面下才该占顶栏, 并排版面下它有自己那一列)。
 */
export const TopBarHoist: React.FC<{
  /** 占用者标识, 用来在栈里排队 (同一处 UI 用固定字符串即可) */
  id: string;
  active?: boolean;
  children: React.ReactNode;
}> = ({ id, active = true, children }) => {
  const top = useTopBarSlotOccupant();

  useEffect(() => {
    if (!active) return;
    occupants.push(id);
    emit();
    return () => {
      const i = occupants.lastIndexOf(id);
      if (i >= 0) occupants.splice(i, 1);
      emit();
    };
  }, [id, active]);

  if (!active || !TOPBAR_SLOT_EL) return <>{children}</>;
  /* 注册要等 effect, 第一帧 top 还不是自己 —— 这一帧什么都不画, 而不是先在原位
   * 画一遍再跳走 (那就是一下闪烁)。 */
  if (top !== id) return null;
  return ReactDOM.createPortal(children, TOPBAR_SLOT_EL);
};

/** TopBar 中段渲染它, 把真正的落点挂进 DOM。 */
export const TopBarSlotHost: React.FC = () => {
  const ref = React.useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host || !TOPBAR_SLOT_EL) return;
    host.appendChild(TOPBAR_SLOT_EL);
    return () => {
      if (TOPBAR_SLOT_EL.parentNode === host) host.removeChild(TOPBAR_SLOT_EL);
    };
  }, []);
  return <div ref={ref} className="neox-topbar__slot-host" />;
};

export default TopBarHoist;
