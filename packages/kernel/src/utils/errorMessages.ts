/**
 * Helpers for converting low-level provider errors into user-friendly messages.
 */

interface ErrorMessageOptions {
  providerName?: string;
  timeoutMs?: number;
}

/**
 * Format LLM errors so the CLI can display actionable hints instead of raw messages.
 */
export function formatLLMErrorMessage(message?: string, options?: ErrorMessageOptions): string {
  const rawMessage = message || 'Unknown error';
  const lower = rawMessage.toLowerCase();
  const providerLabel = options?.providerName?.trim() || 'LLM';

  if (lower.includes('timeout')) {
    // Axios includes the effective timeout, which can differ from provider defaults.
    const match = lower.match(/\btimeout of (\d+(?:\.\d+)?)ms exceeded\b/);
    const timeoutMs = match ? Number(match[1]) : options?.timeoutMs;
    const duration = timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? ` (${timeoutMs / 1000}s)`
      : '';
    return `${providerLabel} 请求超时${duration}。可稍后重试或检查模型超时设置。`;
  }

  return rawMessage;
}
