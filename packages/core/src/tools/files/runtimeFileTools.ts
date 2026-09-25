import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import { createCreateDirectoryTool, createListDirectoryTool } from './directoryTools.js';
import { createEditFileTool } from './editFileTool.js';
import { createDeleteFileTool, createRenameFileTool } from './fileMutationTools.js';
import { createSearchFilesTool } from './searchFilesTool.js';
import { createWriteFileTool } from './writeFileTool.js';

interface CreateRuntimeFileToolsDeps {
  formatDisplayPath: (absPath: string) => string;
  getWorkspaceRoot: () => string;  resolveWorkspacePath: (requestedPath?: string) => string;
}

export function createRuntimeFileTools(deps: CreateRuntimeFileToolsDeps): {
  createDirectory: Tool;
  deleteFile: Tool;
  edit: Tool;
  editBatch: Tool;
  listDirectory: Tool;
  renameFile: Tool;
  searchFiles: Tool;
  writeFile: Tool;
} {
  const editFileTool = createEditFileTool({
    resolveWorkspacePath: deps.resolveWorkspacePath,
    formatDisplayPath: deps.formatDisplayPath,  });

  const editTool: Tool = {
    name: 'edit',
    /* D wire: edit 是短任务, 60s 足够 (大文件 hunks 计算 + 写盘). 避免 30min default. */
    timeoutMs: 60_000,
    description: `Edit an EXISTING file by replacing exact text (content-addressed find-and-replace). Errors if file doesn't exist — use write_file for new files / full rewrites.

edit(file_path, old_string, new_string): old_string = exact verbatim text to replace (copy it from the file, keep indentation), must uniquely identify ONE spot (add surrounding context, or replace_all=true, if it repeats). Append at EOF: old_string="". Multiple edits in one file: hunks=[{old_string,new_string}]. No \`patch\` field.`,
    parameters: editFileTool.parameters,
    permission: {
      category: ToolCategory.WRITE,
      allowInAskMode: false,
    },
    async function(args: any, context?: { signal?: AbortSignal }) {
      if (typeof args?.patch === 'string' && args.patch.trim().length > 0) {
        const { createEphemeralResult } = await import('@neoxlabs/kernel/core/types/toolResult.js');
        return JSON.stringify(createEphemeralResult('edit', 'error',
          'edit does not accept patch. Use edit(file_path, old_string, new_string) — old_string is the exact text to replace.', {
            error: 'patch_not_supported',
            verify_hint: 'Single-file edits use content-addressed old_string/new_string, not a patch.',
          }));
      }
      return editFileTool.function(args, context);
    },
  };

  const editBatchTool: Tool = {
    name: 'edit_batch',
    description: `Edit MULTIPLE files in a single tool call. Each entry is an edit operation (same shape as the \`edit\` tool: file_path + old_string + new_string, or hunks).

When to use:
- You need to apply N >= 2 edits and can prepare them in one round-trip
- Saves an entire LLM call vs running \`edit\` repeatedly

Constraints (READ BEFORE USING):
- Each entry: file_path + old_string (exact text to replace) + new_string. old_string must uniquely identify one spot per entry.
- Same file in multiple entries is fine as long as each entry's old_string is still present after the earlier ones applied — but prefer ONE entry per file with a multi-hunk \`hunks\` array to avoid a later entry's old_string being consumed by an earlier edit.
- Partial success is the default; successful entries STAY APPLIED, failed entries are reported.
- ⚠️ **\`atomic: true\` does NOT auto-rollback**: it only marks \`rollback_required: true\` in the result metadata. Successful entries before the failure remain on disk; aborted mid-batch, committed entries stay and the rest are skipped. Follow up with reverse edits if a real rollback is needed.

Returns a JSON result with per-entry status. On failure, inspect the entry's error/verify_hint and re-issue a targeted single \`edit\` for just that entry; do NOT resend the entire batch.`,
    parameters: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 32, /* 32 是个工程上限: 单批次太大会让 LLM 难以 trace 哪一条失败 */
          description: 'Array of edit operations. Each entry has the same shape as the `edit` tool args (file_path + old_string + new_string, or hunks).',
          items: {
            type: 'object',
            properties: {
              file_path: { type: 'string' },
              old_string: { type: 'string' },
              new_string: { type: 'string' },
              replace_all: { type: 'boolean' },
              hunks: { type: 'array' },
            },
            required: ['file_path'],
          },
        },
        atomic: {
          type: 'boolean',
          description: 'If true, mark all successful entries with rollback_required when any entry fails. Default false (partial commit).',
          default: false,
        },
      },
      required: ['edits'],
    },
    permission: {
      category: ToolCategory.WRITE,
      allowInAskMode: false,
    },
    async function(args: any, context?: { signal?: AbortSignal }) {
      const { createEphemeralResult } = await import('@neoxlabs/kernel/core/types/toolResult.js');
      const edits = Array.isArray(args?.edits) ? args.edits : [];
      const atomic = !!args?.atomic;
      if (edits.length === 0) {
        return JSON.stringify(createEphemeralResult('edit_batch', 'error',
          'edit_batch requires non-empty edits array', { error: 'edits_required' }));
      }
      const results: any[] = [];
      let successCount = 0;
      let failedCount = 0;
      let firstFailureIdx = -1;

      for (let i = 0; i < edits.length; i++) {
        /* signal abort 中途取消: 已 commit 的留, 后续标记为 skipped (跟 atomic 决策无关). */
        if (context?.signal?.aborted) {
          results.push({ idx: i, status: 'skipped', error: 'aborted' });
          continue;
        }
        const entry = edits[i];
        let raw: string;
        try {
          raw = await editFileTool.function(entry, context);
        } catch (err: any) {
          raw = JSON.stringify(createEphemeralResult('edit', 'error',
            `edit_batch entry ${i} threw: ${err?.message || err}`,
            { error: 'edit_entry_threw' }));
        }
        let parsed: any = null;
        try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
        const ok = parsed?.status === 'success' || parsed?.status === 'already_done';
        if (ok) {
          successCount++;
        } else {
          failedCount++;
          if (firstFailureIdx < 0) firstFailureIdx = i;
        }
        results.push({
          idx: i,
          file_path: entry?.file_path,
          status: parsed?.status ?? 'error',
          message: parsed?.message,
          metadata: parsed?.metadata,
        });
      }

      const summary = {
        total: edits.length,
        success: successCount,
        failed: failedCount,
        atomic,
        firstFailureIdx,
        rollback_required: atomic && failedCount > 0,
        results,
      };
      const status = failedCount === 0 ? 'success' : (successCount > 0 ? 'success' : 'error');
      return JSON.stringify(createEphemeralResult('edit_batch', status,
        failedCount === 0
          ? `edit_batch: ${successCount}/${edits.length} entries applied`
          : `edit_batch: ${successCount} ok, ${failedCount} failed (first at idx ${firstFailureIdx})`,
        {
          metadata: summary,
          ...(atomic && failedCount > 0
            ? { verify_hint: 'atomic=true with failures: re-issue reverse edits to undo successful entries if rollback truly needed; or treat partial success and re-target only failed ones.' }
            : failedCount > 0
              ? { verify_hint: `Inspect results[].metadata for each failed entry; re-issue a targeted edit for just those.` }
              : {}),
        }));
    },
  };

  return {
    edit: editTool,
    editBatch: editBatchTool,
    createDirectory: createCreateDirectoryTool({
      resolveWorkspacePath: deps.resolveWorkspacePath,
      formatDisplayPath: deps.formatDisplayPath,
    }),
    deleteFile: createDeleteFileTool({
      resolveWorkspacePath: deps.resolveWorkspacePath,
      formatDisplayPath: deps.formatDisplayPath,
      getWorkspaceRoot: deps.getWorkspaceRoot,    }),
    listDirectory: createListDirectoryTool({
      resolveWorkspacePath: deps.resolveWorkspacePath,
      formatDisplayPath: deps.formatDisplayPath,
    }),
    renameFile: createRenameFileTool({
      resolveWorkspacePath: deps.resolveWorkspacePath,
      formatDisplayPath: deps.formatDisplayPath,
      getWorkspaceRoot: deps.getWorkspaceRoot,    }),
    searchFiles: createSearchFilesTool({
      resolveWorkspacePath: deps.resolveWorkspacePath,
      formatDisplayPath: deps.formatDisplayPath,
    }),
    writeFile: createWriteFileTool({
      resolveWorkspacePath: deps.resolveWorkspacePath,    }),
  };
}
