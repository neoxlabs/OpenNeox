import { app, BrowserWindow } from 'electron';

let windowOpener: (() => Promise<unknown>) | null = null;

/** main.ts 定义好 createWindow 之后调用一次 */
export function registerWindowOpener(open: () => Promise<unknown>): void {
  windowOpener = open;
}

/** 一个活窗口都没有时新开一个 (进程活着却无窗 = 用户眼里的"打不开") */
export function reopenWindowIfNone(reason: string): void {
  if (!windowOpener || !app.isReady()) return;
  if (BrowserWindow.getAllWindows().some((w) => !w.isDestroyed())) return;
  console.log(`[quitGuards] 没有窗口, 重新打开主窗口 (${reason})`);
  void windowOpener().catch((err: any) => console.error('[quitGuards] 重开窗口失败:', err?.message || err));
}

/** 退出路径上的等待一律带超时: 超时取 fallback, 不让一个卡住的 worker 把退出挂死 */
export function withQuitTimeout<T>(p: Promise<T>, ms: number, fallback: T, label: string): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[quitGuards] ${label} ${ms}ms 未返回, 按 ${String(fallback)} 继续退出`);
      resolve(fallback);
    }, ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

let watchdogArmed = false;

/**
 * 确定要退之后上一道总闸: 到点仍没退干净就直接结束进程。
 * 清理链自己有 3s 硬超时, 这里兜的是它之外的一切 (will-quit 里的同步活、某个 listener 挂住等)。
 */
export function armQuitWatchdog(ms = 8_000): void {
  if (watchdogArmed) return;
  watchdogArmed = true;
  setTimeout(() => {
    console.error(`[quitGuards] 退出 ${ms}ms 仍未完成, 强制结束进程`);
    app.exit(0);
  }, ms).unref?.();
}
