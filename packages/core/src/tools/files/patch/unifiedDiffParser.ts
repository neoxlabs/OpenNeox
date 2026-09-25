/**
 * Unified Diff Parser
 *
 * Parses standard unified diff format into Normalized Patch IR.
 *
 * Format:
 *   diff --git a/path b/path   (optional git header)
 *   --- a/path
 *   +++ b/path
 *   @@ -oldStart,oldCount +newStart,newCount @@ optional context
 *    context line               (space prefix)
 *   -removed line
 *   +added line
 *
 * Also handles:
 *   - /dev/null paths (new/deleted files)
 *   - rename detection via diff --git header
 *   - Multiple files in a single diff
 */

import type { ParsedPatch, FilePatch, PatchHunk, FileAction } from './types.js';

const DIFF_GIT_RE = /^diff --git\s+a\/(.+?)\s+b\/(.+?)$/;
const FILE_OLD_RE = /^---\s+(.+)$/;
const FILE_NEW_RE = /^\+\+\+\s+(.+)$/;
const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@\s*(.*)/;

function stripPrefix(path: string): string {
  return path
    .replace(/^a\//, '')
    .replace(/^b\//, '')
    .trim();
}

function isDevNull(path: string): boolean {
  const p = path.trim();
  return p === '/dev/null' || p.toLowerCase() === 'nul';
}

/**
 * Parse a unified diff string into Normalized Patch IR.
 */
export function parseUnifiedDiff(input: string): ParsedPatch {
  const lines = input.split('\n');
  const files: FilePatch[] = [];

  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines and noise
    if (!line || line.trim() === '') {
      i++;
      continue;
    }

    // Check for diff --git header (optional)
    let gitOldPath: string | undefined;
    let gitNewPath: string | undefined;
    const gitMatch = line.match(DIFF_GIT_RE);
    if (gitMatch) {
      gitOldPath = gitMatch[1];
      gitNewPath = gitMatch[2];
      i++;

      // Skip index, mode, similarity lines
      while (i < lines.length) {
        const skipLine = lines[i];
        if (
          skipLine.startsWith('index ') ||
          skipLine.startsWith('old mode ') ||
          skipLine.startsWith('new mode ') ||
          skipLine.startsWith('new file mode ') ||
          skipLine.startsWith('deleted file mode ') ||
          skipLine.startsWith('similarity index ') ||
          skipLine.startsWith('rename from ') ||
          skipLine.startsWith('rename to ') ||
          skipLine.startsWith('copy from ') ||
          skipLine.startsWith('copy to ') ||
          skipLine.startsWith('Binary files ')
        ) {
          i++;
        } else {
          break;
        }
      }

      if (i >= lines.length) break;
    }

    // Look for --- header
    const oldMatch = lines[i]?.match(FILE_OLD_RE);
    if (!oldMatch) {
      // If we had a git header but no --- follows, check for deletions
      if (gitMatch && gitOldPath) {
        // Binary file or pure rename without diff content
        i++;
        continue;
      }
      i++;
      continue;
    }
    const oldPath = oldMatch[1].trim();
    i++;

    // Look for +++ header
    if (i >= lines.length) break;
    const newMatch = lines[i]?.match(FILE_NEW_RE);
    if (!newMatch) {
      continue;
    }
    const newPath = newMatch[1].trim();
    i++;

    // Determine file action
    const oldIsNull = isDevNull(oldPath);
    const newIsNull = isDevNull(newPath);

    let action: FileAction;
    let filePath: string;
    let moveTo: string | undefined;

    if (oldIsNull && !newIsNull) {
      action = 'add';
      filePath = stripPrefix(newPath);
    } else if (!oldIsNull && newIsNull) {
      action = 'delete';
      filePath = stripPrefix(oldPath);
    } else {
      action = 'update';
      filePath = stripPrefix(oldPath);
      const strippedNew = stripPrefix(newPath);
      if (strippedNew !== filePath) {
        moveTo = strippedNew;
      }
    }

    // Use git header paths as fallback
    if (!filePath && gitOldPath) filePath = gitOldPath;
    if (!moveTo && gitOldPath && gitNewPath && gitOldPath !== gitNewPath) {
      moveTo = gitNewPath;
    }

    // Parse hunks
    const hunks: PatchHunk[] = [];
    const addFileLines: string[] = [];

    while (i < lines.length) {
      const hunkLine = lines[i];

      // Stop at next file boundary
      if (hunkLine.startsWith('diff --git ') ||
          (hunkLine.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ '))) {
        break;
      }

      // Parse hunk header
      const hunkMatch = hunkLine.match(HUNK_HEADER_RE);
      if (!hunkMatch) {
        i++;
        continue;
      }

      const oldStart = parseInt(hunkMatch[1], 10);
      const hunkContext = hunkMatch[5]?.trim() || '';
      i++;

      const contextLines: string[] = [];
      const removeLines: string[] = [];
      const insertLines: string[] = [];

      if (hunkContext) {
        contextLines.push(hunkContext);
      }

      // Parse hunk body
      while (i < lines.length) {
        const bodyLine = lines[i];

        // Stop conditions
        if (bodyLine.startsWith('diff --git ') ||
            bodyLine.match(HUNK_HEADER_RE) ||
            (bodyLine.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]?.startsWith('+++ '))) {
          break;
        }

        if (bodyLine.startsWith('-')) {
          removeLines.push(bodyLine.slice(1));
        } else if (bodyLine.startsWith('+')) {
          insertLines.push(bodyLine.slice(1));
          if (action === 'add') {
            addFileLines.push(bodyLine.slice(1));
          }
        } else if (bodyLine.startsWith(' ')) {
          contextLines.push(bodyLine.slice(1));
        } else if (bodyLine.startsWith('\\')) {
          // "\ No newline at end of file" — metadata, skip
        } else if (bodyLine.trim() === '') {
          // Treat empty line within hunk as context
          contextLines.push('');
        } else {
          // Unknown line — might be end of hunk
          break;
        }

        i++;
      }

      hunks.push({
        contextLines,
        removeLines,
        addLines: insertLines,
        originalLineHint: oldStart,
      });
    }

    const filePatch: FilePatch = {
      action,
      filePath,
      moveTo,
      hunks,
    };

    if (action === 'add' && addFileLines.length > 0) {
      filePatch.newContent = addFileLines.join('\n');
    }

    files.push(filePatch);
  }

  return {
    format: 'unified',
    files,
  };
}
