import type { CompletionProfile } from '../profiles/index.js';

export function isIntermediateFinalizationText(
  text: string,
  profile: CompletionProfile,
): boolean {
  if (!profile.blockIntermediateFinalization) {
    return false;
  }
  if (!text || !text.trim()) {
    return false;
  }

  const patterns = profile.intermediatePatterns ?? [];
  return patterns.some(pattern => {
    try {
      return new RegExp(pattern, 'i').test(text);
    } catch {
      return false;
    }
  });
}

export function hasContinuationIntent(
  text: string,
  totalToolCalls: number,
  profile: CompletionProfile,
  onDetected?: (preview: string, length: number) => void,
): boolean {
  if (!profile.detectContinuationIntent) return false;
  if (totalToolCalls === 0) return false;

  const trimmed = (text || '').trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > 200) return false;
  if (/[?？]/.test(trimmed)) return false;

  onDetected?.(trimmed.slice(0, 200), trimmed.length);
  return true;
}
