export type ShellSwitchScope = 'all' | 'main';

let depth = 0;
let guard: number | undefined;

function root(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement;
}

export function beginShellSwitch(scope: ShellSwitchScope = 'all'): void {
  const el = root();
  if (!el) return;
  depth += 1;
  /* 已经在 all 里就别降成 main */
  if (el.dataset.shellSwitching !== 'all') el.dataset.shellSwitching = scope;
  window.clearTimeout(guard);
  guard = window.setTimeout(() => { depth = 0; delete el.dataset.shellSwitching; }, 1200);
}

export function endShellSwitch(): void {
  const el = root();
  if (!el) return;
  depth = Math.max(0, depth - 1);
  if (depth > 0) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (depth === 0) {
      delete el.dataset.shellSwitching;
      window.clearTimeout(guard);
    }
  }));
}

/** 一次性: 淡出, 等 ms 后淡回 (切会话这种没有明确「完成」回调的场景用) */
export function pulseShellSwitch(ms = 160, scope: ShellSwitchScope = 'all'): void {
  beginShellSwitch(scope);
  window.setTimeout(endShellSwitch, ms);
}
