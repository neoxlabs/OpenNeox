/**
 * Fuzzy Hunk Applicator — Core of the Native Patch Engine
 *
 * Applies patch hunks to file content with 5-level fuzzy matching.
 * This is designed to handle the imprecision inherent in LLM-generated patches.
 *
 * Fuzz Levels:
 *   L0 — Exact match (character-for-character)
 *   L1 — Trim trailing whitespace (tabs vs spaces at EOL)
 *   L2 — Trim all leading/trailing whitespace
 *   L3 — Unicode normalization (fullwidth→halfwidth, smart quotes, fancy dashes)
 *   L4 — Offset search (search ±50 lines from expected position)
 */

import type { PatchHunk, HunkApplyResult, FileApplyResult } from './types.js';
import { FuzzLevel } from './types.js';
import {
  normalizeMatchLine,
  comparators,
  seekSequenceWith,
  type LineComparator,
} from '../fuzzyMatcher.js';

//  Phase 2: normalizeMatchLine, comparators, seekSequenceWith
// are now imported from the unified fuzzyMatcher.ts module.
// The LineComparator type is also imported.
// Local duplicates removed — single source of truth.

/** Maximum offset for L4 offset search */
const MAX_OFFSET = 50;

/**
 * Build the search pattern for a hunk.
 *
 * For hunks with context lines, the pattern is:
 *   contextLines followed by removeLines
 *
 * This allows us to locate the exact edit position.
 */
function buildSearchPattern(hunk: PatchHunk): string[] {
  // If we have both context and remove lines, combine them
  if (hunk.contextLines.length > 0 && hunk.removeLines.length > 0) {
    return [...hunk.contextLines, ...hunk.removeLines];
  }
  // If we only have context lines (pure insertion), use those
  if (hunk.contextLines.length > 0) {
    return hunk.contextLines;
  }
  // If we only have remove lines, use those
  if (hunk.removeLines.length > 0) {
    return hunk.removeLines;
  }
  return [];
}

// ============================================================================
// Hunk Application
// ============================================================================

interface HunkMatch {
  /** Index in fileLines where the full pattern starts */
  patternStart: number;
  /** Index in fileLines where the remove/add region starts */
  editStart: number;
  /** Number of lines to remove */
  removeCount: number;
  /** Fuzz level used */
  fuzzLevel: FuzzLevel;
}

/**
 * Try to locate a hunk in the file content using multi-level fuzz matching.
 *
 * @param fileLines - Lines of the file
 * @param hunk - The hunk to locate
 * @param preferredStart - Preferred start position (from previous hunks)
 * @returns Match result or null
 */
function locateHunk(
  fileLines: string[],
  hunk: PatchHunk,
  preferredStart: number = 0,
): HunkMatch | null {
  const searchPattern = buildSearchPattern(hunk);
  if (searchPattern.length === 0) {
    // No search pattern — apply at preferredStart (pure insertion with no context)
    return {
      patternStart: preferredStart,
      editStart: preferredStart,
      removeCount: 0,
      fuzzLevel: FuzzLevel.EXACT,
    };
  }

  // If we have an originalLineHint, try around that first
  const hintStart = hunk.originalLineHint
    ? Math.max(0, hunk.originalLineHint - 1) // Convert 1-based to 0-based
    : undefined;

  // Try L0 through L3 (in order of strictness)
  for (const level of [FuzzLevel.EXACT, FuzzLevel.TRIM_END, FuzzLevel.TRIM, FuzzLevel.NORMALIZE]) {
    const cmp = comparators[level];

    // If we have a hint, try near the hint first
    if (hintStart !== undefined) {
      const nearHintStart = Math.max(0, hintStart - 3);
      const nearHintEnd = Math.min(fileLines.length, hintStart + searchPattern.length + 3);
      const found = seekSequenceWith(fileLines, searchPattern, cmp, nearHintStart, nearHintEnd);
      if (found !== null) {
        return buildMatchResult(found, hunk, level);
      }
    }

    // Full search from preferredStart
    const found = seekSequenceWith(fileLines, searchPattern, cmp, preferredStart);
    if (found !== null) {
      return buildMatchResult(found, hunk, level);
    }

    // If preferredStart > 0, also search from beginning
    if (preferredStart > 0) {
      const foundFromTop = seekSequenceWith(fileLines, searchPattern, cmp, 0, preferredStart);
      if (foundFromTop !== null) {
        return buildMatchResult(foundFromTop, hunk, level);
      }
    }
  }

  // L4: Offset search — try matching just the removeLines with trim comparison
  // in a wider window around the expected position
  if (hunk.removeLines.length > 0) {
    const cmp = comparators[FuzzLevel.OFFSET_SEARCH];
    const center = hintStart ?? preferredStart;
    const windowStart = Math.max(0, center - MAX_OFFSET);
    const windowEnd = Math.min(fileLines.length, center + MAX_OFFSET + hunk.removeLines.length);

    // Try matching just the remove lines (without context)
    const found = seekSequenceWith(fileLines, hunk.removeLines, cmp, windowStart, windowEnd);
    if (found !== null) {
      return {
        patternStart: found,
        editStart: found,
        removeCount: hunk.removeLines.length,
        fuzzLevel: FuzzLevel.OFFSET_SEARCH,
      };
    }
  }

  // L4 fallback: try matching just context lines (if we have them)
  if (hunk.contextLines.length > 0) {
    const cmp = comparators[FuzzLevel.OFFSET_SEARCH];
    const center = hintStart ?? preferredStart;
    const windowStart = Math.max(0, center - MAX_OFFSET);
    const windowEnd = Math.min(fileLines.length, center + MAX_OFFSET + hunk.contextLines.length);

    const found = seekSequenceWith(fileLines, hunk.contextLines, cmp, windowStart, windowEnd);
    if (found !== null) {
      // Context found — the edit position is right after the context
      return {
        patternStart: found,
        editStart: found + hunk.contextLines.length,
        removeCount: hunk.removeLines.length,
        fuzzLevel: FuzzLevel.OFFSET_SEARCH,
      };
    }
  }

  return null;
}

function buildMatchResult(patternStart: number, hunk: PatchHunk, fuzzLevel: FuzzLevel): HunkMatch {
  const contextLen = hunk.contextLines.length;
  const editStart = patternStart + contextLen;
  const removeCount = hunk.removeLines.length;

  return {
    patternStart,
    editStart,
    removeCount,
    fuzzLevel,
  };
}

// ============================================================================
// File-Level Application
// ============================================================================

interface LocatedHunk {
  hunk: PatchHunk;
  match: HunkMatch;
}

/**
 * Apply all hunks to a file's content.
 *
 * Strategy:
 * 1. Locate all hunks (from top to bottom)
 * 2. Check for overlapping hunks
 * 3. Apply from bottom to top (to preserve line numbers)
 *
 * @param content - Original file content
 * @param hunks - Hunks to apply
 * @returns Updated content and per-hunk results
 */
export function applyHunksToContent(
  content: string,
  hunks: PatchHunk[],
): { newContent: string; results: HunkApplyResult[] } {
  if (hunks.length === 0) {
    return { newContent: content, results: [] };
  }

  const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
  const hasTrailingNewline = content.endsWith(lineEnding);

  let fileLines = content.split(/\r?\n/);
  if (hasTrailingNewline && fileLines[fileLines.length - 1] === '') {
    fileLines.pop();
  }

  const results: HunkApplyResult[] = [];
  const located: LocatedHunk[] = [];

  // Phase 1: Locate all hunks
  let searchCursor = 0;
  for (const hunk of hunks) {
    const match = locateHunk(fileLines, hunk, searchCursor);
    if (!match) {
      results.push({
        success: false,
        matchedLine: -1,
        fuzzLevel: FuzzLevel.EXACT,
        offset: 0,
        error: buildHunkError(hunk, fileLines),
      });
      continue;
    }

    const expectedLine = hunk.originalLineHint ?? searchCursor + 1;
    const offset = (match.patternStart + 1) - expectedLine;

    results.push({
      success: true,
      matchedLine: match.editStart + 1, // 1-based
      fuzzLevel: match.fuzzLevel,
      offset,
    });

    located.push({ hunk, match });
    searchCursor = match.editStart + match.removeCount;
  }

  // If any hunk failed, return early (don't apply partial patches)
  if (results.some(r => !r.success)) {
    return { newContent: content, results };
  }

  // Phase 2: Check for overlapping hunks
  const sorted = located.slice().sort((a, b) => a.match.editStart - b.match.editStart);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const prevEnd = prev.match.editStart + prev.match.removeCount;
    if (curr.match.editStart < prevEnd) {
      // Overlapping hunks — report error
      return {
        newContent: content,
        results: results.map(r => ({
          ...r,
          success: false,
          error: r.error || 'Overlapping hunks detected — patch cannot be applied safely',
        })),
      };
    }
  }

  // Phase 3: Apply from bottom to top
  for (let i = sorted.length - 1; i >= 0; i--) {
    const { hunk, match } = sorted[i];
    fileLines.splice(match.editStart, match.removeCount, ...hunk.addLines);
  }

  // Reconstruct content
  if (hasTrailingNewline) {
    fileLines.push('');
  }
  const newContent = fileLines.join(lineEnding);

  return { newContent, results };
}

/**
 * Build a helpful error message when a hunk can't be located.
 */
function buildHunkError(hunk: PatchHunk, fileLines: string[]): string {
  const parts: string[] = ['Hunk not found in file.'];

  if (hunk.contextLines.length > 0) {
    const preview = hunk.contextLines.slice(0, 3).map(l => `  "${l}"`).join('\n');
    parts.push(`Context lines searched:\n${preview}`);
  }

  if (hunk.removeLines.length > 0) {
    const preview = hunk.removeLines.slice(0, 3).map(l => `  "${l}"`).join('\n');
    parts.push(`Remove lines searched:\n${preview}`);
  }

  if (hunk.originalLineHint) {
    parts.push(`Expected near line ${hunk.originalLineHint}`);
  }

  parts.push(`File has ${fileLines.length} lines.`);
  parts.push('Tip: use readfile to verify current file content, then retry with accurate context.');

  return parts.join('\n');
}
