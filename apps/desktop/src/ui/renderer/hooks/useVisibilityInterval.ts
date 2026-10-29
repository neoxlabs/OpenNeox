import { useEffect } from 'react';

export function useVisibilityInterval(callback: () => void, intervalMs: number): void {
  useEffect(() => {
    if (intervalMs <= 0) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(callback, intervalMs);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    /* 初始: 如果当前可见就启动. 不可见就等 visibilitychange. */
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [callback, intervalMs]);
}
