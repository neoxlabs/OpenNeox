export type ToolOutcomeStatus = 'success' | 'error' | 'already_done';

export function detectToolOutcomeStatus(
  success: boolean,
  output: unknown,
): ToolOutcomeStatus {
  let detectedStatus: ToolOutcomeStatus = success ? 'success' : 'error';

  try {
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    const parsed = JSON.parse(outputStr);
    if (parsed.status === 'already_done') {
      detectedStatus = 'already_done';
    } else if (parsed.status === 'success') {
      detectedStatus = 'success';
    } else if (parsed.status === 'error') {
      detectedStatus = 'error';
    }
  } catch {
    // keep default success/error when output is not parseable json
  }

  return detectedStatus;
}
