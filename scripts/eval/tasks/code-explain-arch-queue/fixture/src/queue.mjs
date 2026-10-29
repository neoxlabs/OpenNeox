import { MAX_CONCURRENCY } from './config.mjs';
import { runTask } from './runner.mjs';
import { saveState } from './store.mjs';

export async function drain(tasks) {
  const pending = [...tasks];
  const workers = Array.from({ length: MAX_CONCURRENCY }, async () => {
    while (pending.length > 0) {
      const task = pending.shift();
      await runTask(task);
      saveState(pending);
    }
  });
  await Promise.all(workers);
}
