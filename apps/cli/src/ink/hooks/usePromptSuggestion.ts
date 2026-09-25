/**
 * usePromptSuggestion — Speculation Phase 1
 *
 * 本地历史模式匹配，提供 prompt 补全建议。
 * 用户输入 2s 无操作 → 在 HintLine 显示补全建议。
 * 按 Tab 接受建议（ghost text）。
 *
 * 不调用 API，纯本地匹配，零成本。
 */

import { useState, useEffect, useRef, useCallback } from 'react';

// ==================== History Store ====================

const MAX_HISTORY = 200;
const history: string[] = [];

/** Add a prompt to history */
export function addToHistory(prompt: string): void {
  const trimmed = prompt.trim();
  if (!trimmed || trimmed.startsWith('/')) return;
  // Deduplicate
  const idx = history.indexOf(trimmed);
  if (idx >= 0) history.splice(idx, 1);
  history.unshift(trimmed);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
}

/** Get history entries */
export function getHistory(): readonly string[] {
  return history;
}

// ==================== Pattern Matching ====================

/**
 * Find the best matching suggestion from history.
 * Uses prefix matching + frequency-weighted scoring.
 */
function findSuggestion(input: string): string | null {
  if (!input || input.length < 3) return null;

  const lower = input.toLowerCase();

  // Prefix match — most recent first
  for (const entry of history) {
    if (entry.toLowerCase().startsWith(lower) && entry.length > input.length) {
      return entry;
    }
  }

  // Substring match — useful for "fix the bug in..." patterns
  for (const entry of history) {
    const entryLower = entry.toLowerCase();
    if (entryLower.includes(lower) && entry.length > input.length + 10) {
      return entry;
    }
  }

  return null;
}

// ==================== Common Patterns ====================

/** Common prompt patterns for new sessions (cold start) */
const COMMON_PATTERNS: Array<{ prefix: string; suggestion: string }> = [
  { prefix: 'fix ', suggestion: 'fix the bug in ' },
  { prefix: 'add ', suggestion: 'add a new feature for ' },
  { prefix: 'refact', suggestion: 'refactor the ' },
  { prefix: 'explain ', suggestion: 'explain how ' },
  { prefix: 'write test', suggestion: 'write tests for ' },
  { prefix: 'review ', suggestion: 'review the code in ' },
  { prefix: 'implement ', suggestion: 'implement ' },
  { prefix: 'create ', suggestion: 'create a new ' },
  { prefix: 'update ', suggestion: 'update the ' },
  { prefix: 'delete ', suggestion: 'delete the ' },
  { prefix: 'find ', suggestion: 'find all ' },
  { prefix: 'search ', suggestion: 'search for ' },
  { prefix: 'debug ', suggestion: 'debug the issue with ' },
  { prefix: 'optimize ', suggestion: 'optimize the performance of ' },
];

function findPatternSuggestion(input: string): string | null {
  if (!input || input.length < 3) return null;
  const lower = input.toLowerCase();
  for (const p of COMMON_PATTERNS) {
    if (p.prefix.startsWith(lower) && p.suggestion.length > input.length) {
      return p.suggestion;
    }
  }
  return null;
}

// ==================== Hook ====================

export interface PromptSuggestionState {
  /** The ghost text to display (the untyped remainder) */
  ghostText: string;
  /** The full suggested text (input + ghost) */
  fullSuggestion: string;
  /** Accept the suggestion (returns the full text) */
  accept: () => string | null;
  /** Clear the suggestion */
  clear: () => void;
}

export function usePromptSuggestion(
  input: string,
  enabled: boolean = true,
  debounceMs: number = 800,
): PromptSuggestionState {
  const [ghostText, setGhostText] = useState('');
  const [fullSuggestion, setFullSuggestion] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastInputRef = useRef('');

  useEffect(() => {
    if (!enabled || !input || input.startsWith('/')) {
      setGhostText('');
      setFullSuggestion('');
      return;
    }

    // Clear previous timer
    if (timerRef.current) clearTimeout(timerRef.current);

    // Debounce
    timerRef.current = setTimeout(() => {
      if (input !== lastInputRef.current) {
        lastInputRef.current = input;

        // Try history first, then patterns
        const suggestion = findSuggestion(input) || findPatternSuggestion(input);
        if (suggestion && suggestion.length > input.length) {
          // Ghost text is the untyped remainder
          const ghost = suggestion.slice(input.length);
          setGhostText(ghost);
          setFullSuggestion(suggestion);
        } else {
          setGhostText('');
          setFullSuggestion('');
        }
      }
    }, debounceMs);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [input, enabled, debounceMs]);

  const accept = useCallback((): string | null => {
    if (!fullSuggestion) return null;
    const result = fullSuggestion;
    setGhostText('');
    setFullSuggestion('');
    return result;
  }, [fullSuggestion]);

  const clear = useCallback(() => {
    setGhostText('');
    setFullSuggestion('');
  }, []);

  return { ghostText, fullSuggestion, accept, clear };
}
