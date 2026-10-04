import type { CompressionProgress } from '../utils/compression/llmSummarizer.js';

export async function* streamWhileRunning<T, E>(
  run: (onProgress: (progress: CompressionProgress) => void) => Promise<T>,
  toEvent: (progress: CompressionProgress) => E,
): AsyncGenerator<E, T> {
  const queue: CompressionProgress[] = [];
  let settled = false;
  let wake: (() => void) | null = null;
  const work = run((progress) => { queue.push(progress); wake?.(); });
  const done = work.then(() => undefined, () => undefined).finally(() => { settled = true; wake?.(); });
  while (!settled) {
    await new Promise<void>((resolve) => {
      wake = resolve;
      if (settled || queue.length > 0) resolve();
    });
    wake = null;
    while (queue.length > 0) yield toEvent(queue.shift()!);
  }
  await done;
  while (queue.length > 0) yield toEvent(queue.shift()!);
  return work;
}

/** The runner's 'compressing' event for one progress report. */
export function compressionProgressEvent(p: CompressionProgress, originalTokens: number, budgetTokens: number): any {
  return {
    type: 'context_compaction',
    status: 'compressing',
    originalTokens,
    budgetTokens,
    useLLM: true,
    timestamp: Date.now(),
    compression: {
      phase: p.phase,
      totalBuckets: p.totalBuckets,
      completedBuckets: p.completedBuckets,
      buckets: p.buckets,
      summaryModel: p.summaryModel,
    },
  };
}
