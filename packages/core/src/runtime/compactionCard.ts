
/* Auto-compaction summarizes the history before the next request and can be silent for a while.
 * At 400K tokens it took over a minute in a CLI trial: the 60s response limit read it as a dead
 * stream, rebuilt the run, and the abandoned compaction was booked as a no-op, which then held
 * off every later attempt while the context kept growing. The summary request is bounded by the
 * provider's own timeouts, so this limit only has to catch a compaction that never returns. */
export const STALL_TIMEOUT_COMPACTION_MS = 600_000;

interface CompactionEvent {
  status?: string;
  originalTokens?: number;
  finalTokens?: number;
}

interface CompactionProgressLike {
  totalBuckets?: number;
  completedBuckets?: number;
  summaryModel?: string;
  percent?: number;
  outputTokens?: number;
}

export function compactingProgressText(p: CompactionProgressLike, verb: string): [string, string | undefined] {
  if (typeof p.percent === 'number') {
    const out = p.outputTokens && p.outputTokens > 0 ? `↓ ${(p.outputTokens / 1000).toFixed(1)}K tokens` : undefined;
    return [`⚡ ${verb} ${Math.round(p.percent)}%`, out];
  }
  return [
    `⚡ ${verb} ${p.completedBuckets ?? 0}/${p.totalBuckets ?? 0} 组`,
    p.summaryModel ? `model ${p.summaryModel}` : undefined,
  ];
}

/** Card text for a 'started' / 'completed' / 'skipped' compaction event; null for other statuses. */
export function compactionCardMessage(evt: CompactionEvent): { text: string; detail: string } | null {
  const before = evt.originalTokens ?? 0;
  const after = evt.finalTokens ?? 0;
  const k = (n: number) => (n / 1000).toFixed(1);
  if (evt.status === 'started') {
    /* No "→ target": budgetTokens is the model's whole window, and "401,954 tokens → target
     * 1,000,000" read like the context was about to grow. */
    return { text: 'Context compression started', detail: `${before.toLocaleString()} tokens` };
  }
  /* The card opened by 'started' only closes on a terminal message. This path never sent one, so
   * the CLI card stayed at "准备中…" for the rest of the turn and kept redrawing. */
  if (evt.status === 'completed') {
    return { text: '✓ 压缩完成', detail: `${k(before)}K → ${k(after)}K tokens (释放 ${k(Math.max(0, before - after))}K)` };
  }
  if (evt.status === 'skipped') {
    /* The runner only starts a compaction when there is history worth summarizing, so a start
     * without a result means the summary request failed. */
    return { text: '✗ 压缩失败', detail: `上下文保持原样 (${k(before)}K tokens)，本轮照常继续，稍后会再试` };
  }
  return null;
}
