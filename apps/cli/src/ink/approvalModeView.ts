/**
 * 底栏左侧显示的审批档 —— main 改档时写一次, HintLine 渲染时读 (同进程, 不走 props 链)。
 * 只是显示用的镜像, 真正生效的审批档仍在 main / daemon。
 */
export type ApprovalModeView = 'auto' | 'manual' | 'dangerous';

let mode: ApprovalModeView | null = null;

export function setApprovalModeView(m: ApprovalModeView): void { mode = m; }
export function getApprovalModeView(): ApprovalModeView | null { return mode; }

/* ⇧tab 循环审批档: 输入框收到按键 → main 注册的处理器真正去改档 (同样不走 props 链) */
let cycleHandler: ((next: ApprovalModeView) => void) | null = null;
export function setApprovalCycleHandler(fn: ((next: ApprovalModeView) => void) | null): void { cycleHandler = fn; }
/** 每次问 → 自动 → yolo → 每次问; 没注册处理器时返回 false (按键照旧当 tab) */
export function requestApprovalCycle(): boolean {
  if (!cycleHandler) return false;
  const order: ApprovalModeView[] = ['manual', 'auto', 'dangerous'];
  const next = order[(order.indexOf(mode ?? 'auto') + 1) % order.length]!;
  cycleHandler(next);
  return true;
}
