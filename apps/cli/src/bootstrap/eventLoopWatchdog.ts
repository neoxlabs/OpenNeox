import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

let watchdogInterval: NodeJS.Timeout | null = null;

export function startEventLoopWatchdog(): void {
  if (watchdogInterval) {
    return;
  }

  let lastWatchdogTime = Date.now();
  const WATCHDOG_INTERVAL = 1000;
  const WATCHDOG_THRESHOLD = 5000;
  const WATCHDOG_MAX_THRESHOLD = 60000;

  watchdogInterval = setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastWatchdogTime;
    lastWatchdogTime = now;

    if (elapsed > WATCHDOG_THRESHOLD && elapsed < WATCHDOG_MAX_THRESHOLD) {
      cliLogger.warn('EVENT_LOOP', `⚠️ Event loop blocked for ${Math.round(elapsed / 1000)}s`, {
        elapsedMs: elapsed,
        elapsedSec: Math.round(elapsed / 1000),
      });
    }
  }, WATCHDOG_INTERVAL);
  watchdogInterval.unref();
}

export function stopEventLoopWatchdog(): void {
  if (!watchdogInterval) {
    return;
  }
  clearInterval(watchdogInterval);
  watchdogInterval = null;
}
