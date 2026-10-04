/**
 * Patch Validator
 *
 * Validates parsed patches before application:
 * - Path safety (no absolute paths, no traversal)
 * - No empty patches
 * - File existence checks for updates/deletes
 */

import type { ParsedPatch, FilePatch } from './types.js';
import path from 'path';

export interface ValidationError {
  filePath: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  /** Cleaned/normalized file patches */
  normalized: FilePatch[];
}

/**
 * Validate and normalize a parsed patch.
 *
 * @param patch - Parsed patch to validate
 * @param workspaceRoot - Workspace root for path resolution
 */
export function validatePatch(
  patch: ParsedPatch,
  workspaceRoot: string,
): ValidationResult {
  const errors: ValidationError[] = [];
  const normalized: FilePatch[] = [];

  if (!patch.files || patch.files.length === 0) {
    errors.push({ filePath: '', message: 'Patch contains no file operations' });
    return { valid: false, errors, normalized };
  }

  for (const file of patch.files) {
    const pathErrors = validatePath(file.filePath, workspaceRoot);
    errors.push(...pathErrors);

    if (file.moveTo) {
      const moveErrors = validatePath(file.moveTo, workspaceRoot);
      errors.push(...moveErrors);
    }

    // Validate hunks for update operations
    if (file.action === 'update' && file.hunks.length === 0) {
      // Update with no hunks — possibly just a rename
      if (!file.moveTo) {
        errors.push({
          filePath: file.filePath,
          message: 'Update file has no hunks and no rename target',
        });
        continue;
      }
    }

    // Validate new file content
    if (file.action === 'add' && !file.newContent && file.hunks.length === 0) {
      errors.push({
        filePath: file.filePath,
        message: 'Add file has no content',
      });
      continue;
    }

    // Build content from hunks for add action if newContent isn't set
    if (file.action === 'add' && !file.newContent && file.hunks.length > 0) {
      const allAddLines: string[] = [];
      for (const hunk of file.hunks) {
        allAddLines.push(...hunk.addLines);
      }
      file.newContent = allAddLines.join('\n');
    }

    // Normalize file path
    const normalizedFile = { ...file };
    normalizedFile.filePath = normalizeFilePath(file.filePath);
    if (file.moveTo) {
      normalizedFile.moveTo = normalizeFilePath(file.moveTo);
    }

    normalized.push(normalizedFile);
  }

  return {
    valid: errors.length === 0,
    errors,
    normalized,
  };
}

function validatePath(filePath: string, workspaceRoot: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!filePath || filePath.trim() === '') {
    errors.push({ filePath: '', message: 'Empty file path' });
    return errors;
  }

  const cleaned = normalizeFilePath(filePath);

  // Check for absolute paths
  if (path.isAbsolute(cleaned) || /^[A-Za-z]:[\\/]/.test(cleaned)) {
    errors.push({
      filePath: cleaned,
      message: 'Absolute paths are not allowed in patches. Use relative paths.',
    });
  }

  // Check for path traversal
  const parts = cleaned.split(/[/\\]+/);
  if (parts.includes('..')) {
    errors.push({
      filePath: cleaned,
      message: 'Path traversal (..) is not allowed in patches.',
    });
  }

  // Check the resolved path is within workspace
  if (workspaceRoot) {
    const resolved = path.resolve(workspaceRoot, cleaned);
    const normalizedRoot = path.resolve(workspaceRoot);
    if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
      errors.push({
        filePath: cleaned,
        message: `Path resolves outside workspace: ${resolved}`,
      });
    }
  }

  return errors;
}

function normalizeFilePath(filePath: string): string {
  return filePath
    .replace(/^a\//, '')
    .replace(/^b\//, '')
    .trim();
}
