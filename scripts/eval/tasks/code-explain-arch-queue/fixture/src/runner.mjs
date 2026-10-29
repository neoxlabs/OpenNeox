import { BASE_DELAY_MS, MAX_ATTEMPTS } from './config.mjs';

export function backoffFor(attempt) {
  return BASE_DELAY_MS * 2 ** attempt;
}

export async function runTask(task) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await task.execute();
    } catch (error) {
      if (error.permanent) throw error;
      if (attempt === MAX_ATTEMPTS - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoffFor(attempt)));
    }
  }
  return undefined;
}
