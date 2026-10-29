const BASE_DELAY_MS = Number(process.env.NEOX_RETRY_BASE_MS ?? 250);
export const MAX_ATTEMPTS = 4;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryable(error) {
  const status = error?.status;
  if (typeof status === 'number') return status >= 500;
  return true;
}

export function backoffDelay(attempt) {
  return BASE_DELAY_MS * 2 ** (attempt - 1);
}

export async function withRetry(task, { sleep = defaultSleep } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === MAX_ATTEMPTS) break;
      await sleep(backoffDelay(attempt));
    }
  }
  throw lastError;
}
