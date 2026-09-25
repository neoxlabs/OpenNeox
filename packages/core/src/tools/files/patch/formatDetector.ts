/**
 * Format Detector — Automatically detect patch format
 *
 * Supports:
 * 1. Codex format (*** Begin Patch / *** Add File / *** Update File / *** Delete File)
 * 2. Standard unified diff (--- a/ +++ b/ @@ -N,N +N,N @@)
 * 3. Unknown (will try both parsers)
 */

export type PatchFormat = 'codex' | 'unified' | 'unknown';

// Codex format markers
const CODEX_MARKERS = [
  '*** Begin Patch',
  '*** Add File:',
  '*** Update File:',
  '*** Delete File:',
  '*** End Patch',
];

// Unified diff patterns
const UNIFIED_FILE_HEADER = /^---\s+\S/m;
const UNIFIED_FILE_HEADER_B = /^\+\+\+\s+\S/m;
const UNIFIED_HUNK_HEADER = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/m;

/**
 * Detect the format of a patch string.
 *
 * Uses a scoring heuristic: whichever format has more markers wins.
 * This handles edge cases where a patch might contain text that
 * coincidentally matches the other format.
 */
export function detectPatchFormat(input: string): PatchFormat {
  if (!input || typeof input !== 'string') {
    return 'unknown';
  }

  const trimmed = input.trim();
  if (!trimmed) return 'unknown';

  // Score each format
  let codexScore = 0;
  let unifiedScore = 0;

  // Check Codex markers
  for (const marker of CODEX_MARKERS) {
    if (trimmed.includes(marker)) {
      codexScore += 2;
    }
  }

  // *** Begin Patch is very strong signal
  if (trimmed.startsWith('*** Begin Patch') ||
      trimmed.includes('\n*** Begin Patch')) {
    codexScore += 5;
  }

  // Check unified diff markers
  if (UNIFIED_FILE_HEADER.test(trimmed)) unifiedScore += 2;
  if (UNIFIED_FILE_HEADER_B.test(trimmed)) unifiedScore += 2;
  if (UNIFIED_HUNK_HEADER.test(trimmed)) unifiedScore += 3;

  // diff --git header is very strong signal
  if (/^diff --git\s/m.test(trimmed)) {
    unifiedScore += 5;
  }

  if (codexScore > 0 && codexScore >= unifiedScore) return 'codex';
  if (unifiedScore > 0) return 'unified';

  return 'unknown';
}
