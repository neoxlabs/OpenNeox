/**
 * Codex Patch Parser
 *
 * Parses the Codex/Claude Code custom patch format into Normalized Patch IR.
 *
 * Format specification:
 *   *** Begin Patch
 *   *** Add File: path/to/new.ts
 *   +line 1
 *   +line 2
 *   *** Update File: path/to/existing.ts
 *   *** Move to: path/to/renamed.ts     (optional rename)
 *   @@ context_line_to_anchor
 *   -line to remove
 *   +line to add
 *    unchanged context line              (space prefix)
 *   @@ another_context_anchor
 *   -old
 *   +new
 *   *** Delete File: path/to/obsolete.ts
 *   *** End Patch
 *
 * Rules:
 * - @@ lines provide context anchors (searched fuzzy in the file)
 * - Lines starting with `-` are removals
 * - Lines starting with `+` are additions
 * - Lines starting with ` ` (space) are context (used for positioning, not modified)
 * - Lines starting with `\` (e.g. "\ No newline at end of file") are metadata, ignored
 */

import type { ParsedPatch, FilePatch, PatchHunk, FileAction } from './types.js';

const BEGIN_PATCH = '*** Begin Patch';
const END_PATCH = '*** End Patch';
const ADD_FILE = '*** Add File:';
const UPDATE_FILE = '*** Update File:';
const DELETE_FILE = '*** Delete File:';
const MOVE_TO = '*** Move to:';

/**
 * Parse a Codex-format patch string into Normalized Patch IR.
 *
 * @throws Error if the patch format is fundamentally malformed
 */
export function parseCodexPatch(input: string): ParsedPatch {
  const rawLines = input.split('\n');

  // Find *** Begin Patch and *** End Patch boundaries
  let beginIdx = -1;
  let endIdx = -1;
  for (let i = 0; i < rawLines.length; i++) {
    const trimmed = rawLines[i].trim();
    if (trimmed === BEGIN_PATCH && beginIdx === -1) {
      beginIdx = i;
    }
    if (trimmed === END_PATCH) {
      endIdx = i;
    }
  }

  // If no explicit boundaries, treat entire input as patch body
  const bodyStart = beginIdx >= 0 ? beginIdx + 1 : 0;
  const bodyEnd = endIdx >= 0 ? endIdx : rawLines.length;
  const bodyLines = rawLines.slice(bodyStart, bodyEnd);

  const files: FilePatch[] = [];
  let currentFile: Partial<FilePatch> | null = null;
  let currentHunks: PatchHunk[] = [];
  let currentHunk: Partial<PatchHunk> | null = null;
  let addFileLines: string[] = [];

  function finalizeHunk(): void {
    if (!currentHunk) return;
    currentHunks.push({
      contextLines: currentHunk.contextLines || [],
      removeLines: currentHunk.removeLines || [],
      addLines: currentHunk.addLines || [],
      originalLineHint: currentHunk.originalLineHint,
    });
    currentHunk = null;
  }

  function finalizeFile(): void {
    if (!currentFile) return;
    finalizeHunk();

    if (currentFile.action === 'add') {
      currentFile.newContent = addFileLines.join('\n');
      addFileLines = [];
    }

    if (currentFile.action === 'update') {
      currentFile.hunks = currentHunks;
    }

    files.push({
      action: currentFile.action!,
      filePath: currentFile.filePath!,
      moveTo: currentFile.moveTo,
      hunks: currentFile.hunks || [],
      newContent: currentFile.newContent,
    });

    currentFile = null;
    currentHunks = [];
    currentHunk = null;
  }

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    const trimmedLine = line.trim();

    // Skip empty lines at top level (between file sections)
    if (!currentFile && trimmedLine === '') continue;

    // File section headers
    if (trimmedLine.startsWith(ADD_FILE)) {
      finalizeFile();
      const filePath = trimmedLine.slice(ADD_FILE.length).trim();
      currentFile = { action: 'add', filePath };
      addFileLines = [];
      continue;
    }

    if (trimmedLine.startsWith(UPDATE_FILE)) {
      finalizeFile();
      const filePath = trimmedLine.slice(UPDATE_FILE.length).trim();
      currentFile = { action: 'update', filePath };
      currentHunks = [];
      continue;
    }

    if (trimmedLine.startsWith(DELETE_FILE)) {
      finalizeFile();
      const filePath = trimmedLine.slice(DELETE_FILE.length).trim();
      files.push({
        action: 'delete',
        filePath,
        hunks: [],
      });
      currentFile = null;
      continue;
    }

    // Move-to directive (within Update File)
    if (trimmedLine.startsWith(MOVE_TO) && currentFile?.action === 'update') {
      currentFile.moveTo = trimmedLine.slice(MOVE_TO.length).trim();
      continue;
    }

    // Skip end-patch marker (handled by boundary detection)
    if (trimmedLine === END_PATCH || trimmedLine === BEGIN_PATCH) continue;

    // Inside an Add File section — collect lines
    if (currentFile?.action === 'add') {
      if (line.startsWith('+')) {
        addFileLines.push(line.slice(1));
      } else if (trimmedLine.startsWith('+')) {
        // Allow some leading whitespace before the +
        addFileLines.push(trimmedLine.slice(1));
      } else if (trimmedLine === '') {
        // Empty line in new file
        addFileLines.push('');
      }
      continue;
    }

    // Inside an Update File section — parse hunks
    if (currentFile?.action === 'update') {
      // @@ anchor line — starts a new hunk
      if (line.startsWith('@@') || trimmedLine.startsWith('@@')) {
        finalizeHunk();
        const anchorText = trimmedLine.startsWith('@@')
          ? trimmedLine.slice(2).trim()
          : line.slice(line.indexOf('@@') + 2).trim();

        // Check if it looks like a unified diff @@ header (has line numbers)
        const unifiedMatch = anchorText.match(/^-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@\s*(.*)/);
        if (unifiedMatch) {
          // Unified-style @@ -N,N +N,N @@ optional_context
          const context = unifiedMatch[1].trim();
          currentHunk = {
            contextLines: context ? [context] : [],
            removeLines: [],
            addLines: [],
          };
        } else {
          // Codex-style @@ context_text
          currentHunk = {
            contextLines: anchorText ? [anchorText] : [],
            removeLines: [],
            addLines: [],
          };
        }
        continue;
      }

      // Diff lines within a hunk
      if (currentHunk) {
        if (line.startsWith('-')) {
          currentHunk.removeLines = currentHunk.removeLines || [];
          currentHunk.removeLines.push(line.slice(1));
        } else if (line.startsWith('+')) {
          currentHunk.addLines = currentHunk.addLines || [];
          currentHunk.addLines.push(line.slice(1));
        } else if (line.startsWith(' ')) {
          // Context line (space-prefixed) — part of the anchor context
          currentHunk.contextLines = currentHunk.contextLines || [];
          currentHunk.contextLines.push(line.slice(1));
        } else if (line.startsWith('\\')) {
          // Metadata line like "\ No newline at end of file" — skip
          continue;
        } else if (trimmedLine === '') {
          // Empty line within hunk — treat as context
          currentHunk.contextLines = currentHunk.contextLines || [];
          currentHunk.contextLines.push('');
        }
      } else {
        // Lines before the first @@ in an Update File
        // Could be context for the whole file, or just noise
        // Start a new hunk with this as context
        if (line.startsWith('-') || line.startsWith('+')) {
          currentHunk = {
            contextLines: [],
            removeLines: [],
            addLines: [],
          };
          if (line.startsWith('-')) {
            currentHunk.removeLines = [line.slice(1)];
          } else {
            currentHunk.addLines = [line.slice(1)];
          }
        }
      }
      continue;
    }
  }

  // Finalize the last file section
  finalizeFile();

  return {
    format: 'codex',
    files,
  };
}
