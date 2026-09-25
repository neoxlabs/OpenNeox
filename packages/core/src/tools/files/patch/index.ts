/**
 * Neox Native Patch Engine — Public API
 *
 * Re-exports all patch engine components.
 */

export type {
  FileAction,
  PatchHunk,
  FilePatch,
  ParsedPatch,
  HunkApplyResult,
  FileApplyResult,
  PatchApplyResult,
} from './types.js';

export { FuzzLevel } from './types.js';

export { detectPatchFormat } from './formatDetector.js';
export type { PatchFormat } from './formatDetector.js';

export { parseCodexPatch } from './codexPatchParser.js';
export { parseUnifiedDiff } from './unifiedDiffParser.js';

export { applyHunksToContent } from './fuzzyApplicator.js';

export { validatePatch } from './validator.js';
export type { ValidationError, ValidationResult } from './validator.js';
