import { performance } from 'perf_hooks';

export function startPerfHooksCleanupInterval(): () => void {
  const timer = setInterval(() => {
    performance.clearMarks();
    performance.clearMeasures();
  }, 60000);
  timer.unref();

  let stopped = false;
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
  };
}
