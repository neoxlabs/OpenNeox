
type DropSample = { at: number; reason: string; type: string; sessionId?: string; detail?: string };

const counts = new Map<string, number>();
const samples: DropSample[] = [];
const MAX_SAMPLES = 80;

export function noteStreamDrop(reason: string, event?: { type?: unknown; sessionId?: unknown } | null, detail?: string): void {
  const type = typeof event?.type === 'string' ? event.type : 'unknown';
  const key = `${reason} · ${type}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  samples.push({
    at: Date.now(),
    reason,
    type,
    sessionId: typeof event?.sessionId === 'string' ? event.sessionId : undefined,
    detail,
  });
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

export function getStreamDropLedger(): { counts: Record<string, number>; recent: DropSample[] } {
  return { counts: Object.fromEntries(counts), recent: samples.slice() };
}

export function resetStreamDropLedger(): void {
  counts.clear();
  samples.length = 0;
}

if (typeof window !== 'undefined') {
  (window as any).__neoxDrops = getStreamDropLedger;
  (window as any).__neoxDropsReset = resetStreamDropLedger;
}
