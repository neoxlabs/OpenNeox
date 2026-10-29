export const MIN_UPLINK_BYTES_PER_SEC = 8 * 1024;

export function headerWaitMs(baseMs: number, payload: unknown): number {
  let bytes = 0;
  try {
    bytes = typeof payload === 'string'
      ? Buffer.byteLength(payload)
      : Buffer.byteLength(JSON.stringify(payload) ?? '');
  } catch {
    return baseMs;
  }
  return baseMs + Math.ceil((bytes / MIN_UPLINK_BYTES_PER_SEC) * 1000);
}
