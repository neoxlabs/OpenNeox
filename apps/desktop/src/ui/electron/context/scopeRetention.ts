
/**
 * 切走一个 scope 时: 保活, 还是直接拆?
 *
 * 判据只有一条 —— 它手上还有没有在跑的会话。拿不准一律保活:
 * 拆是不可逆的(runtime 一没, 那一轮既不出结果也不报错), 而保活的代价只是晚一会儿回收。
 */
export function shouldParkOnSwitch(scope: { hasRunningSessions: boolean }): boolean {
  return scope.hasRunningSessions === true;
}

/**
 * 切回某个 workspace 时: 能不能复用之前保活的那个 scope?
 *
 * 三个条件缺一不可:
 *   · 确实有一个保活的 scope
 *   · 它还没被 dispose (窗口关闭等路径会把它拆掉)
 *   · 它绑的还是**同一个窗口** —— 多窗口场景下, 别的窗口的 scope 不能拿过来用,
 *     否则事件会发到另一个窗口去
 */
export function canReviveParked(
  parked: { windowId: number; disposed: boolean } | undefined,
  targetWindowId: number,
): boolean {
  if (!parked) return false;
  if (parked.disposed) return false;   /* 已经拆掉的复活不了 */
  return parked.windowId === targetWindowId;
}

/** 保活的 scope 什么时候可以真正回收: 活干完了, 或者它本来就已经被拆了。 */
export function shouldReapParked(scope: { hasRunningSessions: boolean; disposed: boolean }): boolean {
  if (scope.disposed) return true;
  return scope.hasRunningSessions === false;
}
