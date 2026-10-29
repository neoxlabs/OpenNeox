export async function runCleanupWithTimeout(
  cleanupFn: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutId = setTimeout(resolve, timeoutMs);
  });

  try {
    await Promise.race([cleanupFn(), timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
