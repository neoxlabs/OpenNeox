import { stripToolHintHeader } from './toolResultHint';

export type UnwrappedToolOutput = {
  status: 'success' | 'already_done' | 'error';
  summary?: string;
  content?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  tool?: string;
};

export function unwrapContextualOutput(out?: string): UnwrappedToolOutput | undefined {
  if (!out || typeof out !== 'string') return undefined;
  const trimmed = stripToolHintHeader(out.trim());
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (
      parsed
      && typeof parsed === 'object'
      && typeof parsed.tool === 'string'
      && typeof parsed.summary === 'string'
      && typeof parsed.status === 'string'
      && (parsed.type === 'ephemeral' || parsed.type === 'contextual' || parsed.type === 'summarized')
    ) {
      return {
        status: parsed.status,
        summary: parsed.summary,
        content: typeof parsed.content === 'string' ? parsed.content : undefined,
        error: typeof parsed.error === 'string' ? parsed.error : undefined,
        metadata: parsed.metadata && typeof parsed.metadata === 'object' ? parsed.metadata : undefined,
        tool: parsed.tool,
      };
    }
  } catch {
    /* not JSON, fall through */
  }
  return undefined;
}
