
export type StructuredToolResult = {
  type?: string;
  tool?: string;
  status?: string;
  summary?: string;
  content?: string;
  file_path?: string;
  verify_hint?: string;
  error?: string;
};

export const STRUCTURED_TOOL_RESULT_TYPES = new Set(['ephemeral', 'contextual', 'summarized']);

/**
 * Structured results are often truncated before they reach the UI (a browser_run failure carries
 * a base64 screenshot), so they no longer parse. Falling through then printed the raw JSON — image
 * payload included — as a timeline line. Recover the fields the card needs from the prefix instead.
 */
export function salvageTruncatedStructuredResult(trimmed: string): StructuredToolResult | null {
  const field = (name: string): string | undefined => {
    const m = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(trimmed);
    if (!m) return undefined;
    try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
  };
  const type = field('type');
  if (!type || !STRUCTURED_TOOL_RESULT_TYPES.has(type)) return null;
  return {
    type,
    status: field('status'),
    tool: field('tool'),
    summary: field('summary'),
    error: field('error'),
  } as StructuredToolResult;
}
