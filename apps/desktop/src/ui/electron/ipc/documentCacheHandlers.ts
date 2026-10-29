/**
 * 文档解析结果本地缓存 IPC.
 *
 * 客户端 (renderer) 解析完文档拿到 markdown 后, 写到本地缓存,
 * agent 工具 read_document(fileId) 读这里, 多轮对话不重发文档全文给 LLM.
 *
 * 缓存路径: ~/.neox/documents/<fileId>.md (fileId = sha256(file content), hex)
 * 不做 TTL — 用户磁盘是用户的, 想清自己手清, 我们 best effort 写.
 *
 * 跟 NeoxCloud /document/get/:fileId 互为兜底:
 *   · 本地有 → 不调云, 0 network
 *   · 本地无 → 后续可走云 fallback (现 v2 暂不实现, 留待后续)
 */

import { ipcMain } from './ipcMainBridged.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

const CACHE_DIR = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'documents');

function isValidFileId(fileId: unknown): fileId is string {
  return typeof fileId === 'string' && /^[a-f0-9]{64}$/.test(fileId);
}

function cachePath(fileId: string): string {
  return path.join(CACHE_DIR, `${fileId}.md`);
}

export function registerDocumentCacheIpcHandlers(): void {
  /** 写本地缓存. 客户端 documentParseClient 拿到 NeoxCloud markdown 后调. */
  ipcMain.handle('document-cache:write', async (_event, fileId: unknown, markdown: unknown) => {
    if (!isValidFileId(fileId)) {
      return { success: false, error: 'Invalid fileId (must be sha256 hex)' };
    }
    if (typeof markdown !== 'string') {
      return { success: false, error: 'markdown must be string' };
    }
    try {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      /* 原子写: 先 tmp 再 rename, 防并发同 fileId 写到一半被读半截 */
      const p = cachePath(fileId);
      const tmp = p + '.tmp';
      await fs.writeFile(tmp, markdown, 'utf-8');
      await fs.rename(tmp, p);
      return { success: true, path: p };
    } catch (err: any) {
      return { success: false, error: String(err?.message ?? err) };
    }
  });

  /** 读本地缓存. miss 返 null (不报错, 由调用方决定是否 fallback 云). */
  ipcMain.handle('document-cache:read', async (_event, fileId: unknown) => {
    if (!isValidFileId(fileId)) {
      return { success: false, error: 'Invalid fileId' };
    }
    try {
      const p = cachePath(fileId);
      const data = await fs.readFile(p, 'utf-8');
      return { success: true, markdown: data };
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return { success: true, markdown: null };
      }
      return { success: false, error: String(err?.message ?? err) };
    }
  });

  /** 给 agent 工具 (read_document) 用 — 内部直接 fs 读, 不走 IPC.
   * 这个导出让 neox-core 的 tool 能在 main process 内直接读, 减少一层 IPC. */
}

/** 给 agent 工具 (read_document) 在 main process 内直接读 (不走 IPC). */
export async function readDocumentCacheSync(fileId: string): Promise<string | null> {
  if (!isValidFileId(fileId)) return null;
  try {
    return await fs.readFile(cachePath(fileId), 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}
