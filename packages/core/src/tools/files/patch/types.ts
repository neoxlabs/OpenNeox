/**
 * Neox Native Patch Engine — Type Definitions
 *
 * Normalized intermediate representation for patches.
 * Both Codex and unified-diff formats are parsed into this IR
 * before being applied by the fuzzy applicator.
 */

// ============================================================================
// Patch IR (Intermediate Representation)
// ============================================================================

/** File-level operation */
export type FileAction = 'add' | 'update' | 'delete';

/**
 * A single hunk — one contiguous edit region within a file.
 *
 * For Codex format, contextLines come from the @@ anchor line(s).
 * For unified diff, contextLines are the leading space-prefixed lines.
 */
export interface PatchHunk {
  /** Context lines used to locate the edit position (search anchor) */
  contextLines: string[];
  /** Lines to remove (without the leading `-`) */
  removeLines: string[];
  /** Lines to insert (without the leading `+`) */
  addLines: string[];
  /** Original line number hint from unified diff @@ header (optional) */
  originalLineHint?: number;
}

/** Patch operations for a single file */
export interface FilePatch {
  action: FileAction;
  /** File path (relative to workspace root) */
  filePath: string;
  /** Rename target path (optional, Codex *** Move to:) */
  moveTo?: string;
  /** Edit hunks (for action === 'update') */
  hunks: PatchHunk[];
  /** Full content for new files (for action === 'add') */
  newContent?: string;
}

/** Complete parsed patch */
export interface ParsedPatch {
  format: 'codex' | 'unified' | 'simple';
  files: FilePatch[];
}

// ============================================================================
// Apply Results
// ============================================================================

/** Fuzz matching level used */
export enum FuzzLevel {
  /** Exact character-for-character match */
  EXACT = 0,
  /** Trailing whitespace ignored */
  TRIM_END = 1,
  /** Leading + trailing whitespace ignored */
  TRIM = 2,
  /** Unicode normalization (fullwidth → halfwidth, smart quotes, etc.) */
  NORMALIZE = 3,
  /** Offset search ±N lines from expected position */
  OFFSET_SEARCH = 4,
}

/** Result of applying a single hunk */
export interface HunkApplyResult {
  success: boolean;
  /** Line number where the hunk was matched (1-based) */
  matchedLine: number;
  /** Fuzz level used for matching */
  fuzzLevel: FuzzLevel;
  /** Offset from the expected position */
  offset: number;
  /** Error message if failed */
  error?: string;
}

/** Result of applying all patches to a single file */
export interface FileApplyResult {
  filePath: string;
  action: FileAction;
  success: boolean;
  /** Per-hunk results */
  hunkResults: HunkApplyResult[];
  /** Error message if the entire file operation failed */
  error?: string;
  /** New file path if renamed */
  movedTo?: string;
}

/** Result of the entire patch application */
export interface PatchApplyResult {
  success: boolean;
  /** Per-file results */
  fileResults: FileApplyResult[];
  /** Total number of files affected */
  totalFiles: number;
  /** Number of files successfully patched */
  successFiles: number;
  /** Number of files that failed */
  failedFiles: number;
  /** Fallback method used (if any) */
  fallbackUsed?: 'git-apply' | 'edit-file-chain';
  /** Overall error message */
  error?: string;
}
