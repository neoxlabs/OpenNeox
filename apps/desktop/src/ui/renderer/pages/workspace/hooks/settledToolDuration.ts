export function settledToolDuration(
  eventDuration: unknown,
  entry: { timestamp?: number; duration?: number },
  resultAt: number,
): number | undefined {
  if (typeof eventDuration === 'number' && eventDuration >= 0) return eventDuration;
  if (typeof entry.duration === 'number' && entry.duration >= 0) return entry.duration;
  const started = entry.timestamp;
  if (typeof started !== 'number' || started <= 0 || resultAt < started) return undefined;
  return resultAt - started;
}
