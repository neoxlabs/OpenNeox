export function placeBackfilledEntries<T extends { id?: string; timestamp?: number }>(entries: T[]): T[] {
  const isLedger = (e: T) => String(e.id ?? '').startsWith('ledger-');
  if (!entries.some(isLedger)) return entries;
  const backfilled = entries.filter(isLedger).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const out = entries.filter((e) => !isLedger(e));
  for (const b of backfilled) {
    const at = b.timestamp ?? 0;
    const idx = out.findIndex((e) => !isLedger(e) && (e.timestamp ?? 0) > at);
    if (idx < 0) out.push(b);
    else out.splice(idx, 0, b);
  }
  return out;
}
