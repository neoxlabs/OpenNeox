/**
 * turnWriteDeclarations — 从 timeline entries 抽出 WriteDeclaration（耐持久化）.
 *
 * 运行时 WriteLedger / agent_wrote_path 是热路径;
 * 聚合「本轮改动」时以本函数从 turn entries 回放声明为准（重启会话仍正确）,
 * 并可与 live ledger / shell_proc 注入的 entry.declaredPaths 合并.
 */

import {
  extractWriteDeclarationsFromToolComplete,
  type WriteDeclaration,
} from '@neoxlabs/kernel/core/writeLedger.js';
import type { TimelineEntry } from '../../utils/workspaceUtils';
import { isPseudoEllipsisPath, resolveWorkspacePath } from '../../utils/pathUtils';

function canonicalPath(rawPath: string, workspacePath?: string): string {
  if (!rawPath) return rawPath;
  if (isPseudoEllipsisPath(rawPath)) return rawPath.replace(/^\.\.\.\//, '…/');
  return resolveWorkspacePath(rawPath, workspacePath);
}

function canonicalizeDecl(d: WriteDeclaration, workspacePath?: string): WriteDeclaration {
  return {
    ...d,
    paths: d.paths.map((p) => canonicalPath(p, workspacePath)),
    from: d.from ? canonicalPath(d.from, workspacePath) : undefined,
  };
}

function isShellName(name: string | undefined): boolean {
  const n = String(name || '').toLowerCase();
  return n === 'execute_shell' || n === 'execute_bash' || n === 'shell' || n === 'bash';
}

/**
 * 从一轮 timeline entries 抽出全部 WriteDeclaration.
 * sessionId 用于填声明字段; 可为 ''（仅本地折叠时）.
 */
export function extractWriteDeclarationsFromTimelineEntries(
  entries: TimelineEntry[],
  sessionId: string,
  workspacePath?: string,
): WriteDeclaration[] {
  const out: WriteDeclaration[] = [];

  for (const e of entries) {
    const ts = e.timestamp ?? Date.now();
    const toolCallId = String(
      (e as any).toolCallId
      || (Array.isArray((e as any).toolCallIdSet) && (e as any).toolCallIdSet[0])
      || e.id
      || `entry_${ts}`,
    );

    /* edit_file 卡片 */
    if (e.type === 'edit_file' && e.editFilePath && e.success !== false && e.level !== 'error') {
      out.push(canonicalizeDecl({
        sessionId,
        toolCallId,
        toolName: 'edit_file',
        op: 'edit',
        paths: [e.editFilePath],
        ts,
        evidence: 'tool_result_path',
      }, workspacePath));
      continue;
    }

    /* file_stream / write 卡片 */
    if (e.type === 'file_stream' && e.success !== false) {
      const raw = (e as any).filePath || e.targetPath || e.editFilePath;
      if (typeof raw === 'string' && raw) {
        out.push(canonicalizeDecl({
          sessionId,
          toolCallId,
          toolName: 'write_file',
          op: 'write',
          paths: [raw],
          ts,
          evidence: 'tool_result_path',
        }, workspacePath));
      }
      continue;
    }

    /* tool_call / tool_result — 通用抽取 + shell declaredPaths */
    if (e.type === 'tool_result' || e.type === 'tool_call') {
      if (e.success === false || e.level === 'error') continue;
      const toolName = String(e.toolName || '');
      const args = (e.toolArgs || {}) as Record<string, unknown>;

      /* entry 上挂的 shell_proc / 显式声明（桌面回收后写入） */
      const entryDeclared = (e as any).declaredPaths;
      if (Array.isArray(entryDeclared) && entryDeclared.length > 0 && isShellName(toolName)) {
        const paths = entryDeclared.filter((p: unknown): p is string => typeof p === 'string' && !!p);
        if (paths.length > 0) {
          out.push(canonicalizeDecl({
            sessionId,
            toolCallId,
            toolName: toolName || 'execute_shell',
            op: 'write',
            paths,
            ts,
            evidence: (e as any).declaredEvidence === 'shell_proc' ? 'shell_proc' : 'shell_declared',
          }, workspacePath));
        }
      }

      const fromComplete = extractWriteDeclarationsFromToolComplete({
        sessionId,
        toolCallId,
        toolName,
        success: true,
        args,
        output: (e as any).toolResult ?? (e as any).detail ?? (e as any).output,
        uiMeta: {
          file_path: typeof e.targetPath === 'string' ? e.targetPath : undefined,
          status: 'success', /* 同上: 失败的已在函数上方 continue 掉 */
          metadata: (e as any).toolMetadata || (args as any).metadata,
        },
        ts,
      }).map((d) => canonicalizeDecl(d, workspacePath));

      out.push(...fromComplete);
    }
  }

  return out;
}
