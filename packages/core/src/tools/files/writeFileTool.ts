import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { runWithFileLimit } from './fileLimiter.js';
import { withFileWriteLock } from './fileWriteLock.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { createEphemeralResult } from '@neoxlabs/kernel/core/types/toolResult.js';
import { invalidateReads, recordRead, hasBeenRead, bumpWorkspaceEpoch } from '../smart-read/readLedger.js';
import { saveFileSnapshot } from './fileSnapshotStore.js';
import { onUserIdChange } from '@neoxlabs/platform/utils/config.js';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

const writeFileHistory = new Map<string, {
  checksum: string;
  timestamp: number;
  success: boolean;
  mode: 'overwrite' | 'append';
}>();

const IDEMPOTENCY_TTL = 5 * 60 * 1000;
const APPEND_AMBIGUITY_MS = Math.max(60_000, Number(process.env.NEOX_WRITE_APPEND_AMBIGUITY_MS) || 10 * 60 * 1000);
const WRITE_HISTORY_MAX = 500;

function pruneWriteFileHistory(now: number): void {
  if (writeFileHistory.size <= WRITE_HISTORY_MAX) return;
  for (const [key, entry] of writeFileHistory) {
    if (now - entry.timestamp > IDEMPOTENCY_TTL) writeFileHistory.delete(key);
  }
  if (writeFileHistory.size <= WRITE_HISTORY_MAX) return;
  const byAge = [...writeFileHistory.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
  for (let i = 0; i < Math.floor(byAge.length / 2); i++) {
    writeFileHistory.delete(byAge[i][0]);
  }
}

/* 用户切换时清掉 idempotency dedup — A 在共享 workspace 下写的 checksum 不该 short-circuit B */
onUserIdChange((next, prev) => {
  void next; void prev;
  writeFileHistory.clear();
});

type CreateWriteFileToolDeps = {
  resolveWorkspacePath: (requestedPath?: string) => string;
};


function wfStage(stage: string, extra?: Record<string, unknown>): void {
  if (process.env.NEOX_DIAG_LOG !== '1') return;
  try {
    nodeFs.appendFileSync(
      nodePath.join(nodeOs.homedir(), NEOX_HOME_DIRNAME, 'logs', 'explore-debug.log'),
      `[${new Date().toISOString()}] [WRITE_FILE_STAGE] ${JSON.stringify({ stage, ...extra })}\n`,
    );
  } catch { /* 诊断不拖累主路径 */ }
}

export function createWriteFileTool({ resolveWorkspacePath }: CreateWriteFileToolDeps): Tool {
  return {
    name: 'write_file',
    /* D wire: write_file 是短任务, 大文件分批写也单次 ≤60s. 避免 30min default. */
    timeoutMs: 120_000,  // 120s 给超大写 (>10K 行 / mounted 网盘) 留余量
    description: `Create new file or overwrite existing. For partial edits use \`edit\` instead.

Large file (>300 lines / >10K chars): split — first call write_file (300 lines), subsequent calls write_file(mode='append', 200-300 lines). EVERY follow-up call in the sequence must pass mode='append' explicitly — an omitted mode defaults to overwrite and is rejected mid-sequence to protect the segments already written. A single write over 1000 lines freezes the UI for ~60s; splitting it lets the user see progress.

mode='overwrite' (默认) 整文件替换 — 已有内容全丢. mode='append' 追加.`,
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file to write',
        },
        content: {
          type: 'string',
          description: 'Content to write to the file',
        },
        mode: {
          type: 'string',
          description: 'Write mode: overwrite or append',
          enum: ['overwrite', 'append'],
        },
      },
      required: ['file_path', 'content'],
    },
    async function({ file_path, content, mode: rawMode }: {
      file_path?: string; content?: unknown; mode?: 'overwrite' | 'append';
    }) {
      /* 缺省与显式分开拿 —— append 歧义窗口的闸门只关心"模型有没有说清楚" */
      const modeExplicit = rawMode === 'overwrite' || rawMode === 'append';
      const mode: 'overwrite' | 'append' = modeExplicit ? rawMode : 'overwrite';
      if (!file_path) {
        return JSON.stringify(createEphemeralResult('write_file', 'error', 'Missing required parameter: file_path', {
          error: 'file_path is required',
          verify_hint: 'Please provide the file_path parameter.',
        }));
      }

      if (content === undefined || content === null) {
        return JSON.stringify(createEphemeralResult('write_file', 'error', 'Missing required parameter: content', {
          error: 'content is required',
          verify_hint: 'Please provide the content parameter with the text to write.',
        }));
      }

      const contentStr = typeof content === 'string' ? content : String(content);
      if (contentStr.trim() === '') {
        return JSON.stringify(createEphemeralResult('write_file', 'error', 'Content is empty - this is likely an error', {
          error: 'Empty content provided',
          verify_hint: 'Please provide non-empty content to write.',
        }));
      }

      const absPath = resolveWorkspacePath(file_path);

      const checksum = createHash('sha256').update(contentStr).digest('hex').substring(0, 16);
      const history = writeFileHistory.get(absPath);
      const now = Date.now();
      pruneWriteFileHistory(now);

      if (!modeExplicit && history?.mode === 'append' && (now - history.timestamp) < APPEND_AMBIGUITY_MS) {
        const secAgo = Math.round((now - history.timestamp) / 1000);
        return JSON.stringify(createEphemeralResult('write_file', 'error', `Rejected: file was appended to ${secAgo}s ago but this call omitted "mode" — the default (overwrite) would destroy the previously written segments`, {
          file_path: absPath,
          error: 'mode omitted during an in-progress append sequence',
          verify_hint: `This file is mid split-write (last write was mode='append'). If this call continues the sequence, resend with mode='append'. If you really intend to rewrite the whole file, resend with an explicit mode='overwrite'.`,
        }));
      }

      if (history && history.checksum === checksum && history.mode === mode && history.success && (now - history.timestamp) < IDEMPOTENCY_TTL) {
        let stillOnDisk = false;
        try {
          const st = await fs.stat(absPath);
          stillOnDisk = st.isFile();
        } catch { stillOnDisk = false; }

        if (stillOnDisk) {
          const lines = contentStr.split('\n').length;
          return JSON.stringify(createEphemeralResult('write_file', 'already_done', `File already written with identical content (${lines} lines, ${contentStr.length} bytes)`, {
            file_path: absPath,
            checksum,
            verify_hint: `Use "readfile ${file_path}" to verify the content if needed.`,
            metadata: { lines, bytes: contentStr.length },
          }));
        }
        writeFileHistory.delete(absPath);
      }

      wfStage('enter', { absPath, mode });
      try {
        let isUpdate = false;
        let previousContent: string | undefined;
        try {
          await fs.access(absPath);
          isUpdate = true;
          /* 覆盖前把原内容读出来 —— overwrite 会让它一个字节都不剩.
           * append 不销毁内容, 不需要快照. */
          if (mode !== 'append') {
            try {
              previousContent = await runWithFileLimit(() => fs.readFile(absPath, 'utf-8'));
            } catch {
              /* 二进制 / 权限 / 编码问题读不出来 —— 不阻断写入, 但下面 snapshot 会缺席,
               * 结果里如实标 unavailable, 不假装有保护. */
            }
          }
        } catch {
          // ignore
        }

        /* 快照必须发生在写入之前 —— 写完再读就只剩新内容了 */
        wfStage('before-snapshot', { isUpdate, hasPrev: previousContent !== undefined });
        const snapshot = (isUpdate && previousContent !== undefined)
          ? await saveFileSnapshot(absPath, previousContent)
          : undefined;
        wfStage('after-snapshot');

        const overwroteUnread = isUpdate && mode !== 'append' && !hasBeenRead(absPath);

        wfStage('before-mkdir');
        await runWithFileLimit(() => fs.mkdir(path.dirname(absPath), { recursive: true }));
        wfStage('before-lock');
        await withFileWriteLock(absPath, async () => {
          wfStage('inside-lock');
          if (mode === 'append') {
            await runWithFileLimit(() => fs.appendFile(absPath, contentStr, 'utf-8'));
          } else {
            await runWithFileLimit(() => fs.writeFile(absPath, contentStr, 'utf-8'));
          }
        });

        wfStage('after-write');
        writeFileHistory.set(absPath, { checksum, timestamp: now, success: true, mode });
        if (mode === 'append') {
          invalidateReads(absPath);
        } else {
          try {
            const st = await fs.stat(absPath);
            recordRead(absPath, {
              rangeKey: 'FULL',
              content: contentStr,
              startLine: 1,
              lineCount: contentStr.split(/\r?\n/).length
                - (contentStr.endsWith('\n') ? 1 : 0),
              mtimeMs: st.mtimeMs,
              sizeBytes: st.size,
              readAtTurn: 0,
            });
          } catch {
            invalidateReads(absPath);
          }
        }
        /* 带上写了什么 → 搜索缓存按内容精确失效, 不再全会话作废 (见 readLedger) */
        bumpWorkspaceEpoch(absPath, contentStr);

        const lines = contentStr.split('\n').length;
        const action = isUpdate ? 'updated' : 'created';
        const previousMeta = isUpdate && mode !== 'append'
          ? (snapshot?.id
              ? { snapshot_id: snapshot.id, lines: snapshot.lines, bytes: snapshot.bytes }
              : { snapshot_id: null, unavailable: snapshot?.skipped ?? 'unreadable' })
          : undefined;
        const unreadWarning = overwroteUnread
          ? ` ⚠️ 本会话没读过这个文件就整体覆盖了它 —— 原有 ${snapshot?.lines ?? '?'} 行内容已被替换`
          : '';
        return JSON.stringify(createEphemeralResult('write_file', 'success', `File ${action}: ${path.basename(absPath)} (${lines} lines, ${contentStr.length} bytes)${unreadWarning}`, {
          file_path: absPath,
          checksum,
          verify_hint: overwroteUnread
            ? `⚠️ 你覆盖了一个本会话未读过的已有文件。如果本意是"改其中一部分"而不是"整体重写",`
              + ` 请用 ${snapshot?.id ? `undo (snapshot ${snapshot.id}) 回滚后` : ''}先 readfile("${file_path}") 看清原内容, 再用 edit 做局部修改。`
              + ` 如果本意就是整体重写, 忽略此提示即可。`
            : `Use "readfile ${file_path}" to verify the content.`,
          metadata: {
            action,
            lines,
            bytes: contentStr.length,
            ...(overwroteUnread ? { overwrote_unread_file: true } : {}),
            ...(previousMeta ? { previous: previousMeta } : {}),
          },
        }));
      } catch (error: any) {
        writeFileHistory.set(absPath, { checksum, timestamp: now, success: false, mode });
        return JSON.stringify(createEphemeralResult('write_file', 'error', `Failed to write file: ${error.message}`, {
          file_path: absPath,
          error: error.message,
          verify_hint: 'Check file permissions and path validity.',
        }));
      }
    },
  };
}
