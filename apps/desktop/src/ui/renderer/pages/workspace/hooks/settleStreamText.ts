export function settleStreamText(
  streamed: string,
  completionText: string | undefined,
  strip: (t: string | undefined) => string | undefined,
): string;
export function settleStreamText(
  streamed: string | undefined,
  completionText: string | undefined,
  strip: (t: string | undefined) => string | undefined,
): string | undefined;
export function settleStreamText(
  streamed: string | undefined,
  completionText: string | undefined,
  strip: (t: string | undefined) => string | undefined,
): string | undefined {
  const base = (streamed && streamed.length > 0) ? streamed : (completionText ?? streamed);
  const tailLost = !!base && !!completionText
    && completionText.length > base.length
    && completionText.startsWith(base);
  return strip(tailLost ? completionText : base);
}
