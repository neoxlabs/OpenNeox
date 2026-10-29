/**
 * Large-file IPC handlers.
 *
 * Channel 清单:
 *   large-file:open   (path)                  → { handle, meta } | { error }
 *   large-file:read   (handle, from, to)      → { lines } | { error }
 *   large-file:close  (handle)                → { ok }
 *
 * ownerKey = webContents.id:frameRoutingId, webContents 销毁时主动清理.
 */

import { ipcMain } from './ipcMainBridged.js';
/* 类型是纯类型导入, 编译后完全擦除 —— 不会在运行时把 electron 拉进来。
 * 值 (ipcMain) 走桥的替身, 于是这个文件在纯 Node 后端里也 import 得动。 */
import type { IpcMainInvokeEvent } from 'electron';
import { getLargeFileRegistry } from '../services/largeFile/largeFileRegistry.js';
import { SUPPORTED_ENCODINGS, type LargeFileEncoding } from '../services/largeFile/fileAdapter.js';
import { searchLargeFile } from '../services/largeFile/largeFileSearch.js';

function ownerOf(event: IpcMainInvokeEvent): string {
  return `${event?.sender.id}:${event.senderFrame?.routingId ?? 0}`;
}

export function registerLargeFileIpcHandlers(): void {
  const registry = getLargeFileRegistry();
  const attached = new WeakSet<Electron.WebContents>();

  ipcMain.handle('large-file:open', async (event, path: string) => {
    if (typeof path !== 'string' || !path) return { error: 'invalid path' };

    const wc = event?.sender;
    if (!attached.has(wc)) {
      attached.add(wc);
      wc.once('destroyed', () => {
        registry.closeByOwnerPrefix(`${wc.id}:`).catch(() => { /* ignore */ });
      });
    }

    try {
      const owner = ownerOf(event);
      const result = await registry.open(path, owner);
      return { handle: result.handle, meta: result.meta };
    } catch (err: any) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle(
    'large-file:read',
    async (_event, handle: string, from: number, to: number) => {
      if (typeof handle !== 'string') return { error: 'invalid handle' };
      const lines = await registry.readLines(handle, Number(from) | 0, Number(to) | 0);
      if (lines === null) return { error: 'closed or read failed' };
      return { lines };
    },
  );

  ipcMain.handle('large-file:close', async (_event, handle: string) => {
    if (typeof handle !== 'string') return { ok: false };
    const ok = await registry.close(handle);
    return { ok };
  });

  ipcMain.handle('large-file:set-encoding', async (_event, handle: string, encoding: string) => {
    if (typeof handle !== 'string') return { error: 'invalid handle' };
    if (!SUPPORTED_ENCODINGS.includes(encoding as LargeFileEncoding)) {
      return { error: `unsupported encoding: ${encoding}` };
    }
    const meta = await registry.setEncoding(handle, encoding as LargeFileEncoding);
    if (!meta) return { error: 'handle not found' };
    return { meta };
  });

  ipcMain.handle('large-file:supported-encodings', async () => {
    return { encodings: [...SUPPORTED_ENCODINGS] };
  });

  ipcMain.handle(
    'large-file:search',
    async (
      _event,
      handle: string,
      query: string,
      opts: { caseSensitive?: boolean; useRegex?: boolean; maxResults?: number } = {},
    ) => {
      const meta = registry.metaOf(handle);
      if (!meta) return { error: 'handle not found' };
      if (typeof query !== 'string' || query.length === 0) return { matches: [] };
      try {
        const matches = await searchLargeFile(meta.path, query, opts);
        return { matches };
      } catch (err: any) {
        return { error: err?.message ?? String(err) };
      }
    },
  );
}
