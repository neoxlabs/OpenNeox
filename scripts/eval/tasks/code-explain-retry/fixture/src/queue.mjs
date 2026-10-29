import { withRetry } from './retry.mjs';

export async function runTask(task) {
  return withRetry(task);
}

export async function runAll(tasks) {
  const results = [];
  for (const task of tasks) results.push(await runTask(task));
  return results;
}
