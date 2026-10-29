
const SWEEP_INTERVAL_MS = 10_000;
let installed = false;

/** 在 renderer 入口调用一次。无条件生效 (泄漏源是 Monaco, 与 shellPerf 是否开启无关)。 */
export function installUserTimingSweeper(): void {
  if (installed) return;
  if (typeof performance === 'undefined') return;
  if (typeof performance.clearMeasures !== 'function' || typeof performance.clearMarks !== 'function') return;
  installed = true;
  const sweep = () => {
    try {
      performance.clearMeasures();
      performance.clearMarks();
    } catch {
      /* 诊断设施自身绝不能成为故障源 */
    }
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    if (timer !== null) return;
    timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  };
  const stop = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };
  const onVisibility = () => {
    if (typeof document !== 'undefined' && document.hidden) stop();
    else start();
  };
  if (typeof document === 'undefined' || !document.hidden) start();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }
  sweep();
}
