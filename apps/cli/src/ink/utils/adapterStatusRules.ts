
/** The server reports the user's own interrupt as a status of type 'error' ("Task interrupted: …").
 * Letting it through replaced 'Interrupted', which the status line then showed as "Done in 1m 15s".
 * Only a real error may override an interrupt. */
export function isInterruptEcho(text: string): boolean {
  return /interrupt|abort|cancel|中断|取消/i.test(text);
}

/** A tool without a dedicated card is titled with its summary. The card takes the verb from a
 * "tool_name: …" prefix and otherwise falls back to the generic "Tool", which rendered browser_run
 * as "Tool(localhost · 8/8 步 9487ms)". Name the tool so it reads "Browser run(…)". */
export function titleForUncardedTool(toolName: string, summary: string, isGenericCard: boolean): string {
  return isGenericCard && /^[a-z][a-z0-9_]{2,40}$/.test(toolName) && !summary.startsWith(`${toolName}:`)
    ? `${toolName}: ${summary}`
    : summary;
}
